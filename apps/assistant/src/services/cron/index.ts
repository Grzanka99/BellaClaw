import type { TOption } from "@bellaclaw/shared";
import { CronScheduler } from "../../lib/cron-engine";
import { DefaultConfigRecord, EConfigKey } from "../settings/schema";

export class CronSingleton extends CronScheduler {
  private static _instance: TOption<CronSingleton>;

  private constructor() {
    super({
      timezone: DefaultConfigRecord[EConfigKey.AiInstructionsTimezone],
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
