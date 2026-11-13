import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DatabaseConnector } from "../database";
import { userConfigsTable } from "../database/schema";
import { resetEventTables, resetUserConfigsTable } from "../database/test-utils";
import { EventBus } from "../events";
import { EEventType, ERejectionCode } from "../events/catalog";
import { withEventContext } from "../events/test-utils";
import { DefaultConfigRecord, EConfigKey } from "./schema";

const { SettingsService } = await import("./index");

type TSettingsServiceStatic = {
  _instance: unknown;
};

function resetSettingsInstance() {
  const SettingsServiceStatic = SettingsService as unknown as TSettingsServiceStatic;
  SettingsServiceStatic._instance = undefined;
}

async function insertOwnerRow(ownerKey: string, key: string, value: string) {
  const db = DatabaseConnector.instance.database;
  const now = Date.now();

  await db.insert(userConfigsTable).values({
    ownerKey,
    key,
    value,
    createdAt: now,
    updatedAt: now,
  });
}

async function getOwnerRows(ownerKey: string) {
  const db = DatabaseConnector.instance.database;

  return db.select().from(userConfigsTable).where(eq(userConfigsTable.ownerKey, ownerKey));
}

describe("SettingsService", () => {
  let bus: EventBus;
  let started: boolean;

  beforeEach(async () => {
    resetSettingsInstance();
    await resetUserConfigsTable();
    await resetEventTables();
    Object.assign(EventBus, { _instance: undefined });
    bus = EventBus.instance;
    started = false;
    SettingsService.instance.setup();
  });

  afterEach(async () => {
    await bus.idle();
    await bus.stop();
    resetSettingsInstance();
  });

  async function start() {
    await bus.start();
    started = true;
  }

  // the settings tool's path: request settings.update.requested and return the new record
  async function update(ownerKey: string, key: EConfigKey, value: string) {
    if (!started) {
      await start();
    }

    const changed = await withEventContext((ctx) =>
      ctx.request(
        EEventType.SettingsUpdateRequested,
        { ownerKey, updates: [{ key, value }] },
        {
          outcome: EEventType.SettingsChanged,
          step: undefined,
          key: ownerKey,
          timeoutMs: undefined,
        },
      ),
    );
    await bus.idle();
    return changed.payload.record;
  }

  describe("getAll", () => {
    test("caches defaults and refreshes independent records after set and reset", async () => {
      const settings = SettingsService.instance;
      const ownerKey = "owner-default-cache";
      await start();
      // the bus reads the event tables too, so count the service's own table reads
      const select = spyOn(
        settings as unknown as { selectOwnerRows: (ownerKey: string) => Promise<unknown> },
        "selectOwnerRows",
      );

      try {
        const first = await settings.getAll(ownerKey);
        const second = await settings.getAll(ownerKey);
        expect(first).toEqual(DefaultConfigRecord);
        expect(second).toEqual(DefaultConfigRecord);
        expect(select).toHaveBeenCalledTimes(1);
        first[EConfigKey.AiInstructionsTimezone] = "mutated";
        expect(second[EConfigKey.AiInstructionsTimezone]).toBe(
          DefaultConfigRecord[EConfigKey.AiInstructionsTimezone],
        );

        const changed = await update(ownerKey, EConfigKey.AiInstructionsTimezone, "Asia/Tokyo");
        changed[EConfigKey.AiInstructionsTimezone] = "mutated";
        expect((await settings.getAll(ownerKey))[EConfigKey.AiInstructionsTimezone]).toBe(
          "Asia/Tokyo",
        );
        // settings.changed refreshed the cache
        expect(select).toHaveBeenCalledTimes(1);

        const reset = await update(
          ownerKey,
          EConfigKey.AiInstructionsTimezone,
          DefaultConfigRecord[EConfigKey.AiInstructionsTimezone],
        );
        reset[EConfigKey.AiInstructionsTimezone] = "mutated";
        expect(await settings.getAll(ownerKey)).toEqual(DefaultConfigRecord);
        expect(select).toHaveBeenCalledTimes(1);
      } finally {
        select.mockRestore();
      }
    });

    test("missing owner returns DefaultConfigRecord without writing rows", async () => {
      const settings = SettingsService.instance;
      const ownerKey = "owner-missing";

      const record = await settings.getAll(ownerKey);

      expect(record).toEqual(DefaultConfigRecord);

      const rows = await getOwnerRows(ownerKey);

      expect(rows).toHaveLength(0);
    });

    test("concurrent first reads for the same owner both return defaults without writing rows", async () => {
      const settings = SettingsService.instance;
      const ownerKey = "owner-concurrent";

      const [first, second] = await Promise.all([
        settings.getAll(ownerKey),
        settings.getAll(ownerKey),
      ]);

      expect(first).toEqual(DefaultConfigRecord);
      expect(second).toEqual(DefaultConfigRecord);

      const rows = await getOwnerRows(ownerKey);

      expect(rows).toHaveLength(0);
    });

    test("existing owner missing one allowed key uses default without inserting it", async () => {
      const settings = SettingsService.instance;
      const ownerKey = "owner-partial";
      const missingKey = EConfigKey.AiInstructionsTimezone;

      for (const key of Object.values(EConfigKey)) {
        if (key === missingKey) {
          continue;
        }

        await insertOwnerRow(ownerKey, key, DefaultConfigRecord[key]);
      }

      const record = await settings.getAll(ownerKey);

      expect(record[missingKey]).toBe(DefaultConfigRecord[missingKey]);

      const rows = await getOwnerRows(ownerKey);

      expect(rows).toHaveLength(Object.values(EConfigKey).length - 1);

      const missingRow = rows.find((row) => row.key === missingKey);

      expect(missingRow).toBeUndefined();
    });

    test("returns a defensive copy so cache mutations do not leak", async () => {
      const settings = SettingsService.instance;
      const ownerKey = "owner-copy";

      const first = await settings.getAll(ownerKey);
      const firstTimezone = first[EConfigKey.AiInstructionsTimezone];

      first[EConfigKey.AiInstructionsTimezone] = "mutated";

      const second = await settings.getAll(ownerKey);

      expect(second[EConfigKey.AiInstructionsTimezone]).toBe(firstTimezone);
    });
  });

  describe("update", () => {
    test("rejects invalid timezone", async () => {
      const rejected = update("owner-set", EConfigKey.AiInstructionsTimezone, "Not/A_Real_Tz");

      await expect(rejected).rejects.toThrow("Invalid value for config key");
      await expect(rejected).rejects.toMatchObject({ code: ERejectionCode.Invalid });
      expect(await getOwnerRows("owner-set")).toHaveLength(0);
    });

    test("rejects invalid provider", async () => {
      await expect(update("owner-set", EConfigKey.AiProvider, "invalid-provider")).rejects.toThrow(
        "Invalid value for config key",
      );
    });

    test("upserts valid value, reads back, and updates cache after settings.changed", async () => {
      const settings = SettingsService.instance;
      const ownerKey = "owner-set-valid";
      const newValue = "America/New_York";

      const result = await update(ownerKey, EConfigKey.AiInstructionsTimezone, newValue);

      expect(result[EConfigKey.AiInstructionsTimezone]).toBe(newValue);

      const cached = await settings.get(ownerKey, EConfigKey.AiInstructionsTimezone);

      expect(cached).toBe(newValue);

      const fullRecord = await settings.getAll(ownerKey);

      expect(fullRecord[EConfigKey.AiInstructionsTimezone]).toBe(newValue);

      const rows = await getOwnerRows(ownerKey);
      const timezoneRow = rows.find((row) => row.key === EConfigKey.AiInstructionsTimezone);

      expect(timezoneRow?.value).toBe(newValue);
    });

    test("overwrites existing value on repeated set", async () => {
      const settings = SettingsService.instance;
      const ownerKey = "owner-overwrite";

      await update(ownerKey, EConfigKey.AiInstructionsTimezone, "America/New_York");
      await update(ownerKey, EConfigKey.AiInstructionsTimezone, "Asia/Tokyo");

      const value = await settings.get(ownerKey, EConfigKey.AiInstructionsTimezone);

      expect(value).toBe("Asia/Tokyo");

      const rows = await getOwnerRows(ownerKey);
      const timezoneRows = rows.filter((row) => row.key === EConfigKey.AiInstructionsTimezone);

      expect(timezoneRows).toHaveLength(1);
      expect(timezoneRows[0]?.value).toBe("Asia/Tokyo");
    });
  });

  describe("owner isolation", () => {
    test("different owner keys keep isolated settings after set", async () => {
      const settings = SettingsService.instance;

      await update("owner-a", EConfigKey.AiInstructionsTimezone, "America/New_York");
      await update("owner-b", EConfigKey.AiInstructionsTimezone, "Asia/Tokyo");

      const valueA = await settings.get("owner-a", EConfigKey.AiInstructionsTimezone);
      const valueB = await settings.get("owner-b", EConfigKey.AiInstructionsTimezone);

      expect(valueA).toBe("America/New_York");
      expect(valueB).toBe("Asia/Tokyo");

      const rowsA = await getOwnerRows("owner-a");
      const rowsB = await getOwnerRows("owner-b");

      expect(rowsA).toHaveLength(1);
      expect(rowsB).toHaveLength(1);
      expect(rowsA.find((row) => row.key === EConfigKey.AiInstructionsTimezone)?.value).toBe(
        "America/New_York",
      );
      expect(rowsB.find((row) => row.key === EConfigKey.AiInstructionsTimezone)?.value).toBe(
        "Asia/Tokyo",
      );
    });
  });

  describe("invalid stored rows", () => {
    test("invalid timezone is ignored on read", async () => {
      const settings = SettingsService.instance;
      const ownerKey = "owner-invalid-tz";

      await insertOwnerRow(ownerKey, EConfigKey.AiInstructionsTimezone, "Not/A_Real_Tz");

      const record = await settings.getAll(ownerKey);

      expect(record[EConfigKey.AiInstructionsTimezone]).toBe(
        DefaultConfigRecord[EConfigKey.AiInstructionsTimezone],
      );

      const rows = await getOwnerRows(ownerKey);
      const timezoneRow = rows.find((row) => row.key === EConfigKey.AiInstructionsTimezone);

      expect(timezoneRow?.value).toBe("Not/A_Real_Tz");
    });

    test("invalid provider is ignored on read", async () => {
      const settings = SettingsService.instance;
      const ownerKey = "owner-invalid-provider";

      await insertOwnerRow(ownerKey, EConfigKey.AiProvider, "invalid-provider");

      const record = await settings.getAll(ownerKey);

      expect(record[EConfigKey.AiProvider]).toBe(DefaultConfigRecord[EConfigKey.AiProvider]);

      const rows = await getOwnerRows(ownerKey);
      const providerRow = rows.find((row) => row.key === EConfigKey.AiProvider);

      expect(providerRow?.value).toBe("invalid-provider");
    });
  });
});
