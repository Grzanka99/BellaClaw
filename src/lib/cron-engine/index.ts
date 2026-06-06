import { EventEmitter } from "node:events";
import { and, asc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { DatabaseConnector } from "../../services/database";
import { cronEngineJobsTable } from "../../services/database/schema";
import type { TOption } from "../../types";
import { AsyncQueue } from "../../utils/async-queue";
import { createLogger } from "../../utils/logger";
import { getNextFireTime, isValidCron } from "./parser";
import {
  ECronEngineJobType,
  SCronEngineJob,
  type TCronEngineError,
  type TCronEngineJob,
  type TCronEngineJobContext,
  type TCronEngineOptions,
  type TScheduleOnceArgs,
  type TScheduleRecurringArgs,
} from "./types";

const RESERVED_CRON_JOB_EVENT_NAMES = new Set(["error", "newListener", "removeListener"]);

export * from "./parser";
export * from "./types";

export function isReservedCronJobEventName(name: string) {
  return RESERVED_CRON_JOB_EVENT_NAMES.has(name);
}

export class CronEngine extends EventEmitter {
  private static readonly FIRE_EVENT = Symbol("cron-engine-fire");
  private db = DatabaseConnector.instance.database;
  private queue: AsyncQueue;
  private logger = createLogger("CRON ENGINE");
  private timezone: TOption<string>;
  private tickInterval: TOption<ReturnType<typeof setInterval>>;
  private isTicking = false;

  public constructor(options: TCronEngineOptions) {
    super();

    this.timezone = options.timezone;
    this.queue = new AsyncQueue();
  }

  public setup(pollIntervalMs = 10_000) {
    if (this.tickInterval) {
      return;
    }

    this.logger.info("started");

    this.tickInterval = setInterval(() => this.tick(), pollIntervalMs);
    this.tick();
  }

  public onFire(listener: (ctx: TCronEngineJobContext) => void) {
    return this.on(CronEngine.FIRE_EVENT, listener);
  }

  public async schedule(args: TScheduleRecurringArgs): Promise<TCronEngineJob | TCronEngineError> {
    if (isReservedCronJobEventName(args.name)) {
      return this.createReservedJobNameError(args.name);
    }

    if (!isValidCron(args.pattern)) {
      return { operation: "schedule", error: `Invalid cron pattern: ${args.pattern}` };
    }

    const normalizedScope = this.normalizeScope(args.scope);
    const scheduledAt = new Date();
    let nextRunAt: Date;
    try {
      nextRunAt = getNextFireTime(args.pattern, scheduledAt, this.timezone);
    } catch (error) {
      return this.createUnschedulablePatternError(args.pattern, error);
    }

    try {
      return await this.queue.enqueue(async () => {
        const existing = await this.getJobByNormalizedScope(args.name, normalizedScope);

        if (existing && existing.type !== ECronEngineJobType.Recurring) {
          return this.createCrossTypeScheduleError(args.name, existing.type);
        }

        if (existing && args.overwrite !== true) {
          return this.createDuplicateJobError(args.name);
        }

        const rowValues = {
          name: args.name,
          scope: normalizedScope,
          group: args.group ?? null,
          type: ECronEngineJobType.Recurring,
          pattern: args.pattern,
          reminderText: args.reminderText ?? null,
          reminderPromptData: args.reminderPromptData ?? null,
          reminderFallbackText: args.reminderFallbackText ?? args.reminderText ?? null,
          nextRunAt: nextRunAt.getTime(),
          lastRunAt: null,
          createdAt: scheduledAt.getTime(),
        };

        if (existing && args.overwrite === true) {
          const row = await this.db
            .update(cronEngineJobsTable)
            .set(rowValues)
            .where(
              and(
                eq(cronEngineJobsTable.name, args.name),
                eq(cronEngineJobsTable.scope, normalizedScope),
                eq(cronEngineJobsTable.type, ECronEngineJobType.Recurring),
              ),
            )
            .returning()
            .get();

          return this.parseJobRow(row) ?? this.createScheduledJobReadbackError();
        }

        try {
          const row = await this.db.insert(cronEngineJobsTable).values(rowValues).returning().get();

          const job = this.parseJobRow(row);
          if (job) {
            return job;
          }

          return this.createScheduledJobReadbackError();
        } catch (error) {
          const currentJob = await this.getJobByNormalizedScope(args.name, normalizedScope);
          if (currentJob) {
            if (currentJob.type !== ECronEngineJobType.Recurring) {
              return this.createCrossTypeScheduleError(args.name, currentJob.type);
            }

            return this.createDuplicateJobError(args.name);
          }

          throw error;
        }
      });
    } catch (error) {
      this.logger.error(`Failed to schedule job: ${String(error)}`);
      return { operation: "schedule", error };
    }
  }

  public async scheduleOnce(args: TScheduleOnceArgs): Promise<TCronEngineJob | TCronEngineError> {
    if (isReservedCronJobEventName(args.name)) {
      return this.createReservedJobNameError(args.name);
    }

    const now = new Date();
    if (args.fireAt <= now) {
      return { operation: "schedule", error: "fireAt must be in the future" };
    }

    const normalizedScope = this.normalizeScope(args.scope);

    try {
      return await this.queue.enqueue(async () => {
        const existing = await this.getJobByNormalizedScope(args.name, normalizedScope);

        if (existing && existing.type !== ECronEngineJobType.OneTime) {
          return this.createCrossTypeScheduleError(args.name, existing.type);
        }

        if (existing && args.overwrite !== true) {
          return this.createDuplicateJobError(args.name);
        }

        const rowValues = {
          name: args.name,
          scope: normalizedScope,
          group: args.group ?? null,
          type: ECronEngineJobType.OneTime,
          pattern: null,
          reminderText: args.reminderText ?? null,
          reminderPromptData: args.reminderPromptData ?? null,
          reminderFallbackText: args.reminderFallbackText ?? args.reminderText ?? null,
          nextRunAt: args.fireAt.getTime(),
          lastRunAt: null,
          createdAt: Date.now(),
        };

        if (existing && args.overwrite === true) {
          const row = await this.db
            .update(cronEngineJobsTable)
            .set(rowValues)
            .where(
              and(
                eq(cronEngineJobsTable.name, args.name),
                eq(cronEngineJobsTable.scope, normalizedScope),
                eq(cronEngineJobsTable.type, ECronEngineJobType.OneTime),
              ),
            )
            .returning()
            .get();

          return this.parseJobRow(row) ?? this.createScheduledJobReadbackError();
        }

        try {
          const row = await this.db.insert(cronEngineJobsTable).values(rowValues).returning().get();

          const job = this.parseJobRow(row);
          if (job) {
            return job;
          }

          return this.createScheduledJobReadbackError();
        } catch (error) {
          const currentJob = await this.getJobByNormalizedScope(args.name, normalizedScope);
          if (currentJob) {
            if (currentJob.type !== ECronEngineJobType.OneTime) {
              return this.createCrossTypeScheduleError(args.name, currentJob.type);
            }

            return this.createDuplicateJobError(args.name);
          }

          throw error;
        }
      });
    } catch (error) {
      this.logger.error(`Failed to schedule one-time job: ${String(error)}`);
      return { operation: "schedule", error };
    }
  }

  public async unschedule(
    name: string,
    scope?: string,
  ): Promise<TCronEngineJob | TCronEngineError> {
    try {
      const res = await this.queue.enqueue(async () => {
        const row = await this.db
          .delete(cronEngineJobsTable)
          .where(
            and(
              eq(cronEngineJobsTable.name, name),
              eq(cronEngineJobsTable.scope, this.normalizeScope(scope)),
            ),
          )
          .returning()
          .get();

        const job = this.parseJobRow(row);
        if (!job) {
          return undefined;
        }

        return job;
      });

      if (!res) {
        return { operation: "unschedule", error: `No job found with name: ${name}` };
      }

      return res;
    } catch (error) {
      this.logger.error(`Failed to unschedule job: ${String(error)}`);
      return { operation: "unschedule", error };
    }
  }

  public async getAllJobs(scope?: string): Promise<TCronEngineJob[]> {
    const results = await this.queue.enqueue(async () => {
      let query = this.db
        .select()
        .from(cronEngineJobsTable)
        .orderBy(asc(cronEngineJobsTable.nextRunAt))
        .$dynamic();

      if (scope !== undefined) {
        query = query.where(eq(cronEngineJobsTable.scope, this.normalizeScope(scope)));
      }

      const rows = await query;

      const parsed = z.array(SCronEngineJob).safeParse(rows);
      if (!parsed.success) {
        this.logger.error("Failed to parse jobs from DB in getAllJobs");
        return [];
      }

      return parsed.data;
    });

    return results;
  }

  public async getJob(name: string, scope?: string): Promise<TOption<TCronEngineJob>> {
    const res = await this.queue.enqueue(async () => {
      return this.getJobByNormalizedScope(name, this.normalizeScope(scope));
    });

    if (!res) {
      return undefined;
    }

    return res;
  }

  public destroy() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = undefined;
    }
  }

  public async tick() {
    if (this.isTicking) {
      return;
    }

    this.isTicking = true;

    try {
      const now = Date.now();

      const jobs = await this.queue.enqueue(async () => {
        const results = await this.db
          .select()
          .from(cronEngineJobsTable)
          .where(lte(cronEngineJobsTable.nextRunAt, now));

        const parsed = z.array(SCronEngineJob).safeParse(results);
        if (!parsed.success) {
          this.logger.error("Failed to parse jobs from DB during tick");
          return [];
        }

        return parsed.data;
      });

      for (const job of jobs) {
        try {
          if (job.type === ECronEngineJobType.Recurring && job.pattern) {
            const nextRun = getNextFireTime(job.pattern, new Date(now), this.timezone);
            await this.queue.enqueue(async () => {
              await this.db
                .update(cronEngineJobsTable)
                .set({
                  nextRunAt: nextRun.getTime(),
                  lastRunAt: now,
                })
                .where(
                  and(
                    eq(cronEngineJobsTable.name, job.name),
                    eq(cronEngineJobsTable.scope, this.normalizeScope(job.scope)),
                  ),
                );
            });
          } else if (job.type === ECronEngineJobType.OneTime) {
            await this.queue.enqueue(async () => {
              await this.db
                .delete(cronEngineJobsTable)
                .where(
                  and(
                    eq(cronEngineJobsTable.name, job.name),
                    eq(cronEngineJobsTable.scope, this.normalizeScope(job.scope)),
                  ),
                );
            });
          }

          const ctx: TCronEngineJobContext = {
            name: job.name,
            scope: job.scope,
            group: job.group,
            type: job.type,
            pattern: job.pattern,
            reminderText: job.reminderText,
            reminderPromptData: job.reminderPromptData,
            reminderFallbackText: job.reminderFallbackText,
            lastRunAt: job.lastRunAt,
            nextRunAt: job.nextRunAt,
            createdAt: job.createdAt,
          };

          this.emit(CronEngine.FIRE_EVENT, ctx);
          if (!isReservedCronJobEventName(job.name)) {
            this.emit(job.name, ctx);
          }
        } catch (error) {
          this.logger.error(`Failed to process job '${job.name}' during tick: ${String(error)}`);
        }
      }
    } finally {
      this.isTicking = false;
    }
  }

  private normalizeScope(scope: TOption<string>) {
    return scope ?? "";
  }

  private createDuplicateJobError(name: string): TCronEngineError {
    return {
      operation: "schedule",
      error: `Job '${name}' already exists. Set overwrite: true to replace.`,
    };
  }

  private createCrossTypeScheduleError(
    name: string,
    existingType: ECronEngineJobType,
  ): TCronEngineError {
    if (existingType === ECronEngineJobType.OneTime) {
      return {
        operation: "schedule",
        error: `A one-time job named '${name}' already exists. Unschedule it first.`,
      };
    }

    return {
      operation: "schedule",
      error: `A recurring job named '${name}' already exists. Unschedule it first.`,
    };
  }

  private createUnschedulablePatternError(pattern: string, error: unknown): TCronEngineError {
    return {
      operation: "schedule",
      error: `Cron pattern '${pattern}' is valid but cannot be scheduled: ${String(error)}`,
    };
  }

  private createScheduledJobReadbackError(): TCronEngineError {
    return { operation: "schedule", error: "Failed to read back scheduled job" };
  }

  private createReservedJobNameError(name: string): TCronEngineError {
    return { operation: "schedule", error: `Job name '${name}' is reserved by EventEmitter` };
  }

  private parseJobRow(row: unknown): TOption<TCronEngineJob> {
    const parsed = SCronEngineJob.safeParse(row);
    if (!parsed.success) {
      return undefined;
    }

    return parsed.data;
  }

  private async getJobByNormalizedScope(
    name: string,
    normalizedScope: string,
  ): Promise<TOption<TCronEngineJob>> {
    const row = await this.db
      .select()
      .from(cronEngineJobsTable)
      .where(
        and(eq(cronEngineJobsTable.name, name), eq(cronEngineJobsTable.scope, normalizedScope)),
      )
      .get();

    return this.parseJobRow(row);
  }
}
