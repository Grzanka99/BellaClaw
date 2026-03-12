import { Logger } from "../../utils/logger";

export class CronSingleton extends Logger {
  private static _instance: CronSingleton;

  private constructor() {
    super("CRON");
  }

  public static get instance() {
    if (!CronSingleton._instance) {
      CronSingleton._instance = new CronSingleton();
    }

    return CronSingleton._instance;
  }
}
