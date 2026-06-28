import { Config } from "../../config";
import { CronScheduler, type TCronJobContext } from "../../lib/cron-engine";
import type { TOption } from "../../types";

export class CronSingleton extends CronScheduler {
  private static _instance: TOption<CronSingleton>;

  private constructor() {
    super({
      timezone: Config.ai.instructions.timezone,
    });
  }

  public static get instance() {
    if (!CronSingleton._instance) {
      CronSingleton._instance = new CronSingleton();
    }

    return CronSingleton._instance;
  }

  public onCronEvent(listener: (ctx: TCronJobContext) => void) {
    return this.onFire(listener);
  }

  public override destroy() {
    super.destroy();
    CronSingleton._instance = undefined;
  }
}
