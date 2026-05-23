import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AsyncQueue } from "../../utils/async-queue";
import { CronSingleton } from "./index";

const tempDir = join(Bun.cwd, "tmp");
mkdirSync(tempDir, { recursive: true });
const TEST_DB = join(tempDir, "test-cron-singleton-runtime-safety.db");

type TEngineWithInternals = {
  db: Database;
  queue: AsyncQueue;
  tick: () => Promise<void>;
};

type TCronSingletonInternals = {
  engine: TEngineWithInternals;
};

type TCronSingletonStatic = {
  _instance: CronSingleton | undefined;
};

function cleanupCronSingleton() {
  const CronSingletonWithInternals = CronSingleton as unknown as TCronSingletonStatic;
  CronSingletonWithInternals._instance?.destroy();
  CronSingleton.resetDbFile();

  if (existsSync(TEST_DB)) {
    unlinkSync(TEST_DB);
  }
}

async function insertDueOneTimeJob(cron: CronSingleton, name: string, scope: string) {
  const internals = cron as unknown as TCronSingletonInternals;

  await internals.engine.queue.enqueue(async () => {
    internals.engine.db
      .query(
        `INSERT INTO cron_engine_jobs (name, scope, "group", type, pattern, reminderText, reminderPromptData, reminderFallbackText, nextRunAt, lastRunAt, createdAt)
         VALUES ($name, $scope, $group, $type, $pattern, $reminderText, $reminderPromptData, $reminderFallbackText, $nextRunAt, $lastRunAt, $createdAt)`,
      )
      .run({
        $name: name,
        $scope: scope,
        $group: null,
        $type: "onetime",
        $pattern: null,
        $reminderText: null,
        $reminderPromptData: null,
        $reminderFallbackText: null,
        $nextRunAt: Date.now() - 1_000,
        $lastRunAt: null,
        $createdAt: Date.now(),
      });
  });
}

describe("CronSingleton runtime safety", () => {
  beforeEach(() => {
    cleanupCronSingleton();
    CronSingleton.setDbFile(TEST_DB);
  });

  afterEach(() => {
    cleanupCronSingleton();
  });

  test("reserved job names still fire generic cron listeners", async () => {
    const cron = CronSingleton.instance;
    await insertDueOneTimeJob(cron, "error", "scope-a");

    const cronEvents: string[] = [];
    cron.onCronEvent((ctx) => {
      cronEvents.push(ctx.name);
    });

    const internals = cron as unknown as TCronSingletonInternals;
    await internals.engine.tick();

    expect(cronEvents).toEqual(["error"]);
  });
});
