import {
  automationDraftsTable,
  automationsTable,
  EAutomationStatus,
  EEventType,
} from "@bellaclaw/database";
import type { TOption } from "@bellaclaw/shared";
import { createLogger } from "@bellaclaw/shared";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { summarizeAutomation } from "../ai/tools/automation-summary";
import { DatabaseConnector, type TDatabaseHandle } from "../database";
import { commandFailed, ESubscriptionMode, EventBus, type TEventContext } from "../events";
import type { TEvent } from "../events/catalog";
import {
  createPausedReport,
  createReport,
  EAutomationRunOutcome,
  executeAutomation,
  previewAutomationDraft,
} from "./runner";
import {
  AUTOMATION_DRAFT_TTL_MS,
  AutomationError,
  DEFAULT_AUTOMATION_OUTPUT_CAP_BYTES,
  MAX_AUTOMATION_OUTPUT_CAP_BYTES,
  MAX_CONSECUTIVE_AUTOMATION_FAILURES,
  type TAutomation,
  type TAutomationDraft,
  type TCreateAutomationDraftInput,
} from "./types";

export * from "./types";

export class AutomationService {
  private static _instance: TOption<AutomationService>;
  private database = DatabaseConnector.instance;
  private logger = createLogger("AUTOMATIONS");

  public static get instance() {
    if (!AutomationService._instance) {
      AutomationService._instance = new AutomationService();
    }

    return AutomationService._instance;
  }

  public setup(): void {
    const bus = EventBus.instance;

    bus.subscribe({
      consumer: "automations",
      type: EEventType.AutomationPreviewRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: (event, ctx) => this.handlePreviewRequested(event, ctx),
    });
    bus.subscribe({
      consumer: "automations",
      type: EEventType.AutomationSaveRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event, ctx) => {
        const { scope, previewId } = event.payload;

        try {
          await ctx.complete(async (tx, emit) => {
            const automation = await this.saveDraft(tx, scope, previewId);
            emit(
              EEventType.AutomationSaved,
              { automation: summarizeAutomation(automation) },
              undefined,
              undefined,
            );
          });
        } catch (error) {
          await this.reject(event.type, error, ctx);
        }
      },
    });
    bus.subscribe({
      consumer: "automations",
      type: EEventType.AutomationStatusSetRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event, ctx) => {
        const { scope, name, status } = event.payload;

        try {
          await ctx.complete(async (tx, emit) => {
            const automation = await this.setStatus(tx, scope, name, status);
            emit(
              EEventType.AutomationStatusChanged,
              { automation: summarizeAutomation(automation) },
              undefined,
              undefined,
            );
          });
        } catch (error) {
          await this.reject(event.type, error, ctx);
        }
      },
    });
    bus.subscribe({
      consumer: "automations",
      type: EEventType.AutomationDeleteRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event, ctx) => {
        const { scope, name } = event.payload;

        try {
          await ctx.complete(async (tx, emit) => {
            const automation = await this.delete(tx, scope, name);
            // cron detaches it from its jobs
            emit(
              EEventType.AutomationDeleted,
              { scope, automationId: automation.id, name: automation.name },
              undefined,
              undefined,
            );
          });
        } catch (error) {
          await this.reject(event.type, error, ctx);
        }
      },
    });
    bus.subscribe({
      consumer: "automations",
      type: EEventType.AutomationRunRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: (event, ctx) => this.handleRunRequested(event, ctx),
    });
  }

  // NOTE: the sandbox runs between the draft insert and the outcome, outside any transaction
  private async handlePreviewRequested(
    event: TEvent<EEventType.AutomationPreviewRequested>,
    ctx: TEventContext,
  ): Promise<void> {
    const { timezone, ...input } = event.payload;
    let draft: TAutomationDraft;

    try {
      draft = await ctx.transact((tx) => this.createDraft(tx, input));
    } catch (error) {
      await this.reject(event.type, error, ctx);
      return;
    }

    const live = await this.get(draft.scope, draft.name);
    const report = await previewAutomationDraft(draft, live?.state, {
      timezone,
      trace: event.trace,
    });

    await ctx.complete(async (tx, emit) => {
      let previewId: TOption<number> = draft.id;

      // Only a successful preview may leave a draft that automation-save can make live.
      if (report.outcome === EAutomationRunOutcome.Failed) {
        await this.deleteDraft(tx, draft.scope, draft.id);
        previewId = undefined;
      }

      emit(
        EEventType.AutomationPreviewed,
        {
          previewId,
          name: draft.name,
          allowedOrigins: draft.allowedOrigins,
          config: draft.config,
          outputCapBytes: draft.outputCapBytes,
          report,
        },
        undefined,
        undefined,
      );
    });
  }

  /**
   * Runs a saved automation and records the result: success stores the returned
   * state and resets failures; failure counts towards the automatic pause.
   */
  private async handleRunRequested(
    event: TEvent<EEventType.AutomationRunRequested>,
    ctx: TEventContext,
  ): Promise<void> {
    const { scope, automationId, mode, timezone } = event.payload;
    const [automation] = await this.getByIds(scope, [automationId]);

    if (automation === undefined) {
      await this.reject(
        event.type,
        new AutomationError("automation-not-found", `Automation ${automationId} not found`),
        ctx,
      );
      return;
    }

    if (automation.status === EAutomationStatus.Paused) {
      await ctx.complete(async (_tx, emit) => {
        emit(
          EEventType.AutomationRunCompleted,
          { report: createPausedReport(automation) },
          undefined,
          undefined,
        );
      });
      return;
    }

    const result = await executeAutomation(automation, automation.state, mode, {
      timezone,
      trace: event.trace,
    });

    try {
      await ctx.complete(async (tx, emit) => {
        let paused = false;

        if (result.ok) {
          await this.recordSuccess(tx, automation.id, result.state);
        } else {
          paused = (await this.recordFailure(tx, automation.id, result.error)).paused;
        }

        emit(
          EEventType.AutomationRunCompleted,
          { report: createReport(automation, result, paused) },
          undefined,
          undefined,
        );
      });
    } catch (error) {
      await this.reject(event.type, error, ctx);
    }
  }

  // an AutomationError is an expected failure; anything else fails the delivery
  private async reject(commandType: EEventType, error: unknown, ctx: TEventContext) {
    if (!(error instanceof AutomationError)) {
      throw error;
    }

    await ctx.complete(async (_tx, emit) => {
      emit(
        EEventType.CommandRejected,
        { ...commandFailed(commandType, error), errorCode: error.code },
        undefined,
        undefined,
      );
    });
  }

  public async createDraft(
    db: TDatabaseHandle,
    input: TCreateAutomationDraftInput,
  ): Promise<TAutomationDraft> {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new AutomationError("invalid-automation", "Automation name must not be empty");
    }

    const allowedOrigins = new Set<string>();
    for (const origin of input.allowedOrigins) {
      if (!URL.canParse(origin)) {
        throw new AutomationError(
          "invalid-automation",
          `Invalid allowed origin '${origin}': must be an http(s) origin`,
        );
      }

      const url = new URL(origin);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new AutomationError(
          "invalid-automation",
          `Invalid allowed origin '${origin}': must be an http(s) origin`,
        );
      }

      allowedOrigins.add(url.origin);
    }

    const outputCapBytes = input.outputCapBytes ?? DEFAULT_AUTOMATION_OUTPUT_CAP_BYTES;
    if (
      !Number.isInteger(outputCapBytes) ||
      outputCapBytes < 1 ||
      outputCapBytes > MAX_AUTOMATION_OUTPUT_CAP_BYTES
    ) {
      throw new AutomationError(
        "invalid-automation",
        `outputCapBytes must be an integer between 1 and ${MAX_AUTOMATION_OUTPUT_CAP_BYTES}`,
      );
    }

    const now = Date.now();

    await db
      .delete(automationDraftsTable)
      .where(lt(automationDraftsTable.createdAt, new Date(now - AUTOMATION_DRAFT_TTL_MS)));

    return db
      .insert(automationDraftsTable)
      .values({
        scope: input.scope,
        name,
        instructions: input.instructions ?? null,
        source: input.source,
        config: input.config,
        allowedOrigins: [...allowedOrigins],
        outputCapBytes,
        createdAt: new Date(now),
      })
      .returning()
      .get();
  }

  public async deleteDraft(db: TDatabaseHandle, scope: string, draftId: number): Promise<void> {
    await db
      .delete(automationDraftsTable)
      .where(and(eq(automationDraftsTable.id, draftId), eq(automationDraftsTable.scope, scope)));
  }

  public async getDraft(scope: string, draftId: number): Promise<TOption<TAutomationDraft>> {
    return this.database.run(async (db) => {
      return db
        .select()
        .from(automationDraftsTable)
        .where(and(eq(automationDraftsTable.id, draftId), eq(automationDraftsTable.scope, scope)))
        .get();
    });
  }

  public async saveDraft(
    tx: TDatabaseHandle,
    scope: string,
    draftId: number,
  ): Promise<TAutomation> {
    const draft = await tx
      .select()
      .from(automationDraftsTable)
      .where(and(eq(automationDraftsTable.id, draftId), eq(automationDraftsTable.scope, scope)))
      .get();

    if (!draft) {
      throw new AutomationError("draft-not-found", `Automation draft ${draftId} not found`);
    }

    const now = new Date();
    const existing = await tx
      .select()
      .from(automationsTable)
      .where(and(eq(automationsTable.scope, scope), eq(automationsTable.name, draft.name)))
      .get();
    const content = {
      instructions: draft.instructions,
      source: draft.source,
      config: draft.config,
      allowedOrigins: draft.allowedOrigins,
      outputCapBytes: draft.outputCapBytes,
      status: EAutomationStatus.Active,
      failureCount: 0,
      lastError: null,
      updatedAt: now,
    };
    let saved: TAutomation;

    if (existing) {
      saved = await tx
        .update(automationsTable)
        .set(content)
        .where(eq(automationsTable.id, existing.id))
        .returning()
        .get();
    } else {
      saved = await tx
        .insert(automationsTable)
        .values({ ...content, scope, name: draft.name, state: null, createdAt: now })
        .returning()
        .get();
    }

    await tx
      .delete(automationDraftsTable)
      .where(
        and(eq(automationDraftsTable.scope, scope), eq(automationDraftsTable.name, draft.name)),
      );

    return saved;
  }

  public async list(scope: string): Promise<TAutomation[]> {
    return this.database.run(async (db) => {
      return db
        .select()
        .from(automationsTable)
        .where(eq(automationsTable.scope, scope))
        .orderBy(asc(automationsTable.name));
    });
  }

  public async get(scope: string, name: string): Promise<TOption<TAutomation>> {
    return this.database.run(async (db) => {
      return db
        .select()
        .from(automationsTable)
        .where(and(eq(automationsTable.scope, scope), eq(automationsTable.name, name)))
        .get();
    });
  }

  /** Returns the scope's automations in the order of `ids`, skipping missing ones. */
  public async getByIds(scope: string, ids: number[]): Promise<TAutomation[]> {
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.database.run(async (db) => {
      return db
        .select()
        .from(automationsTable)
        .where(and(eq(automationsTable.scope, scope), inArray(automationsTable.id, ids)));
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const automations: TAutomation[] = [];

    for (const id of ids) {
      const automation = byId.get(id);
      if (automation) {
        automations.push(automation);
      }
    }

    return automations;
  }

  public async resolveNames(scope: string, names: string[]): Promise<number[]> {
    if (names.length === 0) {
      return [];
    }

    const rows = await this.database.run(async (db) => {
      return db
        .select({ id: automationsTable.id, name: automationsTable.name })
        .from(automationsTable)
        .where(and(eq(automationsTable.scope, scope), inArray(automationsTable.name, names)));
    });
    const idsByName = new Map(rows.map((row) => [row.name, row.id]));
    const unknownNames = names.filter((name) => !idsByName.has(name));

    if (unknownNames.length > 0) {
      throw new AutomationError(
        "unknown-automation",
        `Unknown automations: ${unknownNames.join(", ")}`,
      );
    }

    const ids: number[] = [];
    for (const name of names) {
      const id = idsByName.get(name);
      if (id !== undefined) {
        ids.push(id);
      }
    }

    return ids;
  }

  public async setStatus(
    db: TDatabaseHandle,
    scope: string,
    name: string,
    status: EAutomationStatus,
  ): Promise<TAutomation> {
    let changes: Partial<typeof automationsTable.$inferInsert> = {
      status,
      updatedAt: new Date(),
    };
    if (status === EAutomationStatus.Active) {
      changes = { ...changes, failureCount: 0 };
    }

    const row = await db
      .update(automationsTable)
      .set(changes)
      .where(and(eq(automationsTable.scope, scope), eq(automationsTable.name, name)))
      .returning()
      .get();

    if (!row) {
      throw new AutomationError("automation-not-found", `Automation '${name}' not found`);
    }

    return row;
  }

  public async delete(tx: TDatabaseHandle, scope: string, name: string): Promise<TAutomation> {
    const automation = await tx
      .delete(automationsTable)
      .where(and(eq(automationsTable.scope, scope), eq(automationsTable.name, name)))
      .returning()
      .get();

    await tx
      .delete(automationDraftsTable)
      .where(and(eq(automationDraftsTable.scope, scope), eq(automationDraftsTable.name, name)));

    if (!automation) {
      throw new AutomationError("automation-not-found", `Automation '${name}' not found`);
    }

    return automation;
  }

  public async recordSuccess(
    db: TDatabaseHandle,
    id: number,
    state: TOption<unknown>,
  ): Promise<void> {
    let changes: Partial<typeof automationsTable.$inferInsert> = {
      failureCount: 0,
      lastError: null,
      updatedAt: new Date(),
    };
    if (state !== undefined) {
      changes = { ...changes, state };
    }

    await db.update(automationsTable).set(changes).where(eq(automationsTable.id, id));
  }

  public async recordFailure(
    db: TDatabaseHandle,
    id: number,
    error: string,
  ): Promise<{ failureCount: number; paused: boolean }> {
    const current = await db
      .select({ status: automationsTable.status, failureCount: automationsTable.failureCount })
      .from(automationsTable)
      .where(eq(automationsTable.id, id))
      .get();

    if (!current) {
      throw new AutomationError("automation-not-found", `Automation ${id} not found`);
    }

    const failureCount = current.failureCount + 1;
    const paused =
      current.status === EAutomationStatus.Active &&
      failureCount >= MAX_CONSECUTIVE_AUTOMATION_FAILURES;
    let changes: Partial<typeof automationsTable.$inferInsert> = {
      failureCount,
      lastError: error,
      updatedAt: new Date(),
    };
    if (paused) {
      changes = { ...changes, status: EAutomationStatus.Paused };
    }

    await db.update(automationsTable).set(changes).where(eq(automationsTable.id, id));

    if (paused) {
      this.logger.warning(
        `Paused automation ${id} after ${failureCount} consecutive failures: ${error}`,
      );
    }

    return { failureCount, paused };
  }
}
