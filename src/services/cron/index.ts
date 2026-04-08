import { Database } from "bun:sqlite";
import { EventEmitter } from "node:events";
import { z } from "zod";
import type { TOption } from "../../types";
import { AsyncQueue } from "../../utils/async-queue";
import { createLogger, type TLogger } from "../../utils/logger";
import { getNextFireTime, isValidCron } from "./parser";
import {
  ECronJobType,
  SCronJob,
  type TCronError,
  type TCronJob,
  type TJobContext,
  type TScheduleArgs,
  type TScheduleOnceArgs,
} from "./types";

const CREATE_CRON_JOBS_TABLE = `
  CREATE TABLE IF NOT EXISTS cron_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    "group" TEXT,
    type TEXT NOT NULL,
    pattern TEXT,
    nextRunAt INTEGER NOT NULL,
    lastRunAt INTEGER,
    createdAt INTEGER NOT NULL
  )
`;

export class CronSingleton extends EventEmitter {
  private static _instance: TOption<CronSingleton>;
  private static DB_FILE = "cron.db";
  private db: Database;
  private queue: AsyncQueue;
  private logger: TLogger = createLogger("CRON");
  private tickInterval: TOption<Timer>;

  private constructor() {
    super();
    this.queue = new AsyncQueue();
    this.db = new Database(CronSingleton.DB_FILE);

    this.queue.enqueue(async () => {
      this.db.run(CREATE_CRON_JOBS_TABLE);
    });
  }

  public static get instance() {
    if (!CronSingleton._instance) {
      CronSingleton._instance = new CronSingleton();
    }
    return CronSingleton._instance;
  }

  public setup(pollIntervalMs = 10_000) {
    this.tickInterval = setInterval(() => this.tick(), pollIntervalMs);
    this.tick();
  }

  private async tick() {
    const now = Date.now();

    const jobs = await this.queue.enqueue(async () => {
      const results = this.db
        .query("SELECT * FROM cron_jobs WHERE nextRunAt <= $now")
        .all({ $now: now });

      const parsed = z.array(SCronJob).safeParse(results);
      if (!parsed.success) {
        this.logger.error("Failed to parse jobs from DB during tick");
        return [];
      }
      return parsed.data;
    });

    for (const job of jobs) {
      try {
        if (job.type === ECronJobType.Recurring && job.pattern) {
          const nextRun = getNextFireTime(job.pattern, new Date(now));
          await this.queue.enqueue(async () => {
            this.db
              .query(
                "UPDATE cron_jobs SET nextRunAt = $nextRunAt, lastRunAt = $lastRunAt WHERE name = $name",
              )
              .run({ $nextRunAt: nextRun.getTime(), $lastRunAt: now, $name: job.name });
          });
        } else if (job.type === ECronJobType.OneTime) {
          await this.queue.enqueue(async () => {
            this.db.query("DELETE FROM cron_jobs WHERE name = $name").run({ $name: job.name });
          });
        }

        const ctx: TJobContext = {
          name: job.name,
          group: job.group,
          type: job.type,
          pattern: job.pattern ?? undefined,
          lastRunAt: job.lastRunAt ? new Date(job.lastRunAt) : undefined,
          nextRunAt: new Date(job.nextRunAt),
        };
        this.emit(job.name, ctx);
      } catch (error) {
        this.logger.error(`Failed to process job '${job.name}' during tick: ${String(error)}`);
      }
    }
  }

  public async schedule(args: TScheduleArgs): Promise<TCronJob | TCronError> {
    if (!isValidCron(args.pattern)) {
      return { operation: "schedule", error: `Invalid cron pattern: ${args.pattern}` };
    }

    const existing = await this.getJob(args.name);
    if (existing && existing.type === ECronJobType.OneTime) {
      return {
        operation: "schedule",
        error: `A one-time job named '${args.name}' already exists. Unscheduled it first.`,
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
            `INSERT INTO cron_jobs (name, "group", type, pattern, nextRunAt, lastRunAt, createdAt)
             VALUES ($name, $group, $type, $pattern, $nextRunAt, $lastRunAt, $createdAt)
             ON CONFLICT(name) DO UPDATE SET
               "group" = $group, type = $type, pattern = $pattern, nextRunAt = $nextRunAt, lastRunAt = $lastRunAt, createdAt = $createdAt`,
          )
          .run({
            $name: args.name,
            $group: args.group ?? null,
            $type: ECronJobType.Recurring,
            $pattern: args.pattern,
            $nextRunAt: nextRunAt.getTime(),
            $lastRunAt: null,
            $createdAt: now,
          });
      });

      const job = await this.getJob(args.name);
      if (!job) {
        return { operation: "schedule", error: "Failed to read back scheduled job" };
      }
      return job;
    } catch (error) {
      this.logger.error(`Failed to schedule job: ${String(error)}`);
      return { operation: "schedule", error };
    }
  }

  public async scheduleOnce(args: TScheduleOnceArgs): Promise<TCronJob | TCronError> {
    const now = new Date();
    if (args.fireAt <= now) {
      return { operation: "schedule", error: "fireAt must be in the future" };
    }

    const existing = await this.getJob(args.name);
    if (existing && existing.type === ECronJobType.Recurring) {
      return {
        operation: "schedule",
        error: `A recurring job named '${args.name}' already exists. Unscheduled it first.`,
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
            `INSERT INTO cron_jobs (name, "group", type, pattern, nextRunAt, lastRunAt, createdAt)
             VALUES ($name, $group, $type, $pattern, $nextRunAt, $lastRunAt, $createdAt)
             ON CONFLICT(name) DO UPDATE SET
               "group" = $group, type = $type, pattern = $pattern, nextRunAt = $nextRunAt, lastRunAt = $lastRunAt, createdAt = $createdAt`,
          )
          .run({
            $name: args.name,
            $group: args.group ?? null,
            $type: ECronJobType.OneTime,
            $pattern: null,
            $nextRunAt: args.fireAt.getTime(),
            $lastRunAt: null,
            $createdAt: Date.now(),
          });
      });

      const job = await this.getJob(args.name);
      if (!job) {
        return { operation: "schedule", error: "Failed to read back scheduled job" };
      }
      return job;
    } catch (error) {
      this.logger.error(`Failed to schedule one-time job: ${String(error)}`);
      return { operation: "schedule", error };
    }
  }

  public async unschedule(name: string): Promise<TCronJob | TCronError> {
    try {
      const res = await this.queue.enqueue(async () => {
        const row = this.db
          .query("DELETE FROM cron_jobs WHERE name = $name RETURNING *")
          .get({ $name: name });

        const parsed = SCronJob.safeParse(row);
        if (!parsed.success) {
          return undefined;
        }
        return parsed.data;
      });

      if (!res) {
        return { operation: "unschedule", error: `No job found with name: ${name}` };
      }

      return {
        id: res.id,
        name: res.name,
        group: res.group,
        type: res.type,
        pattern: res.pattern,
        nextRunAt: new Date(res.nextRunAt),
        lastRunAt: res.lastRunAt ? new Date(res.lastRunAt) : null,
        createdAt: new Date(res.createdAt),
      };
    } catch (error) {
      this.logger.error(`Failed to unschedule job: ${String(error)}`);
      return { operation: "unschedule", error };
    }
  }

  public async getJob(name: string): Promise<TOption<TCronJob>> {
    const res = await this.queue.enqueue(async () => {
      const row = this.db.query("SELECT * FROM cron_jobs WHERE name = $name").get({ $name: name });

      const parsed = SCronJob.safeParse(row);
      if (!parsed.success) {
        return undefined;
      }
      return parsed.data;
    });

    if (!res) return undefined;

    return {
      id: res.id,
      name: res.name,
      group: res.group,
      type: res.type,
      pattern: res.pattern,
      nextRunAt: new Date(res.nextRunAt),
      lastRunAt: res.lastRunAt ? new Date(res.lastRunAt) : null,
      createdAt: new Date(res.createdAt),
    };
  }

  public async getAllJobs(): Promise<TCronJob[] | TCronError> {
    try {
      const res = await this.queue.enqueue(async () => {
        const results = this.db.query("SELECT * FROM cron_jobs ORDER BY nextRunAt ASC").all();

        const parsed = z.array(SCronJob).safeParse(results);
        if (!parsed.success) {
          this.logger.error("Failed to parse jobs from DB");
          return [];
        }
        return parsed.data;
      });

      return res.map((row) => ({
        id: row.id,
        name: row.name,
        group: row.group,
        type: row.type,
        pattern: row.pattern,
        nextRunAt: new Date(row.nextRunAt),
        lastRunAt: row.lastRunAt ? new Date(row.lastRunAt) : null,
        createdAt: new Date(row.createdAt),
      }));
    } catch (error) {
      this.logger.error(`Failed to get all jobs: ${String(error)}`);
      return { operation: "read", error };
    }
  }

  public destroy() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = undefined;
    }
    this.db.close();
    CronSingleton._instance = undefined;
  }
}
