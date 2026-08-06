import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";

const TURSO_URL = Bun.env.TURSO_CONNECTION_URL;
const TURSO_TOKEN = Bun.env.TURSO_AUTH_TOKEN;
const TEST_DATABASE_URL = "file:./test.db";

function isTestDatabaseMode() {
  if (Bun.env.BELLACLAW_DATABASE_MODE === "test") {
    return true;
  }

  if (Bun.env.NODE_ENV === "test") {
    return true;
  }

  return false;
}

export class DatabaseConnector {
  private static _instance: DatabaseConnector;
  private static _testInstance: DatabaseConnector;
  private db: LibSQLDatabase;

  private constructor(isTest = false) {
    if (isTest) {
      this.db = drizzle({
        connection: {
          url: TEST_DATABASE_URL,
        },
      });
      return;
    }

    if (!TURSO_URL) {
      throw new Error("TURSO_CONNECTION_URL is required");
    }

    if (!TURSO_TOKEN) {
      throw new Error("TURSO_AUTH_TOKEN is required");
    }

    this.db = drizzle({
      connection: {
        url: TURSO_URL,
        authToken: TURSO_TOKEN,
      },
    });
  }

  public static get testinstance() {
    if (!DatabaseConnector._testInstance) {
      DatabaseConnector._testInstance = new DatabaseConnector(true);
    }

    return DatabaseConnector._testInstance;
  }

  public static get instance() {
    if (isTestDatabaseMode()) {
      return DatabaseConnector.testinstance;
    }

    if (!DatabaseConnector._instance) {
      DatabaseConnector._instance = new DatabaseConnector();
    }

    return DatabaseConnector._instance;
  }

  public get database() {
    return this.db;
  }
}
