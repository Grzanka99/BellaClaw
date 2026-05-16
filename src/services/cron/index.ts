import { EventEmitter } from "node:events";
import {
  CronEngine,
  type TCronEngineError,
  type TCronEngineJob,
  type TCronEngineJobContext,
  type TScheduleOnceArgs,
  type TScheduleRecurringArgs,
} from "../../lib/cron-engine";
import type { TOption } from "../../types";
import { createLogger, type TLogger } from "../../utils/logger";

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
      this.emit(ctx.name, ctx);
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

  public async schedule(args: TScheduleRecurringArgs): Promise<TCronEngineJob | TCronEngineError> {
    return this.engine.schedule(args);
  }

  public async scheduleOnce(args: TScheduleOnceArgs): Promise<TCronEngineJob | TCronEngineError> {
    return this.engine.scheduleOnce(args);
  }

  public async unschedule(name: string, scope: string): Promise<TCronEngineJob | TCronEngineError> {
    return this.engine.unschedule(name, scope);
  }

  public async getAllJobs(scope: string): Promise<TCronEngineJob[]> {
    return this.engine.getAllJobs(scope);
  }

  public async getJob(name: string, scope: string): Promise<TOption<TCronEngineJob>> {
    return this.engine.getJob(name, scope);
  }

  public destroy() {
    this.engine.destroy();
    CronSingleton._instance = undefined;
  }
}
