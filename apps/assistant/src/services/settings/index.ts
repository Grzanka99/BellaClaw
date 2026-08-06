import { AsyncQueue } from "@bellaclaw/shared";
import { and, eq } from "drizzle-orm";
import { DatabaseConnector } from "../database";
import { type TSelectUserConfig, userConfigsTable } from "../database/schema";
import {
  ConfigValidators,
  DefaultConfigRecord,
  type EConfigKey,
  isConfigKey,
  type TConfigRecord,
} from "./schema";

export class SettingsService {
  private static _instance: SettingsService;

  private db = DatabaseConnector.instance.database;
  private queue: AsyncQueue;
  private cache: Map<string, TConfigRecord> = new Map();

  private constructor() {
    this.queue = new AsyncQueue();
  }

  public static get instance() {
    if (!SettingsService._instance) {
      SettingsService._instance = new SettingsService();
    }

    return SettingsService._instance;
  }

  public async getAll(ownerKey: string): Promise<TConfigRecord> {
    const cached = this.cache.get(ownerKey);

    if (cached) {
      return { ...cached };
    }

    const rows = await this.selectOwnerRows(ownerKey);
    const record = this.createRecord(rows);

    if (rows.length > 0) {
      this.cache.set(ownerKey, record);
    }

    return { ...record };
  }

  public async get(ownerKey: string, key: string): Promise<string> {
    if (!isConfigKey(key)) {
      throw new Error(`Unknown config key: "${key}"`);
    }

    const record = await this.getAll(ownerKey);

    return record[key];
  }

  public async set(ownerKey: string, key: string, value: string): Promise<TConfigRecord> {
    if (!isConfigKey(key)) {
      throw new Error(`Unknown config key: "${key}"`);
    }

    const validator = ConfigValidators[key];
    const parsed = validator.safeParse(value);

    if (!parsed.success) {
      throw new Error(`Invalid value for config key "${key}": ${JSON.stringify(value)}`);
    }

    if (parsed.data === DefaultConfigRecord[key]) {
      await this.deleteRow(ownerKey, key);
    } else {
      await this.upsertRow(ownerKey, key, parsed.data);
    }

    this.cache.delete(ownerKey);

    const rows = await this.selectOwnerRows(ownerKey);
    const record = this.createRecord(rows);

    if (rows.length > 0) {
      this.cache.set(ownerKey, record);
    }

    return { ...record };
  }

  private createRecord(rows: TSelectUserConfig[]): TConfigRecord {
    const record: TConfigRecord = { ...DefaultConfigRecord };

    for (const row of rows) {
      if (!isConfigKey(row.key)) {
        continue;
      }

      const validator = ConfigValidators[row.key];
      const parsed = validator.safeParse(row.value);

      if (!parsed.success) {
        continue;
      }

      record[row.key] = parsed.data;
    }

    return record;
  }

  private async selectOwnerRows(ownerKey: string): Promise<TSelectUserConfig[]> {
    return this.queue.enqueue(async () => {
      return this.db.select().from(userConfigsTable).where(eq(userConfigsTable.ownerKey, ownerKey));
    });
  }

  private async deleteRow(ownerKey: string, key: EConfigKey): Promise<void> {
    await this.queue.enqueue(async () => {
      await this.db
        .delete(userConfigsTable)
        .where(and(eq(userConfigsTable.ownerKey, ownerKey), eq(userConfigsTable.key, key)));
    });
  }

  private async upsertRow(ownerKey: string, key: EConfigKey, value: string): Promise<void> {
    const now = Date.now();

    await this.queue.enqueue(async () => {
      await this.db
        .insert(userConfigsTable)
        .values({
          ownerKey,
          key,
          value,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [userConfigsTable.ownerKey, userConfigsTable.key],
          set: { value, updatedAt: now },
        });
    });
  }
}
