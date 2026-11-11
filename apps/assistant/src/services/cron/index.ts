import { EventEmitter } from "node:events";
import type { TOption } from "@bellaclaw/shared";
import { createLogger } from "@bellaclaw/shared";
import { Cron } from "croner";
import { and, asc, eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { DatabaseConnector } from "../database";
import { cronEngineJobsTable } from "../database/schema";
import { DefaultConfigRecord, EConfigKey } from "../settings/schema";
import {
  CronSchedulerError,
  ECronFinishedReason,
  ECronJobStatus,
  ECronJobType,
  type TCreateOnceArgs,
  type TCreateRecurringArgs,
  type TCronJob,
  type TCronJobContext,
  type TCronSchedulerOptions,
} from "./types";

export class CronScheduler extends EventEmitter {
  private static _instance: TOption<CronScheduler>;
  private static readonly FIRE_EVENT = Symbol("cron-scheduler-fire");
  private database = DatabaseConnector.instance;
  private logger = createLogger("CRON SCHEDULER");
  private timezone: TOption<string>;
  private timers = new Map<number, Cron>();
  private destroyed = false;

  public constructor(options: TCronSchedulerOptions) {
    super();

    this.timezone = options.timezone;
  }

  public static get instance() {
    if (!CronScheduler._instance) {
      CronScheduler._instance = new CronScheduler({
        timezone: DefaultConfigRecord[EConfigKey.AiInstructionsTimezone],
      });
    }

    return CronScheduler._instance;
  }

  public async setup(): Promise<void> {
    const jobs = await this.database.run(async (db) => {
      const rows = await db
        .select()
        .from(cronEngineJobsTable)
        .where(eq(cronEngineJobsTable.status, ECronJobStatus.Active))
        .orderBy(asc(cronEngineJobsTable.nextRunAt));

      return rows.map((row) => this.toJob(row));
    });

    for (const job of jobs) {
      await this.startTimerIfActive(job);
    }

    this.logger.info("started");
  }

  public onFire(listener: (ctx: TCronJobContext) => void) {
    return this.on(CronScheduler.FIRE_EVENT, listener);
  }

  public async createRecurring(args: TCreateRecurringArgs): Promise<TCronJob> {
    return this.createJob(args);
  }

  public async createOnce(args: TCreateOnceArgs): Promise<TCronJob> {
    if (args.fireAt <= new Date()) {
      throw new CronSchedulerError("fire-at-in-past", "create", "fireAt must be in the future");
    }
    return this.createJob(args);
  }

  private async createJob(args: TCreateRecurringArgs | TCreateOnceArgs): Promise<TCronJob> {
    const automationIds = args.automationIds ?? [];

    if (
      automationIds.length > 0 &&
      (args.content.kind === "text" || args.content.kind === "generated")
    ) {
      throw new CronSchedulerError(
        "automations-without-task",
        "create",
        "Automations can only be combined with a task prompt",
      );
    }

    if (automationIds.length === 0 && args.content.kind === "automations") {
      throw new CronSchedulerError(
        "missing-automations",
        "create",
        "A job without content needs at least one automation",
      );
    }

    let storedAutomationIds: TOption<number[]>;

    if (automationIds.length > 0) {
      storedAutomationIds = automationIds;
    }

    let type = ECronJobType.OneTime;
    if ("pattern" in args) {
      type = ECronJobType.Recurring;
    }

    try {
      const created = await this.database.run(async (db) => {
        const existing = await this.getActiveJob(db, args.name, args.scope);

        if (existing && existing.type !== type) {
          throw this.createCrossTypeCreateError(args.name, existing.type);
        }

        if (existing && args.overwrite !== true) {
          throw this.createDuplicateJobError(args.name);
        }

        const scheduledAt = new Date();
        const effectiveTimezone = args.timezone ?? existing?.timezone ?? this.timezone;
        let nextRunAt: Date;
        let pattern: TOption<string>;
        if ("pattern" in args) {
          pattern = args.pattern;
          const next = this.getNextRecurringRun(pattern, scheduledAt, effectiveTimezone);
          if (next === undefined) {
            throw new CronSchedulerError(
              "unschedulable-pattern",
              "create",
              `Cron pattern '${pattern}' cannot be scheduled`,
            );
          }
          nextRunAt = next;
        } else {
          try {
            new Intl.DateTimeFormat(undefined, { timeZone: effectiveTimezone });
          } catch {
            throw new Error(`Invalid timezone: ${effectiveTimezone}`);
          }
          nextRunAt = args.fireAt;
        }

        let contentBody: string;
        let contentFallback: TOption<string>;
        if (args.content.kind === "text") {
          contentBody = args.content.text;
        } else if (args.content.kind === "generated") {
          contentBody = args.content.promptData;
          contentFallback = args.content.fallback;
        } else if (args.content.kind === "task") {
          contentBody = args.content.prompt;
          contentFallback = args.content.fallback;
        } else {
          contentBody = "";
        }

        const rowValues = {
          name: args.name,
          scope: args.scope,
          type,
          pattern: pattern ?? null,
          contentKind: args.content.kind,
          contentBody,
          contentFallback: contentFallback ?? null,
          nextRunAt,
          lastRunAt: null,
          createdAt: scheduledAt,
          status: ECronJobStatus.Active,
          finishedAt: null,
          finishedReason: null,
          timezone: effectiveTimezone ?? null,
          automationIds: storedAutomationIds ?? null,
        };

        if (existing && args.overwrite === true) {
          const row = await db.transaction(async (tx) => {
            const claimedRow = await tx
              .update(cronEngineJobsTable)
              .set({
                status: ECronJobStatus.Cancelled,
                finishedAt: new Date(),
                finishedReason: ECronFinishedReason.Overwritten,
              })
              .where(
                and(
                  eq(cronEngineJobsTable.id, existing.id),
                  eq(cronEngineJobsTable.status, ECronJobStatus.Active),
                ),
              )
              .returning()
              .get();

            if (!claimedRow) {
              return undefined;
            }

            return tx.insert(cronEngineJobsTable).values(rowValues).returning().get();
          });

          if (!row) {
            throw new CronSchedulerError(
              "create-failed",
              "create",
              `Job '${args.name}' is no longer active.`,
            );
          }

          this.stopTimer(existing.id);
          return this.toJob(row);
        }

        try {
          const row = await db.insert(cronEngineJobsTable).values(rowValues).returning().get();
          return this.toJob(row);
        } catch (error) {
          const currentJob = await this.getActiveJob(db, args.name, args.scope);
          if (currentJob) {
            if (currentJob.type !== type) {
              throw this.createCrossTypeCreateError(args.name, currentJob.type);
            }

            throw this.createDuplicateJobError(args.name);
          }

          throw error;
        }
      });

      await this.startTimerIfActive(created);

      return created;
    } catch (error) {
      if (error instanceof CronSchedulerError) {
        throw error;
      }

      this.logger.error(`Failed to create job: ${String(error)}`);
      throw new CronSchedulerError("create-failed", "create", String(error));
    }
  }

  public async cancel(name: string, scope: string): Promise<TCronJob> {
    let cancelled: TOption<TCronJob>;

    try {
      cancelled = await this.database.run(async (db) => {
        const row = await db
          .update(cronEngineJobsTable)
          .set({
            status: ECronJobStatus.Cancelled,
            finishedAt: new Date(),
            finishedReason: ECronFinishedReason.Unscheduled,
          })
          .where(
            and(
              eq(cronEngineJobsTable.name, name),
              eq(cronEngineJobsTable.scope, scope),
              eq(cronEngineJobsTable.status, ECronJobStatus.Active),
            ),
          )
          .returning()
          .get();

        if (!row) {
          return undefined;
        }

        return this.toJob(row);
      });
    } catch (error) {
      this.logger.error(`Failed to cancel job: ${String(error)}`);
      throw new CronSchedulerError("cancel-failed", "cancel", String(error));
    }

    if (!cancelled) {
      throw new CronSchedulerError("job-not-found", "cancel", `No job found with name: ${name}`);
    }

    this.stopTimer(cancelled.id);
    return cancelled;
  }

  /**
   * Removes a deleted automation from the scope's active jobs. A job left with neither
   * automations nor content of its own is cancelled.
   */
  public async removeAutomation(
    scope: string,
    automationId: number,
  ): Promise<{ updatedJobs: string[]; cancelledJobs: TCronJob[] }> {
    const result = await this.database.run(async (db) => {
      const rows = await db
        .select()
        .from(cronEngineJobsTable)
        .where(
          and(
            eq(cronEngineJobsTable.scope, scope),
            eq(cronEngineJobsTable.status, ECronJobStatus.Active),
          ),
        );
      const updatedJobs: string[] = [];
      const cancelledJobs: TCronJob[] = [];

      for (const job of rows.map((row) => this.toJob(row))) {
        if (!job.automationIds.includes(automationId)) {
          continue;
        }

        const remaining = job.automationIds.filter((id) => id !== automationId);

        if (remaining.length === 0 && job.content.kind === "automations") {
          await db
            .update(cronEngineJobsTable)
            .set({
              status: ECronJobStatus.Cancelled,
              finishedAt: new Date(),
              finishedReason: ECronFinishedReason.Unscheduled,
            })
            .where(eq(cronEngineJobsTable.id, job.id));
          cancelledJobs.push(job);
          continue;
        }

        let automationIds: TOption<number[]>;

        if (remaining.length > 0) {
          automationIds = remaining;
        }

        await db
          .update(cronEngineJobsTable)
          .set({ automationIds: automationIds ?? null })
          .where(eq(cronEngineJobsTable.id, job.id));
        updatedJobs.push(job.name);
      }

      return { updatedJobs, cancelledJobs };
    });

    for (const job of result.cancelledJobs) {
      this.stopTimer(job.id);
    }

    return result;
  }

  public async list(scope: string): Promise<TCronJob[]> {
    return this.database.run(async (db) => {
      const rows = await db
        .select()
        .from(cronEngineJobsTable)
        .where(
          and(
            eq(cronEngineJobsTable.scope, scope),
            eq(cronEngineJobsTable.status, ECronJobStatus.Active),
          ),
        )
        .orderBy(asc(cronEngineJobsTable.nextRunAt));

      return rows.map((row) => this.toJob(row));
    });
  }

  public async get(name: string, scope: string): Promise<TOption<TCronJob>> {
    return this.database.run(async (db) => {
      return this.getActiveJob(db, name, scope);
    });
  }

  public destroy() {
    this.destroyed = true;

    for (const timer of this.timers.values()) {
      timer.stop();
    }

    this.timers.clear();

    if (CronScheduler._instance === this) {
      CronScheduler._instance = undefined;
    }
  }

  private startTimer(job: TCronJob) {
    if (this.destroyed) {
      return;
    }

    this.stopTimer(job.id);

    try {
      let timer: Cron;
      if (job.type === ECronJobType.Recurring && job.pattern) {
        timer = new Cron(
          job.pattern,
          {
            mode: "5-part",
            timezone: job.timezone ?? this.timezone,
          },
          () => {
            void this.fire(job.id);
          },
        );
      } else {
        timer = new Cron(job.nextRunAt, () => {
          void this.fire(job.id);
        });
      }

      this.timers.set(job.id, timer);
    } catch (error) {
      this.logger.error(`Failed to start timer for job '${job.name}': ${String(error)}`);
    }
  }

  private async startTimerIfActive(job: TCronJob) {
    const overdueJob = await this.database.run(async (db) => {
      const row = await db
        .select()
        .from(cronEngineJobsTable)
        .where(
          and(
            eq(cronEngineJobsTable.id, job.id),
            eq(cronEngineJobsTable.status, ECronJobStatus.Active),
          ),
        )
        .get();

      if (row === undefined) {
        return;
      }

      const activeJob = this.toJob(row);
      if (activeJob.nextRunAt <= new Date()) {
        return activeJob;
      }

      this.startTimer(activeJob);
    });

    if (!overdueJob) {
      return;
    }

    if (overdueJob.type === ECronJobType.Recurring) {
      await this.skipMissedRecurringRun(overdueJob, new Date());
      return;
    }

    await this.fire(overdueJob.id);
  }

  private stopTimer(id: number) {
    const timer = this.timers.get(id);
    if (!timer) {
      return;
    }

    timer.stop();
    this.timers.delete(id);
  }

  private async skipMissedRecurringRun(job: TCronJob, now: Date) {
    if (!job.pattern) {
      return;
    }

    let nextRunAt: TOption<Date>;
    try {
      nextRunAt = this.getNextRecurringRun(job.pattern, now, job.timezone ?? this.timezone);
    } catch (error) {
      this.logger.error(
        `Failed to compute next run for job '${job.name}' during setup: ${String(error)}`,
      );
      return;
    }

    if (!nextRunAt) {
      this.logger.error(`Failed to compute next run for job '${job.name}' during setup`);
      return;
    }

    const updated = await this.database.run(async (db) => {
      const row = await db
        .update(cronEngineJobsTable)
        .set({ nextRunAt })
        .where(
          and(
            eq(cronEngineJobsTable.id, job.id),
            eq(cronEngineJobsTable.status, ECronJobStatus.Active),
            eq(cronEngineJobsTable.nextRunAt, job.nextRunAt),
          ),
        )
        .returning()
        .get();

      if (!row) {
        return undefined;
      }

      return this.toJob(row);
    });

    if (updated) {
      await this.startTimerIfActive(updated);
    }
  }

  private async fire(id: number) {
    try {
      const firedJob = await this.database.run(async (db) => {
        const current = await db
          .select()
          .from(cronEngineJobsTable)
          .where(
            and(
              eq(cronEngineJobsTable.id, id),
              eq(cronEngineJobsTable.status, ECronJobStatus.Active),
            ),
          )
          .get();

        if (!current) {
          return undefined;
        }

        const job = this.toJob(current);
        const now = new Date();
        if (job.nextRunAt > now) {
          return undefined;
        }

        if (job.type === ECronJobType.Recurring && job.pattern) {
          const nextRun = this.getNextRecurringRun(job.pattern, now, job.timezone ?? this.timezone);

          if (!nextRun) {
            return undefined;
          }

          const row = await db
            .update(cronEngineJobsTable)
            .set({
              nextRunAt: nextRun,
              lastRunAt: now,
            })
            .where(
              and(
                eq(cronEngineJobsTable.id, job.id),
                eq(cronEngineJobsTable.status, ECronJobStatus.Active),
                eq(cronEngineJobsTable.nextRunAt, job.nextRunAt),
              ),
            )
            .returning()
            .get();

          if (!row) {
            return undefined;
          }

          return job;
        }

        if (job.type === ECronJobType.OneTime) {
          const row = await db
            .update(cronEngineJobsTable)
            .set({
              status: ECronJobStatus.Completed,
              lastRunAt: now,
              finishedAt: now,
              finishedReason: ECronFinishedReason.Fired,
            })
            .where(
              and(
                eq(cronEngineJobsTable.id, job.id),
                eq(cronEngineJobsTable.status, ECronJobStatus.Active),
                eq(cronEngineJobsTable.nextRunAt, job.nextRunAt),
              ),
            )
            .returning()
            .get();

          if (!row) {
            return undefined;
          }

          return job;
        }

        return undefined;
      });

      if (!firedJob) {
        return;
      }

      if (firedJob.type === ECronJobType.OneTime) {
        this.stopTimer(firedJob.id);
      }

      this.logger.info(`fired job '${firedJob.name}' (id: ${firedJob.id}, type: ${firedJob.type})`);

      const ctx: TCronJobContext = {
        name: firedJob.name,
        scope: firedJob.scope,
        type: firedJob.type,
        pattern: firedJob.pattern ?? undefined,
        content: firedJob.content,
        automationIds: firedJob.automationIds,
        lastRunAt: firedJob.lastRunAt ?? undefined,
        nextRunAt: firedJob.nextRunAt,
        createdAt: firedJob.createdAt,
        timezone: firedJob.timezone ?? this.timezone,
      };

      this.emit(CronScheduler.FIRE_EVENT, ctx);
    } catch (error) {
      this.logger.error(`Failed to fire job ${id}: ${String(error)}`);
    }
  }

  private getNextRecurringRun(
    pattern: string,
    from: Date,
    timezone: TOption<string>,
  ): TOption<Date> {
    return new Cron(pattern, { paused: true, mode: "5-part", timezone }).nextRun(from) ?? undefined;
  }

  private createDuplicateJobError(name: string) {
    return new CronSchedulerError(
      "job-already-exists",
      "create",
      `Job '${name}' already exists. Set overwrite: true to replace.`,
    );
  }

  private createCrossTypeCreateError(name: string, existingType: ECronJobType) {
    if (existingType === ECronJobType.OneTime) {
      return new CronSchedulerError(
        "job-already-exists",
        "create",
        `A one-time job named '${name}' already exists. Cancel it first.`,
      );
    }

    return new CronSchedulerError(
      "job-already-exists",
      "create",
      `A recurring job named '${name}' already exists. Cancel it first.`,
    );
  }

  private toJob(row: typeof cronEngineJobsTable.$inferSelect): TCronJob {
    const { contentKind, contentBody, contentFallback, automationIds: storedIds, ...rest } = row;
    const job = { ...rest, automationIds: storedIds ?? [] };

    if (contentKind === "automations") {
      return { ...job, content: { kind: "automations" } };
    }

    if (contentKind === "generated") {
      return {
        ...job,
        content: { kind: "generated", promptData: contentBody, fallback: contentFallback ?? "" },
      };
    }

    if (contentKind === "task") {
      return {
        ...job,
        content: { kind: "task", prompt: contentBody, fallback: contentFallback ?? "" },
      };
    }

    return { ...job, content: { kind: "text", text: contentBody } };
  }

  private async getActiveJob(
    db: LibSQLDatabase,
    name: string,
    scope: string,
  ): Promise<TOption<TCronJob>> {
    const row = await db
      .select()
      .from(cronEngineJobsTable)
      .where(
        and(
          eq(cronEngineJobsTable.name, name),
          eq(cronEngineJobsTable.scope, scope),
          eq(cronEngineJobsTable.status, ECronJobStatus.Active),
        ),
      )
      .get();

    if (!row) {
      return undefined;
    }

    return this.toJob(row);
  }
}
