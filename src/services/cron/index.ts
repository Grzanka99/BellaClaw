import { EventEmitter } from "node:events";
import { Config } from "../../config";
import {
  CronEngine,
  isReservedCronJobEventName,
  type TCronEngineError,
  type TCronEngineJob,
  type TCronEngineJobContext,
  type TScheduleOnceArgs,
  type TScheduleRecurringArgs,
} from "../../lib/cron-engine";
import type { TOption } from "../../types";

export class CronSingleton extends EventEmitter {
  private static readonly CRON_EVENT = Symbol("cron-event");
  private static _instance: TOption<CronSingleton>;
  private engine: CronEngine;

  private constructor() {
    super();

    this.engine = new CronEngine({
      timezone: Config.ai.instructions.timezone,
    });

    this.engine.onFire((ctx: TCronEngineJobContext) => {
      this.emit(CronSingleton.CRON_EVENT, ctx);
      if (!isReservedCronJobEventName(ctx.name)) {
        this.emit(ctx.name, ctx);
      }
    });
  }

  public static get instance() {
    if (!CronSingleton._instance) {
      CronSingleton._instance = new CronSingleton();
    }

    return CronSingleton._instance;
  }

  public setup(pollIntervalMs = 10_000) {
    this.engine.setup(pollIntervalMs);
  }

  public onCronEvent(listener: (ctx: TCronEngineJobContext) => void) {
    return this.on(CronSingleton.CRON_EVENT, listener);
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
