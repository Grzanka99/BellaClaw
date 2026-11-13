import { AsyncQueue } from "@bellaclaw/shared";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";

export type TDatabaseTransaction = Parameters<Parameters<LibSQLDatabase["transaction"]>[0]>[0];
export type TDatabaseHandle = LibSQLDatabase | TDatabaseTransaction;

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
  private db: LibSQLDatabase;
  private queue = new AsyncQueue();

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

  public static get instance() {
    if (!DatabaseConnector._instance) {
      DatabaseConnector._instance = new DatabaseConnector(isTestDatabaseMode());
    }

    return DatabaseConnector._instance;
  }

  // NOTE: for tests and standalone scripts only; services go through run()
  public get database() {
    return this.db;
  }

  // Runs one unit of database work after every earlier one has finished. Not re-entrant: the
  // callback must use the given handle and never call run() again, directly or through another
  // service, or it deadlocks. Keep model, embedding, network and subprocess calls outside it.
  public run<T>(callback: (db: LibSQLDatabase) => Promise<T>): Promise<T> {
    return this.queue.enqueue(() => callback(this.db));
  }
}
