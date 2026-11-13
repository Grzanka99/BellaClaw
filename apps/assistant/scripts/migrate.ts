import { join } from "node:path";
import { logger } from "@bellaclaw/shared";
import { migrate } from "drizzle-orm/libsql/migrator";
import { DatabaseConnector } from "../src/services/database";

try {
  await migrate(DatabaseConnector.instance.database, {
    migrationsFolder: join(import.meta.dir, "../migrations"),
  });
} catch (error) {
  // only the message: the supervisor sends this output to chat
  logger.error(String(error));
  process.exit(1);
}
