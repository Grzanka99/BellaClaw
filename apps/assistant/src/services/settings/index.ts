import { and, eq } from "drizzle-orm";
import { DatabaseConnector, type TDatabaseTransaction } from "../database";
import { type TSelectUserConfig, userConfigsTable } from "../database/schema";
import { ESubscriptionMode, EventBus } from "../events";
import { EEventType, ERejectionCode } from "../events/catalog";
import {
  ConfigValidators,
  DefaultConfigRecord,
  type EConfigKey,
  isConfigKey,
  type TConfigRecord,
} from "./schema";

export type TConfigUpdate = {
  key: EConfigKey;
  value: string;
};

type TValidation = { valid: true; updates: TConfigUpdate[] } | { valid: false; problem: string };

export class SettingsService {
  private static _instance: SettingsService;

  private database = DatabaseConnector.instance;
  private cache: Map<string, TConfigRecord> = new Map();

  private constructor() {}

  public static get instance() {
    if (!SettingsService._instance) {
      SettingsService._instance = new SettingsService();
    }

    return SettingsService._instance;
  }

  // NOTE: the cache has its own consumer, so its update never waits behind a command on the
  // owner's lane
  public setup(): void {
    const bus = EventBus.instance;

    bus.subscribe({
      consumer: "settings",
      type: EEventType.SettingsUpdateRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event, ctx) => {
        const { ownerKey, updates } = event.payload;

        await ctx.complete(async (tx, emit) => {
          const validation = this.validate(updates);

          if (!validation.valid) {
            emit(
              EEventType.CommandRejected,
              {
                commandType: event.type,
                code: ERejectionCode.Invalid,
                message: validation.problem,
              },
              undefined,
              undefined,
            );
            return;
          }

          const record = await this.writeMany(tx, ownerKey, validation.updates);
          emit(EEventType.SettingsChanged, { ownerKey, record }, undefined, undefined);
        });
      },
    });
    bus.subscribe({
      consumer: "settings-cache",
      type: EEventType.SettingsChanged,
      mode: ESubscriptionMode.Live,
      backoffMs: [],
      handler: async (event) => {
        this.cache.set(event.payload.ownerKey, event.payload.record);
      },
    });
  }

  public async getAll(ownerKey: string): Promise<TConfigRecord> {
    const cached = this.cache.get(ownerKey);

    if (cached) {
      return { ...cached };
    }

    const rows = await this.selectOwnerRows(ownerKey);
    const record = this.createRecord(rows);

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

  private validate(updates: TConfigUpdate[]): TValidation {
    if (updates.length === 0) {
      return { valid: false, problem: "Provide at least one config update" };
    }

    const validated: TConfigUpdate[] = [];

    for (const update of updates) {
      const parsed = ConfigValidators[update.key].safeParse(update.value);

      if (!parsed.success) {
        return {
          valid: false,
          problem: `Invalid value for config key "${update.key}": ${JSON.stringify(update.value)}`,
        };
      }

      validated.push({ key: update.key, value: parsed.data });
    }

    return { valid: true, updates: validated };
  }

  // writes validated updates and returns the owner's new record
  private async writeMany(
    tx: TDatabaseTransaction,
    ownerKey: string,
    updates: TConfigUpdate[],
  ): Promise<TConfigRecord> {
    const now = Date.now();

    for (const { key, value } of updates) {
      if (value === DefaultConfigRecord[key]) {
        await tx
          .delete(userConfigsTable)
          .where(and(eq(userConfigsTable.ownerKey, ownerKey), eq(userConfigsTable.key, key)));
      } else {
        await tx
          .insert(userConfigsTable)
          .values({ ownerKey, key, value, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: [userConfigsTable.ownerKey, userConfigsTable.key],
            set: { value, updatedAt: now },
          });
      }
    }

    const rows = await tx
      .select()
      .from(userConfigsTable)
      .where(eq(userConfigsTable.ownerKey, ownerKey));

    return this.createRecord(rows);
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
    return this.database.run(async (db) => {
      return db.select().from(userConfigsTable).where(eq(userConfigsTable.ownerKey, ownerKey));
    });
  }
}
