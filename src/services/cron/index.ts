import { createLogger, type TLogger } from "../../utils/logger";

export class CronSingleton {
  private static _instance: CronSingleton;
  private logger: TLogger = createLogger("CRON");

  private constructor() {}

  public static get instance() {
    if (!CronSingleton._instance) {
      CronSingleton._instance = new CronSingleton();
    }

    return CronSingleton._instance;
  }
}
