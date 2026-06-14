import { sql } from "drizzle-orm";
import { AsyncQueue } from "../../utils/async-queue";
import { createLogger } from "../../utils/logger";
import { DatabaseConnector } from "../database";

export class MessagingDataMigration {
  private db = DatabaseConnector.instance.database;
  private queue = new AsyncQueue();
  private logger = createLogger("MESSAGING MIGRATION");

  public async migrateRawDiscordScopes() {
    await this.queue.enqueue(async () => {
      await this.db.run(sql`
        UPDATE memories
        SET chatId = 'discord:' || chatId
        WHERE chatId != '' AND instr(chatId, ':') = 0
      `);

      await this.db.run(sql`
        DELETE FROM cron_engine_jobs
        WHERE scope != ''
          AND instr(scope, ':') = 0
          AND EXISTS (
            SELECT 1
            FROM cron_engine_jobs AS canonical_jobs
            WHERE canonical_jobs.name = cron_engine_jobs.name
              AND canonical_jobs.scope = 'discord:' || cron_engine_jobs.scope
          )
      `);

      await this.db.run(sql`
        UPDATE cron_engine_jobs
        SET scope = 'discord:' || scope
        WHERE scope != '' AND instr(scope, ':') = 0
      `);
    });

    this.logger.info("raw Discord memory and cron scopes migrated");
  }
}
