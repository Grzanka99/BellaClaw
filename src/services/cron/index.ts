import { EventEmitter } from "node:events";
import { z } from "zod";
import {
  CronEngine,
  ECronEngineJobType,
  type TCronEngineJob,
  type TCronEngineJobContext,
} from "../../lib/cron-engine";
import type { TOption } from "../../types";
import { createLogger, type TLogger } from "../../utils/logger";
import {
  ECronJobType,
  type TCronError,
  type TCronJob,
  type TJobContext,
  type TScheduleArgs,
  type TScheduleOnceArgs,
} from "./types";

const SCronServiceData = z.object({
  group: z.string().optional(),
});

type TCronServiceData = z.infer<typeof SCronServiceData>;

export class CronSingleton extends EventEmitter {
  private static _instance: TOption<CronSingleton>;
  private static DEFAULT_DB_FILE = "cron-engine.db";
  private static dbFile = CronSingleton.DEFAULT_DB_FILE;
  private engine: CronEngine;
  private logger: TLogger = createLogger("CRON");

  private constructor() {
    super();

    this.engine = new CronEngine({
      dbFile: CronSingleton.dbFile,
      logger: this.logger,
    });

    this.engine.on("fire", (ctx: TCronEngineJobContext) => {
      this.emit(ctx.name, this.toJobContext(ctx));
    });
  }

  public static get instance() {
    if (!CronSingleton._instance) {
      CronSingleton._instance = new CronSingleton();
    }

    return CronSingleton._instance;
  }

  public static setDbFile(dbFile: string) {
    if (CronSingleton._instance) {
      throw new Error("Cannot change cron DB file while CronSingleton instance is active");
    }

    CronSingleton.dbFile = dbFile;
  }

  public static resetDbFile() {
    if (CronSingleton._instance) {
      throw new Error("Cannot reset cron DB file while CronSingleton instance is active");
    }

    CronSingleton.dbFile = CronSingleton.DEFAULT_DB_FILE;
  }

  public setup(pollIntervalMs = 10_000) {
    this.engine.setup(pollIntervalMs);
  }

  public async schedule(args: TScheduleArgs): Promise<TCronJob | TCronError> {
    const result = await this.engine.schedule({
      name: args.name,
      scope: args.userId,
      data: this.serializeData(args.group),
      pattern: args.pattern,
      overwrite: args.overwrite,
    });

    if ("error" in result) {
      return result;
    }

    return this.toCronJob(result);
  }

  public async scheduleOnce(args: TScheduleOnceArgs): Promise<TCronJob | TCronError> {
    const result = await this.engine.scheduleOnce({
      name: args.name,
      scope: args.userId,
      data: this.serializeData(args.group),
      fireAt: args.fireAt,
      overwrite: args.overwrite,
    });

    if ("error" in result) {
      return result;
    }

    return this.toCronJob(result);
  }

  public async unschedule(name: string, userId: string): Promise<TCronJob | TCronError> {
    const result = await this.engine.unschedule(name, userId);
    if ("error" in result) {
      return result;
    }

    return this.toCronJob(result);
  }

  public async getAllJobs(userId: string): Promise<TCronJob[]> {
    const jobs = await this.engine.getAllJobs(userId);
    return jobs.map((job) => this.toCronJob(job));
  }

  public async getJob(name: string, userId: string): Promise<TOption<TCronJob>> {
    const job = await this.engine.getJob(name, userId);
    if (!job) {
      return undefined;
    }

    return this.toCronJob(job);
  }

  public destroy() {
    this.engine.destroy();
    CronSingleton._instance = undefined;
  }

  private toCronJob(job: TCronEngineJob): TCronJob {
    const data = this.deserializeData(job.data);

    return {
      id: job.id,
      name: job.name,
      userId: this.toUserId(job.scope, job.name),
      group: data.group,
      type: this.toCronJobType(job.type),
      pattern: job.pattern ?? null,
      nextRunAt: job.nextRunAt,
      lastRunAt: job.lastRunAt ?? null,
      createdAt: job.createdAt,
    };
  }

  private toJobContext(ctx: TCronEngineJobContext): TJobContext {
    const data = this.deserializeData(ctx.data);

    return {
      name: ctx.name,
      userId: this.toUserId(ctx.scope, ctx.name),
      group: data.group,
      type: this.toCronJobType(ctx.type),
      pattern: ctx.pattern,
      lastRunAt: ctx.lastRunAt,
      nextRunAt: ctx.nextRunAt,
    };
  }

  private toCronJobType(type: ECronEngineJobType): ECronJobType {
    if (type === ECronEngineJobType.Recurring) {
      return ECronJobType.Recurring;
    }

    return ECronJobType.OneTime;
  }

  private toUserId(scope: TOption<string>, jobName: string): string {
    if (scope === undefined) {
      this.logger.warning(`Cron job '${jobName}' is missing scope; falling back to empty userId`);
      return "";
    }

    return scope;
  }

  private serializeData(group: TOption<string>): TOption<string> {
    if (group === undefined) {
      return undefined;
    }

    return JSON.stringify({ group });
  }

  private deserializeData(data: TOption<string>): TCronServiceData {
    if (data === undefined) {
      return { group: undefined };
    }

    let parsedJson: unknown;

    try {
      parsedJson = JSON.parse(data);
    } catch {
      this.logger.warning(`Failed to parse cron job data: ${data}`);
      return { group: undefined };
    }

    const parsed = SCronServiceData.safeParse(parsedJson);
    if (!parsed.success) {
      this.logger.warning(`Failed to validate cron job data: ${data}`);
      return { group: undefined };
    }

    return parsed.data;
  }
}
