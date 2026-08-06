import type { TOption } from "@bellaclaw/shared";
import { Config } from "../../config";
import { CronScheduler } from "../../lib/cron-engine";

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

  public override destroy() {
    super.destroy();
    CronSingleton._instance = undefined;
  }
}
