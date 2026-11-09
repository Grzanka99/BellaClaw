import type { TOption } from "@bellaclaw/shared";
import { AsyncQueue, createLogger } from "@bellaclaw/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { CronSingleton } from "../cron";
import { DatabaseConnector } from "../database";
import { automationDraftsTable, automationsTable } from "../database/schema";
import {
  DEFAULT_AUTOMATION_OUTPUT_CAP_BYTES,
  EAutomationStatus,
  MAX_AUTOMATION_OUTPUT_CAP_BYTES,
  MAX_CONSECUTIVE_AUTOMATION_FAILURES,
  SAutomationDraftRow,
  SAutomationRow,
  type TAutomation,
  type TAutomationDraft,
  type TCreateAutomationDraftInput,
} from "./types";

export * from "./types";

export class AutomationService {
  private static _instance: TOption<AutomationService>;
  private db = DatabaseConnector.instance.database;
  private queue = new AsyncQueue();
  private logger = createLogger("AUTOMATIONS");

  public static get instance() {
    if (!AutomationService._instance) {
      AutomationService._instance = new AutomationService();
    }

    return AutomationService._instance;
  }

  public async createDraft(input: TCreateAutomationDraftInput): Promise<TAutomationDraft> {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new Error("Automation name must not be empty");
    }

    const allowedOrigins = new Set<string>();
    for (const origin of input.allowedOrigins) {
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        throw new Error(`Invalid allowed origin '${origin}': must be an http(s) origin`);
      }

      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`Invalid allowed origin '${origin}': must be an http(s) origin`);
      }

      allowedOrigins.add(url.origin);
    }

    const outputCapBytes = input.outputCapBytes ?? DEFAULT_AUTOMATION_OUTPUT_CAP_BYTES;
    if (
      !Number.isInteger(outputCapBytes) ||
      outputCapBytes < 1 ||
      outputCapBytes > MAX_AUTOMATION_OUTPUT_CAP_BYTES
    ) {
      throw new Error(
        `outputCapBytes must be an integer between 1 and ${MAX_AUTOMATION_OUTPUT_CAP_BYTES}`,
      );
    }

    let config: TOption<string>;
    try {
      config = JSON.stringify(input.config);
    } catch (error) {
      throw new Error(`Automation config must be JSON-serializable: ${String(error)}`);
    }

    if (config === undefined) {
      throw new Error("Automation config must be JSON-serializable");
    }

    const values = {
      scope: input.scope,
      name,
      instructions: input.instructions ?? null,
      source: input.source,
      config,
      allowedOrigins: JSON.stringify([...allowedOrigins]),
      outputCapBytes,
      createdAt: Date.now(),
    };

    const row = await this.queue.enqueue(async () => {
      return this.db.insert(automationDraftsTable).values(values).returning().get();
    });

    return this.requireDraft(row);
  }

  public async deleteDraft(scope: string, draftId: number): Promise<void> {
    await this.queue.enqueue(async () => {
      await this.db
        .delete(automationDraftsTable)
        .where(and(eq(automationDraftsTable.id, draftId), eq(automationDraftsTable.scope, scope)));
    });
  }

  public async getDraft(scope: string, draftId: number): Promise<TOption<TAutomationDraft>> {
    const row = await this.queue.enqueue(async () => {
      return this.db
        .select()
        .from(automationDraftsTable)
        .where(and(eq(automationDraftsTable.id, draftId), eq(automationDraftsTable.scope, scope)))
        .get();
    });

    if (!row) {
      return undefined;
    }

    return this.requireDraft(row);
  }

  public async saveDraft(scope: string, draftId: number): Promise<TAutomation> {
    const row = await this.queue.enqueue(async () => {
      return this.db.transaction(async (tx) => {
        const draft = await tx
          .select()
          .from(automationDraftsTable)
          .where(and(eq(automationDraftsTable.id, draftId), eq(automationDraftsTable.scope, scope)))
          .get();

        if (!draft) {
          throw new Error(`Automation draft ${draftId} not found`);
        }

        const now = Date.now();
        const existing = await tx
          .select()
          .from(automationsTable)
          .where(and(eq(automationsTable.scope, scope), eq(automationsTable.name, draft.name)))
          .get();

        let saved: typeof automationsTable.$inferSelect;
        if (existing) {
          saved = await tx
            .update(automationsTable)
            .set({
              instructions: draft.instructions,
              source: draft.source,
              config: draft.config,
              allowedOrigins: draft.allowedOrigins,
              outputCapBytes: draft.outputCapBytes,
              status: EAutomationStatus.Active,
              failureCount: 0,
              lastError: null,
              updatedAt: now,
            })
            .where(eq(automationsTable.id, existing.id))
            .returning()
            .get();
        } else {
          saved = await tx
            .insert(automationsTable)
            .values({
              scope,
              name: draft.name,
              instructions: draft.instructions,
              source: draft.source,
              config: draft.config,
              allowedOrigins: draft.allowedOrigins,
              outputCapBytes: draft.outputCapBytes,
              state: null,
              status: EAutomationStatus.Active,
              failureCount: 0,
              lastError: null,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get();
        }

        await tx
          .delete(automationDraftsTable)
          .where(
            and(eq(automationDraftsTable.scope, scope), eq(automationDraftsTable.name, draft.name)),
          );

        return saved;
      });
    });

    return this.requireAutomation(row);
  }

  public async list(scope: string): Promise<TAutomation[]> {
    const rows = await this.queue.enqueue(async () => {
      return this.db
        .select()
        .from(automationsTable)
        .where(eq(automationsTable.scope, scope))
        .orderBy(asc(automationsTable.name));
    });

    return this.parseAutomations(rows);
  }

  public async get(scope: string, name: string): Promise<TOption<TAutomation>> {
    const row = await this.queue.enqueue(async () => {
      return this.db
        .select()
        .from(automationsTable)
        .where(and(eq(automationsTable.scope, scope), eq(automationsTable.name, name)))
        .get();
    });

    if (!row) {
      return undefined;
    }

    return this.requireAutomation(row);
  }

  public async getByIds(scope: string, ids: number[]): Promise<TAutomation[]> {
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.queue.enqueue(async () => {
      return this.db
        .select()
        .from(automationsTable)
        .where(and(eq(automationsTable.scope, scope), inArray(automationsTable.id, ids)));
    });

    const byId = new Map<number, TAutomation>();
    for (const automation of this.parseAutomations(rows)) {
      byId.set(automation.id, automation);
    }

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

    const rows = await this.queue.enqueue(async () => {
      return this.db
        .select({ id: automationsTable.id, name: automationsTable.name })
        .from(automationsTable)
        .where(and(eq(automationsTable.scope, scope), inArray(automationsTable.name, names)));
    });

    const idsByName = new Map(rows.map((row) => [row.name, row.id]));
    const unknownNames = names.filter((name) => !idsByName.has(name));
    if (unknownNames.length > 0) {
      throw new Error(`Unknown automations: ${unknownNames.join(", ")}`);
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
    scope: string,
    name: string,
    status: EAutomationStatus,
  ): Promise<TAutomation> {
    const row = await this.queue.enqueue(async () => {
      let changes: Partial<typeof automationsTable.$inferInsert> = {
        status,
        updatedAt: Date.now(),
      };
      if (status === EAutomationStatus.Active) {
        changes = { ...changes, failureCount: 0 };
      }

      return this.db
        .update(automationsTable)
        .set(changes)
        .where(and(eq(automationsTable.scope, scope), eq(automationsTable.name, name)))
        .returning()
        .get();
    });

    if (!row) {
      throw new Error(`Automation '${name}' not found`);
    }

    return this.requireAutomation(row);
  }

  public async delete(
    scope: string,
    name: string,
  ): Promise<{ automation: TAutomation; updatedJobs: string[]; cancelledJobs: string[] }> {
    const row = await this.queue.enqueue(async () => {
      return this.db.transaction(async (tx) => {
        const deleted = await tx
          .delete(automationsTable)
          .where(and(eq(automationsTable.scope, scope), eq(automationsTable.name, name)))
          .returning()
          .get();

        await tx
          .delete(automationDraftsTable)
          .where(and(eq(automationDraftsTable.scope, scope), eq(automationDraftsTable.name, name)));

        return deleted;
      });
    });

    if (!row) {
      throw new Error(`Automation '${name}' not found`);
    }

    const automation = this.requireAutomation(row);
    const { updatedJobs, cancelledJobs } = await CronSingleton.instance.removeAutomation(
      scope,
      automation.id,
    );

    return { automation, updatedJobs, cancelledJobs };
  }

  public async recordSuccess(id: number, state: TOption<unknown>): Promise<void> {
    await this.queue.enqueue(async () => {
      let changes: Partial<typeof automationsTable.$inferInsert> = {
        failureCount: 0,
        lastError: null,
        updatedAt: Date.now(),
      };
      if (state !== undefined) {
        changes = { ...changes, state: JSON.stringify(state) };
      }

      await this.db.update(automationsTable).set(changes).where(eq(automationsTable.id, id));
    });
  }

  public async recordFailure(
    id: number,
    error: string,
  ): Promise<{ failureCount: number; paused: boolean }> {
    return this.queue.enqueue(async () => {
      const current = await this.db
        .select({ status: automationsTable.status, failureCount: automationsTable.failureCount })
        .from(automationsTable)
        .where(eq(automationsTable.id, id))
        .get();

      if (!current) {
        throw new Error(`Automation ${id} not found`);
      }

      const failureCount = current.failureCount + 1;
      const paused =
        current.status === EAutomationStatus.Active &&
        failureCount >= MAX_CONSECUTIVE_AUTOMATION_FAILURES;

      let changes: Partial<typeof automationsTable.$inferInsert> = {
        failureCount,
        lastError: error,
        updatedAt: Date.now(),
      };
      if (paused) {
        changes = { ...changes, status: EAutomationStatus.Paused };
        this.logger.warning(
          `Paused automation ${id} after ${failureCount} consecutive failures: ${error}`,
        );
      }

      await this.db.update(automationsTable).set(changes).where(eq(automationsTable.id, id));

      return { failureCount, paused };
    });
  }

  private parseAutomations(rows: unknown[]): TAutomation[] {
    const automations: TAutomation[] = [];
    for (const row of rows) {
      const parsed = SAutomationRow.safeParse(row);
      if (!parsed.success) {
        this.logger.error(`Failed to parse automation row: ${parsed.error.message}`);
        continue;
      }

      automations.push(parsed.data);
    }

    return automations;
  }

  private requireAutomation(row: unknown): TAutomation {
    const parsed = SAutomationRow.safeParse(row);
    if (!parsed.success) {
      throw new Error(`Failed to parse automation row: ${parsed.error.message}`);
    }

    return parsed.data;
  }

  private requireDraft(row: unknown): TAutomationDraft {
    const parsed = SAutomationDraftRow.safeParse(row);
    if (!parsed.success) {
      throw new Error(`Failed to parse automation draft row: ${parsed.error.message}`);
    }

    return parsed.data;
  }
}
