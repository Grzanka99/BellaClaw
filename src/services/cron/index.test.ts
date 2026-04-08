import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { CronSingleton } from "./index";
import type { TJobContext } from "./types";
import { ECronJobType } from "./types";

const TEST_DB = "test-cron.db";

function resetCronInstance(dbPath: string) {
  const CronWithPrivate = CronSingleton as unknown as {
    _instance: CronSingleton | undefined;
    DB_FILE: string;
  };
  CronWithPrivate._instance = undefined;
  CronWithPrivate.DB_FILE = dbPath;
}

describe("CronSingleton", () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }
    resetCronInstance(TEST_DB);
  });

  afterEach(() => {
    const cron = CronSingleton.instance;
    cron.destroy();
    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }
    resetCronInstance("cron.db");
  });

  describe("schedule", () => {
    test("returns a TCronJob with correct fields", async () => {
      const cron = CronSingleton.instance;
      const result = await cron.schedule({ name: "test-job", pattern: "*/5 * * * *" });

      expect("error" in result).toBe(false);
      if ("error" in result) return;

      expect(result.name).toBe("test-job");
      expect(result.type).toBe(ECronJobType.Recurring);
      expect(result.pattern).toBe("*/5 * * * *");
      expect(result.nextRunAt).toBeInstanceOf(Date);
      expect(result.lastRunAt).toBeNull();
      expect(result.createdAt).toBeInstanceOf(Date);
    });
  });

  describe("scheduleOnce", () => {
    test("returns a TCronJob with type onetime", async () => {
      const cron = CronSingleton.instance;
      const futureDate = new Date(Date.now() + 60_000);
      const result = await cron.scheduleOnce({ name: "one-off", fireAt: futureDate });

      expect("error" in result).toBe(false);
      if ("error" in result) return;

      expect(result.name).toBe("one-off");
      expect(result.type).toBe(ECronJobType.OneTime);
      expect(result.pattern).toBeNull();
      expect(result.nextRunAt).toEqual(futureDate);
    });

    test("returns TCronError when fireAt is in the past", async () => {
      const cron = CronSingleton.instance;
      const pastDate = new Date(Date.now() - 60_000);
      const result = await cron.scheduleOnce({ name: "past-job", fireAt: pastDate });

      expect("error" in result).toBe(true);
    });
  });

  describe("tick — event fires (recurring)", () => {
    test("emits event with TJobContext for recurring job", async () => {
      const cron = CronSingleton.instance;
      await cron.schedule({ name: "recurring-test", pattern: "*/5 * * * *" });

      const db = (cron as unknown as { db: import("bun:sqlite").Database }).db;
      db.query("UPDATE cron_jobs SET nextRunAt = $ts WHERE name = $name").run({
        $ts: Date.now() - 1000,
        $name: "recurring-test",
      });

      const emitted = new Promise<TJobContext>((resolve) => {
        cron.on("recurring-test", (ctx: TJobContext) => {
          resolve(ctx);
        });
      });

      await (cron as unknown as { tick: () => Promise<void> }).tick();
      const ctx = await emitted;

      expect(ctx.name).toBe("recurring-test");
      expect(ctx.type).toBe(ECronJobType.Recurring);
      expect(ctx.pattern).toBe("*/5 * * * *");
      expect(ctx.nextRunAt).toBeInstanceOf(Date);
    });
  });

  describe("tick — event fires (one-time)", () => {
    test("emits event and removes the job", async () => {
      const cron = CronSingleton.instance;

      const db = (cron as unknown as { db: import("bun:sqlite").Database }).db;
      db.query(
        `INSERT INTO cron_jobs (name, type, pattern, nextRunAt, lastRunAt, createdAt) VALUES ($name, $type, $pattern, $nextRunAt, $lastRunAt, $createdAt)`,
      ).run({
        $name: "onetime-test",
        $type: "onetime",
        $pattern: null,
        $nextRunAt: Date.now() - 1000,
        $lastRunAt: null,
        $createdAt: Date.now(),
      });

      const emitted = new Promise<TJobContext>((resolve) => {
        cron.on("onetime-test", (ctx: TJobContext) => {
          resolve(ctx);
        });
      });

      await (cron as unknown as { tick: () => Promise<void> }).tick();
      const ctx = await emitted;

      expect(ctx.name).toBe("onetime-test");
      expect(ctx.type).toBe(ECronJobType.OneTime);
      expect(ctx.pattern).toBeUndefined();

      const job = await cron.getJob("onetime-test");
      expect(job).toBeUndefined();
    });
  });

  describe("unschedule", () => {
    test("removes job and returns it", async () => {
      const cron = CronSingleton.instance;
      await cron.schedule({ name: "to-remove", pattern: "* * * * *" });

      const result = await cron.unschedule("to-remove");
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.name).toBe("to-remove");

      const job = await cron.getJob("to-remove");
      expect(job).toBeUndefined();
    });
  });

  describe("cross-type overwrite guard", () => {
    test("schedule rejects when a one-time job with the same name exists", async () => {
      const cron = CronSingleton.instance;
      const futureDate = new Date(Date.now() + 60_000);
      await cron.scheduleOnce({ name: "conflict-job", fireAt: futureDate });

      const result = await cron.schedule({ name: "conflict-job", pattern: "*/5 * * * *" });
      expect("error" in result).toBe(true);
    });

    test("scheduleOnce rejects when a recurring job with the same name exists", async () => {
      const cron = CronSingleton.instance;
      await cron.schedule({ name: "conflict-job-2", pattern: "*/5 * * * *" });

      const futureDate = new Date(Date.now() + 60_000);
      const result = await cron.scheduleOnce({ name: "conflict-job-2", fireAt: futureDate });
      expect("error" in result).toBe(true);
    });

    test("same-type overwrite with overwrite: true succeeds", async () => {
      const cron = CronSingleton.instance;
      await cron.schedule({ name: "same-type", pattern: "0 0 * * *" });
      await cron.schedule({ name: "same-type", pattern: "*/5 * * * *", overwrite: true });

      const job = await cron.getJob("same-type");
      expect(job).toBeDefined();
      if (!job) return;
      expect(job.pattern).toBe("*/5 * * * *");
    });

    test("same-type schedule rejects without overwrite flag", async () => {
      const cron = CronSingleton.instance;
      await cron.schedule({ name: "dup-recurring", pattern: "0 0 * * *" });

      const result = await cron.schedule({ name: "dup-recurring", pattern: "*/5 * * * *" });
      expect("error" in result).toBe(true);
    });
  });

  describe("tick emits group in TJobContext", () => {
    test("group is included in emitted event", async () => {
      const cron = CronSingleton.instance;
      await cron.schedule({ name: "grouped-tick", pattern: "*/5 * * * *", group: "alerts" });

      const db = (cron as unknown as { db: import("bun:sqlite").Database }).db;
      db.query("UPDATE cron_jobs SET nextRunAt = $ts WHERE name = $name").run({
        $ts: Date.now() - 1000,
        $name: "grouped-tick",
      });

      const emitted = new Promise<TJobContext>((resolve) => {
        cron.on("grouped-tick", (ctx: TJobContext) => {
          resolve(ctx);
        });
      });

      await (cron as unknown as { tick: () => Promise<void> }).tick();
      const ctx = await emitted;

      expect(ctx.group).toBe("alerts");
    });
  });

  describe("parser — getNextFireTime", () => {
    test('"* * * * *" from any time → next minute', () => {
      const { getNextFireTime } = require("./parser");
      const from = new Date(2025, 0, 1, 12, 30, 45, 0);
      const next = getNextFireTime("* * * * *", from);
      expect(next.getMinutes()).toBe(31);
      expect(next.getSeconds()).toBe(0);
    });

    test('"0 9 * * 1-5" → next weekday at 09:00', () => {
      const { getNextFireTime } = require("./parser");
      const from = new Date(2025, 0, 3, 10, 0, 0, 0);
      const next = getNextFireTime("0 9 * * 1-5", from);
      expect(next.getDay()).toBeGreaterThanOrEqual(1);
      expect(next.getDay()).toBeLessThanOrEqual(5);
      expect(next.getHours()).toBe(9);
      expect(next.getMinutes()).toBe(0);
    });
  });
});
