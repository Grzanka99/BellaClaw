import type { TOption } from "@bellaclaw/shared";
import { createLogger } from "@bellaclaw/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { CronScheduler } from "../cron";
import type { TCronJob } from "../cron/types";
import { DatabaseConnector } from "../database";
import { automationDraftsTable, automationsTable } from "../database/schema";
import {
  AutomationError,
  DEFAULT_AUTOMATION_OUTPUT_CAP_BYTES,
  EAutomationStatus,
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

  public async createDraft(input: TCreateAutomationDraftInput): Promise<TAutomationDraft> {
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

    return this.database.run(async (db) => {
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
          createdAt: new Date(),
        })
        .returning()
        .get();
    });
  }

  public async deleteDraft(scope: string, draftId: number): Promise<void> {
    await this.database.run(async (db) => {
      await db
        .delete(automationDraftsTable)
        .where(and(eq(automationDraftsTable.id, draftId), eq(automationDraftsTable.scope, scope)));
    });
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

  public async saveDraft(scope: string, draftId: number): Promise<TAutomation> {
    return this.database.run(async (db) => {
      return db.transaction(async (tx) => {
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
      });
    });
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
    scope: string,
    name: string,
    status: EAutomationStatus,
  ): Promise<TAutomation> {
    const row = await this.database.run(async (db) => {
      let changes: Partial<typeof automationsTable.$inferInsert> = {
        status,
        updatedAt: new Date(),
      };
      if (status === EAutomationStatus.Active) {
        changes = { ...changes, failureCount: 0 };
      }

      return db
        .update(automationsTable)
        .set(changes)
        .where(and(eq(automationsTable.scope, scope), eq(automationsTable.name, name)))
        .returning()
        .get();
    });

    if (!row) {
      throw new AutomationError("automation-not-found", `Automation '${name}' not found`);
    }

    return row;
  }

  public async delete(
    scope: string,
    name: string,
  ): Promise<{ automation: TAutomation; updatedJobs: string[]; cancelledJobs: TCronJob[] }> {
    const automation = await this.database.run(async (db) => {
      return db.transaction(async (tx) => {
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

    if (!automation) {
      throw new AutomationError("automation-not-found", `Automation '${name}' not found`);
    }

    const { updatedJobs, cancelledJobs } = await CronScheduler.instance.removeAutomation(
      scope,
      automation.id,
    );

    return { automation, updatedJobs, cancelledJobs };
  }

  public async recordSuccess(id: number, state: TOption<unknown>): Promise<void> {
    await this.database.run(async (db) => {
      let changes: Partial<typeof automationsTable.$inferInsert> = {
        failureCount: 0,
        lastError: null,
        updatedAt: new Date(),
      };
      if (state !== undefined) {
        changes = { ...changes, state };
      }

      await db.update(automationsTable).set(changes).where(eq(automationsTable.id, id));
    });
  }

  public async recordFailure(
    id: number,
    error: string,
  ): Promise<{ failureCount: number; paused: boolean }> {
    const result = await this.database.run(async (db) => {
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

      return { failureCount, paused };
    });

    if (result.paused) {
      this.logger.warning(
        `Paused automation ${id} after ${result.failureCount} consecutive failures: ${error}`,
      );
    }

    return result;
  }
}
