import { EventEmitter } from "node:events";
import { Config } from "../../config";
import {
  CronScheduler,
  isReservedCronJobEventName,
  type TCreateOnceArgs,
  type TCreateRecurringArgs,
  type TCronJob,
  type TCronJobContext,
  type TCronSchedulerError,
} from "../../lib/cron-engine";
import type { TOption } from "../../types";

export class CronSingleton extends EventEmitter {
  private static readonly CRON_EVENT = Symbol("cron-event");
  private static _instance: TOption<CronSingleton>;
  private scheduler: CronScheduler;

  private constructor() {
    super();

    this.scheduler = new CronScheduler({
      timezone: Config.ai.instructions.timezone,
    });

    this.scheduler.onFire((ctx: TCronJobContext) => {
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

  public async setup() {
    await this.scheduler.setup();
  }

  public onCronEvent(listener: (ctx: TCronJobContext) => void) {
    return this.on(CronSingleton.CRON_EVENT, listener);
  }

  public async createRecurring(
    args: TCreateRecurringArgs,
  ): Promise<TCronJob | TCronSchedulerError> {
    return this.scheduler.createRecurring(args);
  }

  public async createOnce(args: TCreateOnceArgs): Promise<TCronJob | TCronSchedulerError> {
    return this.scheduler.createOnce(args);
  }

  public async cancel(name: string, scope: string): Promise<TCronJob | TCronSchedulerError> {
    return this.scheduler.cancel(name, scope);
  }

  public async list(scope: string): Promise<TCronJob[]> {
    return this.scheduler.list(scope);
  }

  public async get(name: string, scope: string): Promise<TOption<TCronJob>> {
    return this.scheduler.get(name, scope);
  }

  public destroy() {
    this.scheduler.destroy();
    CronSingleton._instance = undefined;
  }
}
