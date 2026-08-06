import { EventEmitter } from "node:events";
import { Cron } from "croner";
import { and, asc, eq } from "drizzle-orm";
import { DatabaseConnector } from "../../services/database";
import { cronEngineJobsTable } from "../../services/database/schema";
import type { TOption } from "../../types";
import { AsyncQueue } from "../../utils/async-queue";
import { createLogger } from "../../utils/logger";
import {
  ECronFinishedReason,
  ECronJobStatus,
  ECronJobType,
  SCronJob,
  type TCreateOnceArgs,
  type TCreateRecurringArgs,
  type TCronJob,
  type TCronJobContext,
  type TCronSchedulerError,
  type TCronSchedulerOptions,
} from "./types";

const RESERVED_CRON_JOB_EVENT_NAMES = new Set(["error", "newListener", "removeListener"]);

export * from "./types";

export function isReservedCronJobEventName(name: string) {
  return RESERVED_CRON_JOB_EVENT_NAMES.has(name);
}

export class CronScheduler extends EventEmitter {
  private static readonly FIRE_EVENT = Symbol("cron-scheduler-fire");
  private db = DatabaseConnector.instance.database;
  private queue = new AsyncQueue();
  private logger = createLogger("CRON SCHEDULER");
  private timezone: TOption<string>;
  private timers = new Map<number, Cron>();
  private destroyed = false;

  public constructor(options: TCronSchedulerOptions) {
    super();

    this.timezone = options.timezone;
  }

  public async setup(): Promise<void> {
    const jobs = await this.list();
    for (const job of jobs) {
      await this.startTimerIfActive(job);
    }

    this.logger.info("started");
  }

  public onFire(listener: (ctx: TCronJobContext) => void) {
    return this.on(CronScheduler.FIRE_EVENT, listener);
  }

  public async createRecurring(
    args: TCreateRecurringArgs,
  ): Promise<TCronJob | TCronSchedulerError> {
    if (isReservedCronJobEventName(args.name)) {
      return this.createReservedJobNameError(args.name);
    }

    const normalizedScope = this.normalizeScope(args.scope);

    try {
      const created = await this.queue.enqueue(async () => {
        const existing = await this.getJobByNormalizedScope(args.name, normalizedScope);

        if (existing && existing.type !== ECronJobType.Recurring) {
          return this.createCrossTypeCreateError(args.name, existing.type);
        }

        if (existing && args.overwrite !== true) {
          return this.createDuplicateJobError(args.name);
        }

        const scheduledAt = new Date();
        const effectiveTimezone = args.timezone ?? existing?.timezone ?? this.timezone;
        let nextRunAt: TOption<Date>;
        try {
          nextRunAt = this.getNextRecurringRun(args.pattern, scheduledAt, effectiveTimezone);
        } catch (error) {
          return { operation: "create", error } satisfies TCronSchedulerError;
        }

        if (!nextRunAt) {
          return this.createUnschedulablePatternError(args.pattern);
        }

        const rowValues = {
          name: args.name,
          scope: normalizedScope,
          group: args.group ?? null,
          type: ECronJobType.Recurring,
          pattern: args.pattern,
          reminderText: args.reminderText ?? null,
          reminderPromptData: args.reminderPromptData ?? null,
          reminderFallbackText: args.reminderFallbackText ?? args.reminderText ?? null,
          taskPrompt: args.taskPrompt ?? null,
          taskFallbackText: args.taskFallbackText ?? null,
          nextRunAt: nextRunAt.getTime(),
          lastRunAt: null,
          createdAt: scheduledAt.getTime(),
          status: ECronJobStatus.Active,
          finishedAt: null,
          finishedReason: null,
          timezone: effectiveTimezone ?? null,
        };

        if (existing && args.overwrite === true) {
          const row = await this.db.transaction(async (tx) => {
            const claimedRow = await tx
              .update(cronEngineJobsTable)
              .set({
                status: ECronJobStatus.Cancelled,
                finishedAt: Date.now(),
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
            return this.createOverwriteInactiveJobError(args.name);
          }

          this.stopTimer(existing.id);
          return this.parseJobRow(row) ?? this.createCreatedJobReadbackError();
        }

        try {
          const row = await this.db.insert(cronEngineJobsTable).values(rowValues).returning().get();
          return this.parseJobRow(row) ?? this.createCreatedJobReadbackError();
        } catch (error) {
          const currentJob = await this.getJobByNormalizedScope(args.name, normalizedScope);
          if (currentJob) {
            if (currentJob.type !== ECronJobType.Recurring) {
              return this.createCrossTypeCreateError(args.name, currentJob.type);
            }

            return this.createDuplicateJobError(args.name);
          }

          throw error;
        }
      });

      if ("id" in created) {
        await this.startTimerIfActive(created);
      }

      return created;
    } catch (error) {
      this.logger.error(`Failed to create recurring job: ${String(error)}`);
      return { operation: "create", error };
    }
  }

  public async createOnce(args: TCreateOnceArgs): Promise<TCronJob | TCronSchedulerError> {
    if (isReservedCronJobEventName(args.name)) {
      return this.createReservedJobNameError(args.name);
    }

    const now = new Date();
    if (args.fireAt <= now) {
      return { operation: "create", error: "fireAt must be in the future" };
    }

    const normalizedScope = this.normalizeScope(args.scope);

    try {
      const created = await this.queue.enqueue(async () => {
        const existing = await this.getJobByNormalizedScope(args.name, normalizedScope);

        if (existing && existing.type !== ECronJobType.OneTime) {
          return this.createCrossTypeCreateError(args.name, existing.type);
        }

        if (existing && args.overwrite !== true) {
          return this.createDuplicateJobError(args.name);
        }

        const effectiveTimezone = args.timezone ?? existing?.timezone ?? this.timezone;
        try {
          new Intl.DateTimeFormat(undefined, { timeZone: effectiveTimezone });
        } catch {
          return {
            operation: "create",
            error: new Error(`Invalid timezone: ${effectiveTimezone}`),
          } satisfies TCronSchedulerError;
        }

        const rowValues = {
          name: args.name,
          scope: normalizedScope,
          group: args.group ?? null,
          type: ECronJobType.OneTime,
          pattern: null,
          reminderText: args.reminderText ?? null,
          reminderPromptData: args.reminderPromptData ?? null,
          reminderFallbackText: args.reminderFallbackText ?? args.reminderText ?? null,
          taskPrompt: args.taskPrompt ?? null,
          taskFallbackText: args.taskFallbackText ?? null,
          nextRunAt: args.fireAt.getTime(),
          lastRunAt: null,
          createdAt: Date.now(),
          status: ECronJobStatus.Active,
          finishedAt: null,
          finishedReason: null,
          timezone: effectiveTimezone ?? null,
        };

        if (existing && args.overwrite === true) {
          const row = await this.db.transaction(async (tx) => {
            const claimedRow = await tx
              .update(cronEngineJobsTable)
              .set({
                status: ECronJobStatus.Cancelled,
                finishedAt: Date.now(),
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
            return this.createOverwriteInactiveJobError(args.name);
          }

          this.stopTimer(existing.id);
          return this.parseJobRow(row) ?? this.createCreatedJobReadbackError();
        }

        try {
          const row = await this.db.insert(cronEngineJobsTable).values(rowValues).returning().get();
          return this.parseJobRow(row) ?? this.createCreatedJobReadbackError();
        } catch (error) {
          const currentJob = await this.getJobByNormalizedScope(args.name, normalizedScope);
          if (currentJob) {
            if (currentJob.type !== ECronJobType.OneTime) {
              return this.createCrossTypeCreateError(args.name, currentJob.type);
            }

            return this.createDuplicateJobError(args.name);
          }

          throw error;
        }
      });

      if ("id" in created) {
        await this.startTimerIfActive(created);
      }

      return created;
    } catch (error) {
      this.logger.error(`Failed to create one-time job: ${String(error)}`);
      return { operation: "create", error };
    }
  }

  public async cancel(name: string, scope?: string): Promise<TCronJob | TCronSchedulerError> {
    try {
      const cancelled = await this.queue.enqueue(async () => {
        const finishedAt = Date.now();
        const row = await this.db
          .update(cronEngineJobsTable)
          .set({
            status: ECronJobStatus.Cancelled,
            finishedAt,
            finishedReason: ECronFinishedReason.Unscheduled,
          })
          .where(
            and(
              eq(cronEngineJobsTable.name, name),
              eq(cronEngineJobsTable.scope, this.normalizeScope(scope)),
              eq(cronEngineJobsTable.status, ECronJobStatus.Active),
            ),
          )
          .returning()
          .get();

        return this.parseJobRow(row);
      });

      if (!cancelled) {
        return { operation: "cancel", error: `No job found with name: ${name}` };
      }

      this.stopTimer(cancelled.id);
      return cancelled;
    } catch (error) {
      this.logger.error(`Failed to cancel job: ${String(error)}`);
      return { operation: "cancel", error };
    }
  }

  public async list(scope?: string): Promise<TCronJob[]> {
    return this.queue.enqueue(async () => {
      let query = this.db
        .select()
        .from(cronEngineJobsTable)
        .orderBy(asc(cronEngineJobsTable.nextRunAt))
        .$dynamic();

      if (scope !== undefined) {
        query = query.where(
          and(
            eq(cronEngineJobsTable.scope, this.normalizeScope(scope)),
            eq(cronEngineJobsTable.status, ECronJobStatus.Active),
          ),
        );
      } else {
        query = query.where(eq(cronEngineJobsTable.status, ECronJobStatus.Active));
      }

      const rows = await query;
      const jobs: TCronJob[] = [];
      for (const row of rows) {
        const parsed = SCronJob.safeParse(row);
        if (!parsed.success) {
          this.logger.error(`Failed to parse job from DB in list: ${parsed.error.message}`);
          continue;
        }

        jobs.push(parsed.data);
      }

      return jobs;
    });
  }

  public async get(name: string, scope?: string): Promise<TOption<TCronJob>> {
    return this.queue.enqueue(async () => {
      return this.getJobByNormalizedScope(name, this.normalizeScope(scope));
    });
  }

  public destroy() {
    this.destroyed = true;

    for (const timer of this.timers.values()) {
      timer.stop();
    }

    this.timers.clear();
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
    const overdueJob = await this.queue.enqueue(async () => {
      const row = await this.db
        .select()
        .from(cronEngineJobsTable)
        .where(
          and(
            eq(cronEngineJobsTable.id, job.id),
            eq(cronEngineJobsTable.status, ECronJobStatus.Active),
          ),
        )
        .get();

      const activeJob = this.parseJobRow(row);
      if (activeJob === undefined) {
        return;
      }

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

    const updated = await this.queue.enqueue(async () => {
      const row = await this.db
        .update(cronEngineJobsTable)
        .set({
          nextRunAt: nextRunAt.getTime(),
        })
        .where(
          and(
            eq(cronEngineJobsTable.id, job.id),
            eq(cronEngineJobsTable.status, ECronJobStatus.Active),
            eq(cronEngineJobsTable.nextRunAt, job.nextRunAt.getTime()),
          ),
        )
        .returning()
        .get();

      return this.parseJobRow(row);
    });

    if (updated) {
      await this.startTimerIfActive(updated);
    }
  }

  private async fire(id: number) {
    try {
      const firedJob = await this.queue.enqueue(async () => {
        const current = await this.db
          .select()
          .from(cronEngineJobsTable)
          .where(
            and(
              eq(cronEngineJobsTable.id, id),
              eq(cronEngineJobsTable.status, ECronJobStatus.Active),
            ),
          )
          .get();

        const job = this.parseJobRow(current);
        if (!job) {
          return undefined;
        }

        const now = Date.now();
        if (job.nextRunAt.getTime() > now) {
          return undefined;
        }

        if (job.type === ECronJobType.Recurring && job.pattern) {
          const nextRun = this.getNextRecurringRun(
            job.pattern,
            new Date(now),
            job.timezone ?? this.timezone,
          );

          if (!nextRun) {
            return undefined;
          }

          const row = await this.db
            .update(cronEngineJobsTable)
            .set({
              nextRunAt: nextRun.getTime(),
              lastRunAt: now,
            })
            .where(
              and(
                eq(cronEngineJobsTable.id, job.id),
                eq(cronEngineJobsTable.status, ECronJobStatus.Active),
                eq(cronEngineJobsTable.nextRunAt, job.nextRunAt.getTime()),
              ),
            )
            .returning()
            .get();

          if (!this.parseJobRow(row)) {
            return undefined;
          }

          return job;
        }

        if (job.type === ECronJobType.OneTime) {
          const row = await this.db
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
                eq(cronEngineJobsTable.nextRunAt, job.nextRunAt.getTime()),
              ),
            )
            .returning()
            .get();

          if (!this.parseJobRow(row)) {
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
        group: firedJob.group,
        type: firedJob.type,
        pattern: firedJob.pattern,
        reminderText: firedJob.reminderText,
        reminderPromptData: firedJob.reminderPromptData,
        reminderFallbackText: firedJob.reminderFallbackText,
        taskPrompt: firedJob.taskPrompt,
        taskFallbackText: firedJob.taskFallbackText,
        lastRunAt: firedJob.lastRunAt,
        nextRunAt: firedJob.nextRunAt,
        createdAt: firedJob.createdAt,
        timezone: firedJob.timezone ?? this.timezone,
      };

      this.emit(CronScheduler.FIRE_EVENT, ctx);
      if (!isReservedCronJobEventName(firedJob.name)) {
        this.emit(firedJob.name, ctx);
      }
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

  private normalizeScope(scope: TOption<string>) {
    return scope ?? "";
  }

  private createDuplicateJobError(name: string): TCronSchedulerError {
    return {
      operation: "create",
      error: `Job '${name}' already exists. Set overwrite: true to replace.`,
    };
  }

  private createCrossTypeCreateError(
    name: string,
    existingType: ECronJobType,
  ): TCronSchedulerError {
    if (existingType === ECronJobType.OneTime) {
      return {
        operation: "create",
        error: `A one-time job named '${name}' already exists. Cancel it first.`,
      };
    }

    return {
      operation: "create",
      error: `A recurring job named '${name}' already exists. Cancel it first.`,
    };
  }

  private createCreatedJobReadbackError(): TCronSchedulerError {
    return { operation: "create", error: "Failed to read back created job" };
  }

  private createUnschedulablePatternError(pattern: string): TCronSchedulerError {
    return { operation: "create", error: `Cron pattern '${pattern}' cannot be scheduled` };
  }

  private createOverwriteInactiveJobError(name: string): TCronSchedulerError {
    return { operation: "create", error: `Job '${name}' is no longer active.` };
  }

  private createReservedJobNameError(name: string): TCronSchedulerError {
    return { operation: "create", error: `Job name '${name}' is reserved by EventEmitter` };
  }

  private parseJobRow(row: unknown): TOption<TCronJob> {
    const parsed = SCronJob.safeParse(row);
    if (!parsed.success) {
      return undefined;
    }

    return parsed.data;
  }

  private async getJobByNormalizedScope(
    name: string,
    normalizedScope: string,
  ): Promise<TOption<TCronJob>> {
    const row = await this.db
      .select()
      .from(cronEngineJobsTable)
      .where(
        and(
          eq(cronEngineJobsTable.name, name),
          eq(cronEngineJobsTable.scope, normalizedScope),
          eq(cronEngineJobsTable.status, ECronJobStatus.Active),
        ),
      )
      .get();

    return this.parseJobRow(row);
  }
}
