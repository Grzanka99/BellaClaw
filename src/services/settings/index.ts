import { and, eq } from "drizzle-orm";
import { AsyncQueue } from "../../utils/async-queue";
import { createLogger } from "../../utils/logger";
import { DatabaseConnector } from "../database";
import { type TSelectUserConfig, userConfigsTable } from "../database/schema";
import {
  ConfigValidators,
  DefaultConfigRecord,
  EConfigKey,
  isConfigKey,
  type TConfigRecord,
} from "./schema";

export class SettingsService {
  private static _instance: SettingsService;

  private db = DatabaseConnector.instance.database;
  private queue: AsyncQueue;
  private logger = createLogger("SETTINGS");
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

  public async setup(): Promise<void> {
    this.cache.clear();

    const rows = await this.selectAllRows();

    const byOwner = new Map<string, TSelectUserConfig[]>();

    for (const row of rows) {
      const ownerRows = byOwner.get(row.ownerKey);

      if (ownerRows) {
        ownerRows.push(row);
      } else {
        byOwner.set(row.ownerKey, [row]);
      }
    }

    for (const [ownerKey, ownerRows] of byOwner) {
      try {
        await this.repairStoredRows(ownerKey, ownerRows);

        const refreshedRows = await this.selectOwnerRows(ownerKey);
        const validated = this.validateRows(refreshedRows);

        if (!this.isComplete(validated)) {
          this.logger.warning(`Skipping incomplete owner "${ownerKey}" during setup`);
          continue;
        }

        this.cache.set(ownerKey, this.assembleRecord(validated));
      } catch (error) {
        this.logger.warning(`Skipping owner "${ownerKey}" during setup: ${String(error)}`);
      }
    }
  }

  public async getAll(ownerKey: string): Promise<TConfigRecord> {
    const cached = this.cache.get(ownerKey);

    if (cached) {
      return { ...cached };
    }

    const record = await this.loadOwnerRecord(ownerKey);
    this.cache.set(ownerKey, record);

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

    await this.upsertRow(ownerKey, key, parsed.data);
    this.cache.delete(ownerKey);

    const record = await this.loadOwnerRecord(ownerKey);
    this.cache.set(ownerKey, record);

    return { ...record };
  }

  public invalidate(ownerKey: string): void {
    this.cache.delete(ownerKey);
  }

  private async loadOwnerRecord(ownerKey: string): Promise<TConfigRecord> {
    const rows = await this.selectOwnerRows(ownerKey);
    await this.repairStoredRows(ownerKey, rows);

    const repairedRows = await this.selectOwnerRows(ownerKey);
    const validated = this.validateRows(repairedRows);

    const missingKeys: EConfigKey[] = [];

    for (const key of Object.values(EConfigKey)) {
      if (!validated.has(key)) {
        missingKeys.push(key);
      }
    }

    if (missingKeys.length > 0) {
      await this.insertMissingRows(ownerKey, missingKeys);
    }

    const refreshed = await this.selectOwnerRows(ownerKey);
    const refreshedValidated = this.validateRows(refreshed);

    if (!this.isComplete(refreshedValidated)) {
      throw new Error(`Incomplete config record for owner "${ownerKey}" after seeding defaults`);
    }

    return this.assembleRecord(refreshedValidated);
  }

  private validateRows(rows: TSelectUserConfig[]): Map<EConfigKey, string> {
    const byKey = new Map<EConfigKey, string>();

    for (const row of rows) {
      if (!isConfigKey(row.key)) {
        continue;
      }

      const validator = ConfigValidators[row.key];
      const parsed = validator.safeParse(row.value);

      if (!parsed.success) {
        continue;
      }

      byKey.set(row.key, parsed.data);
    }

    return byKey;
  }

  private async repairStoredRows(ownerKey: string, rows: TSelectUserConfig[]): Promise<void> {
    const unknownKeys: string[] = [];
    const invalidKeys: EConfigKey[] = [];

    for (const row of rows) {
      if (!isConfigKey(row.key)) {
        unknownKeys.push(row.key);
        continue;
      }

      const validator = ConfigValidators[row.key];
      const parsed = validator.safeParse(row.value);

      if (!parsed.success) {
        invalidKeys.push(row.key);
      }
    }

    if (unknownKeys.length > 0) {
      await this.deleteRows(ownerKey, unknownKeys);
    }

    if (invalidKeys.length > 0) {
      await this.resetRows(ownerKey, invalidKeys);
    }
  }

  private isComplete(byKey: Map<EConfigKey, string>): boolean {
    for (const key of Object.values(EConfigKey)) {
      if (!byKey.has(key)) {
        return false;
      }
    }

    return true;
  }

  private assembleRecord(byKey: Map<EConfigKey, string>): TConfigRecord {
    const record: TConfigRecord = { ...DefaultConfigRecord };

    for (const key of Object.values(EConfigKey)) {
      const value = byKey.get(key);

      if (value !== undefined) {
        record[key] = value;
      }
    }

    return record;
  }

  private async selectAllRows(): Promise<TSelectUserConfig[]> {
    return this.queue.enqueue(async () => {
      return this.db.select().from(userConfigsTable);
    });
  }

  private async selectOwnerRows(ownerKey: string): Promise<TSelectUserConfig[]> {
    return this.queue.enqueue(async () => {
      return this.db.select().from(userConfigsTable).where(eq(userConfigsTable.ownerKey, ownerKey));
    });
  }

  private async insertMissingRows(ownerKey: string, missingKeys: EConfigKey[]): Promise<void> {
    const now = Date.now();
    const values = missingKeys.map((key) => ({
      ownerKey,
      key,
      value: DefaultConfigRecord[key],
      createdAt: now,
      updatedAt: now,
    }));

    await this.queue.enqueue(async () => {
      await this.db
        .insert(userConfigsTable)
        .values(values)
        .onConflictDoNothing({
          target: [userConfigsTable.ownerKey, userConfigsTable.key],
        });
    });
  }

  private async deleteRows(ownerKey: string, keys: string[]): Promise<void> {
    await this.queue.enqueue(async () => {
      for (const key of keys) {
        await this.db
          .delete(userConfigsTable)
          .where(and(eq(userConfigsTable.ownerKey, ownerKey), eq(userConfigsTable.key, key)));
      }
    });
  }

  private async resetRows(ownerKey: string, keys: EConfigKey[]): Promise<void> {
    const now = Date.now();

    await this.queue.enqueue(async () => {
      for (const key of keys) {
        await this.db
          .update(userConfigsTable)
          .set({ value: DefaultConfigRecord[key], updatedAt: now })
          .where(and(eq(userConfigsTable.ownerKey, ownerKey), eq(userConfigsTable.key, key)));
      }
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
