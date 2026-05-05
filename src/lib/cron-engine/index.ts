import { Database } from "bun:sqlite";
import { EventEmitter } from "node:events";
import { z } from "zod";
import type { TOption } from "../../types";
import { AsyncQueue } from "../../utils/async-queue";
import { getNextFireTime, isValidCron } from "./parser";
import {
  ECronEngineJobType,
  SCronEngineJob,
  type TCronEngineError,
  type TCronEngineJob,
  type TCronEngineJobContext,
  type TCronEngineLogger,
  type TCronEngineOptions,
  type TScheduleOnceArgs,
  type TScheduleRecurringArgs,
} from "./types";

const DEFAULT_TABLE_NAME = "cron_engine_jobs";

const NOOP_LOGGER: TCronEngineLogger = {
  info: () => {},
  warning: () => {},
  error: () => {},
  message: () => {},
};

export * from "./parser";
export * from "./types";

export class CronEngine extends EventEmitter {
  private db: Database;
  private queue: AsyncQueue;
  private logger: TCronEngineLogger;
  private tableName: string;
  private tickInterval: TOption<ReturnType<typeof setInterval>>;

  public constructor(options: TCronEngineOptions) {
    super();

    this.tableName = CronEngine.validateTableName(options.tableName ?? DEFAULT_TABLE_NAME);
    this.queue = new AsyncQueue();
    this.db = new Database(options.dbFile);
    this.logger = options.logger ?? NOOP_LOGGER;

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

    const existing = await this.getJob(args.name, args.scope);
    if (existing && existing.type === ECronEngineJobType.OneTime) {
      return {
        operation: "schedule",
        error: `A one-time job named '${args.name}' already exists. Unschedule it first.`,
      };
    }

    if (existing && args.overwrite !== true) {
      return {
        operation: "schedule",
        error: `Job '${args.name}' already exists. Set overwrite: true to replace.`,
      };
    }

    const nextRunAt = getNextFireTime(args.pattern, new Date());
    const now = Date.now();

    try {
      await this.queue.enqueue(async () => {
        this.db
          .query(
            `INSERT INTO ${this.tableName} (name, scope, data, type, pattern, nextRunAt, lastRunAt, createdAt)
             VALUES ($name, $scope, $data, $type, $pattern, $nextRunAt, $lastRunAt, $createdAt)
             ON CONFLICT(name, scope) DO UPDATE SET
               data = $data, type = $type, pattern = $pattern, nextRunAt = $nextRunAt, lastRunAt = $lastRunAt, createdAt = $createdAt`,
          )
          .run({
            $name: args.name,
            $scope: this.normalizeScope(args.scope),
            $data: args.data ?? null,
            $type: ECronEngineJobType.Recurring,
            $pattern: args.pattern,
            $nextRunAt: nextRunAt.getTime(),
            $lastRunAt: null,
            $createdAt: now,
          });
      });

      const job = await this.getJob(args.name, args.scope);
      if (!job) {
        return { operation: "schedule", error: "Failed to read back scheduled job" };
      }

      return job;
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

    const existing = await this.getJob(args.name, args.scope);
    if (existing && existing.type === ECronEngineJobType.Recurring) {
      return {
        operation: "schedule",
        error: `A recurring job named '${args.name}' already exists. Unschedule it first.`,
      };
    }

    if (existing && args.overwrite !== true) {
      return {
        operation: "schedule",
        error: `Job '${args.name}' already exists. Set overwrite: true to replace.`,
      };
    }

    try {
      await this.queue.enqueue(async () => {
        this.db
          .query(
            `INSERT INTO ${this.tableName} (name, scope, data, type, pattern, nextRunAt, lastRunAt, createdAt)
             VALUES ($name, $scope, $data, $type, $pattern, $nextRunAt, $lastRunAt, $createdAt)
             ON CONFLICT(name, scope) DO UPDATE SET
               data = $data, type = $type, pattern = $pattern, nextRunAt = $nextRunAt, lastRunAt = $lastRunAt, createdAt = $createdAt`,
          )
          .run({
            $name: args.name,
            $scope: this.normalizeScope(args.scope),
            $data: args.data ?? null,
            $type: ECronEngineJobType.OneTime,
            $pattern: null,
            $nextRunAt: args.fireAt.getTime(),
            $lastRunAt: null,
            $createdAt: Date.now(),
          });
      });

      const job = await this.getJob(args.name, args.scope);
      if (!job) {
        return { operation: "schedule", error: "Failed to read back scheduled job" };
      }

      return job;
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

        const parsed = SCronEngineJob.safeParse(row);
        if (!parsed.success) {
          return undefined;
        }

        return parsed.data;
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
      const row = this.db
        .query(`SELECT * FROM ${this.tableName} WHERE name = $name AND scope = $scope`)
        .get({ $name: name, $scope: this.normalizeScope(scope) });

      const parsed = SCronEngineJob.safeParse(row);
      if (!parsed.success) {
        return undefined;
      }

      return parsed.data;
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
          data: job.data,
          type: job.type,
          pattern: job.pattern,
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
        data TEXT,
        type TEXT NOT NULL,
        pattern TEXT,
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

  private static validateTableName(tableName: string) {
    const isValid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName);
    if (!isValid) {
      throw new Error(`Invalid cron engine table name: ${tableName}`);
    }

    return tableName;
  }
}
