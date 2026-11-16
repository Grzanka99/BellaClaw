import { MIGRATIONS_FOLDER } from "@bellaclaw/database";
import { logger } from "@bellaclaw/shared";
import { migrate } from "drizzle-orm/libsql/migrator";
import { DatabaseConnector } from "../src/services/database";

try {
  await migrate(DatabaseConnector.instance.database, { migrationsFolder: MIGRATIONS_FOLDER });
} catch (error) {
  // only the message: the supervisor sends this output to chat
  logger.error(String(error));
  process.exit(1);
}

// an open database connection would keep the process alive
process.exit(0);
