import { Database } from "bun:sqlite";
import { EventEmitter } from "node:events";
import { z } from "zod";
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

const DEFAULT_TABLE_NAME = "cron_engine_jobs";

export * from "./parser";
export * from "./types";

export class CronEngine extends EventEmitter {
  private db: Database;
  private queue: AsyncQueue;
  private logger = createLogger("CRON ENGINE");
  private tableName: string;
  private tickInterval: TOption<ReturnType<typeof setInterval>>;

  public constructor(options: TCronEngineOptions) {
    super();

    this.tableName = CronEngine.validateTableName(options.tableName ?? DEFAULT_TABLE_NAME);
    this.queue = new AsyncQueue();
    this.db = new Database(options.dbFile);

    this.queue.enqueue(async () => {
      this.db.run(this.createTableQuery());
    });
  }

  public setup(pollIntervalMs = 10_000) {
    if (this.tickInterval) {
      return;
    }

    this.tickInterval = setInterval(() => this.tick(), pollIntervalMs);
    this.tick();
  }

  public async schedule(args: TScheduleRecurringArgs): Promise<TCronEngineJob | TCronEngineError> {
    if (!isValidCron(args.pattern)) {
      return { operation: "schedule", error: `Invalid cron pattern: ${args.pattern}` };
    }

    const normalizedScope = this.normalizeScope(args.scope);
    const scheduledAt = new Date();
    let nextRunAt: Date;
    try {
      nextRunAt = getNextFireTime(args.pattern, scheduledAt);
    } catch (error) {
      return this.createUnschedulablePatternError(args.pattern, error);
    }

    try {
      return await this.queue.enqueue(async () => {
        const existing = this.getJobByNormalizedScope(args.name, normalizedScope);

        if (existing && existing.type !== ECronEngineJobType.Recurring) {
          return this.createCrossTypeScheduleError(args.name, existing.type);
        }

        if (existing && args.overwrite !== true) {
          return this.createDuplicateJobError(args.name);
        }

        const rowParams = {
          $name: args.name,
          $scope: normalizedScope,
          $group: args.group ?? null,
          $type: ECronEngineJobType.Recurring,
          $pattern: args.pattern,
          $reminderText: args.reminderText ?? null,
          $reminderPromptData: args.reminderPromptData ?? null,
          $reminderFallbackText: args.reminderFallbackText ?? args.reminderText ?? null,
          $nextRunAt: nextRunAt.getTime(),
          $lastRunAt: null,
          $createdAt: scheduledAt.getTime(),
        };

        if (args.overwrite === true) {
          const row = this.db
            .query(
              `INSERT INTO ${this.tableName} (name, scope, "group", type, pattern, nextRunAt, lastRunAt, createdAt, reminderText, reminderPromptData, reminderFallbackText)
               VALUES ($name, $scope, $group, $type, $pattern, $nextRunAt, $lastRunAt, $createdAt, $reminderText, $reminderPromptData, $reminderFallbackText)
                ON CONFLICT(name, scope) DO UPDATE SET
                 "group" = $group, type = $type, pattern = $pattern, nextRunAt = $nextRunAt, lastRunAt = $lastRunAt, createdAt = $createdAt,
                 reminderText = $reminderText, reminderPromptData = $reminderPromptData, reminderFallbackText = $reminderFallbackText
                WHERE type = $type
                RETURNING *`,
            )
            .get(rowParams);

          const job = this.parseJobRow(row);
          if (job) {
            return job;
          }

          const currentJob = this.getJobByNormalizedScope(args.name, normalizedScope);
          if (currentJob) {
            return this.createCrossTypeScheduleError(args.name, currentJob.type);
          }

          return this.createScheduledJobReadbackError();
        }

        try {
          const row = this.db
            .query(
              `INSERT INTO ${this.tableName} (name, scope, "group", type, pattern, nextRunAt, lastRunAt, createdAt, reminderText, reminderPromptData, reminderFallbackText)
               VALUES ($name, $scope, $group, $type, $pattern, $nextRunAt, $lastRunAt, $createdAt, $reminderText, $reminderPromptData, $reminderFallbackText)
                RETURNING *`,
            )
            .get(rowParams);

          const job = this.parseJobRow(row);
          if (job) {
            return job;
          }

          return this.createScheduledJobReadbackError();
        } catch (error) {
          const currentJob = this.getJobByNormalizedScope(args.name, normalizedScope);
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
    const now = new Date();
    if (args.fireAt <= now) {
      return { operation: "schedule", error: "fireAt must be in the future" };
    }

    const normalizedScope = this.normalizeScope(args.scope);

    try {
      return await this.queue.enqueue(async () => {
        const existing = this.getJobByNormalizedScope(args.name, normalizedScope);

        if (existing && existing.type !== ECronEngineJobType.OneTime) {
          return this.createCrossTypeScheduleError(args.name, existing.type);
        }

        if (existing && args.overwrite !== true) {
          return this.createDuplicateJobError(args.name);
        }

        const rowParams = {
          $name: args.name,
          $scope: normalizedScope,
          $group: args.group ?? null,
          $type: ECronEngineJobType.OneTime,
          $pattern: null,
          $reminderText: args.reminderText ?? null,
          $reminderPromptData: args.reminderPromptData ?? null,
          $reminderFallbackText: args.reminderFallbackText ?? args.reminderText ?? null,
          $nextRunAt: args.fireAt.getTime(),
          $lastRunAt: null,
          $createdAt: Date.now(),
        };

        if (args.overwrite === true) {
          const row = this.db
            .query(
              `INSERT INTO ${this.tableName} (name, scope, "group", type, pattern, nextRunAt, lastRunAt, createdAt, reminderText, reminderPromptData, reminderFallbackText)
               VALUES ($name, $scope, $group, $type, $pattern, $nextRunAt, $lastRunAt, $createdAt, $reminderText, $reminderPromptData, $reminderFallbackText)
                ON CONFLICT(name, scope) DO UPDATE SET
                 "group" = $group, type = $type, pattern = $pattern, nextRunAt = $nextRunAt, lastRunAt = $lastRunAt, createdAt = $createdAt,
                 reminderText = $reminderText, reminderPromptData = $reminderPromptData, reminderFallbackText = $reminderFallbackText
                WHERE type = $type
                RETURNING *`,
            )
            .get(rowParams);

          const job = this.parseJobRow(row);
          if (job) {
            return job;
          }

          const currentJob = this.getJobByNormalizedScope(args.name, normalizedScope);
          if (currentJob) {
            return this.createCrossTypeScheduleError(args.name, currentJob.type);
          }

          return this.createScheduledJobReadbackError();
        }

        try {
          const row = this.db
            .query(
              `INSERT INTO ${this.tableName} (name, scope, "group", type, pattern, nextRunAt, lastRunAt, createdAt, reminderText, reminderPromptData, reminderFallbackText)
               VALUES ($name, $scope, $group, $type, $pattern, $nextRunAt, $lastRunAt, $createdAt, $reminderText, $reminderPromptData, $reminderFallbackText)
                RETURNING *`,
            )
            .get(rowParams);

          const job = this.parseJobRow(row);
          if (job) {
            return job;
          }

          return this.createScheduledJobReadbackError();
        } catch (error) {
          const currentJob = this.getJobByNormalizedScope(args.name, normalizedScope);
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
        const row = this.db
          .query(`DELETE FROM ${this.tableName} WHERE name = $name AND scope = $scope RETURNING *`)
          .get({ $name: name, $scope: this.normalizeScope(scope) });

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
      const rows =
        scope === undefined
          ? this.db.query(`SELECT * FROM ${this.tableName} ORDER BY nextRunAt ASC`).all()
          : this.db
              .query(`SELECT * FROM ${this.tableName} WHERE scope = $scope ORDER BY nextRunAt ASC`)
              .all({ $scope: this.normalizeScope(scope) });

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

    this.db.close();
  }

  public async tick() {
    const now = Date.now();

    const jobs = await this.queue.enqueue(async () => {
      const results = this.db
        .query(`SELECT * FROM ${this.tableName} WHERE nextRunAt <= $now`)
        .all({ $now: now });

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
          const nextRun = getNextFireTime(job.pattern, new Date(now));
          await this.queue.enqueue(async () => {
            this.db
              .query(
                `UPDATE ${this.tableName} SET nextRunAt = $nextRunAt, lastRunAt = $lastRunAt WHERE name = $name AND scope = $scope`,
              )
              .run({
                $nextRunAt: nextRun.getTime(),
                $lastRunAt: now,
                $name: job.name,
                $scope: this.normalizeScope(job.scope),
              });
          });
        } else if (job.type === ECronEngineJobType.OneTime) {
          await this.queue.enqueue(async () => {
            this.db
              .query(`DELETE FROM ${this.tableName} WHERE name = $name AND scope = $scope`)
              .run({
                $name: job.name,
                $scope: this.normalizeScope(job.scope),
              });
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

        this.emit(job.name, ctx);
        this.emit("fire", ctx);
      } catch (error) {
        this.logger.error(`Failed to process job '${job.name}' during tick: ${String(error)}`);
      }
    }
  }

  private createTableQuery() {
    return `
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        scope TEXT NOT NULL,
        "group" TEXT,
        type TEXT NOT NULL,
        pattern TEXT,
        reminderText TEXT,
        reminderPromptData TEXT,
        reminderFallbackText TEXT,
        nextRunAt INTEGER NOT NULL,
        lastRunAt INTEGER,
        createdAt INTEGER NOT NULL,
        UNIQUE(name, scope)
      )
    `;
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

  private parseJobRow(row: unknown): TOption<TCronEngineJob> {
    const parsed = SCronEngineJob.safeParse(row);
    if (!parsed.success) {
      return undefined;
    }

    return parsed.data;
  }

  private getJobByNormalizedScope(name: string, normalizedScope: string): TOption<TCronEngineJob> {
    const row = this.db
      .query(`SELECT * FROM ${this.tableName} WHERE name = $name AND scope = $scope`)
      .get({ $name: name, $scope: normalizedScope });

    return this.parseJobRow(row);
  }

  private static validateTableName(tableName: string) {
    const isValid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName);
    if (!isValid) {
      throw new Error(`Invalid cron engine table name: ${tableName}`);
    }

    return tableName;
  }
}
