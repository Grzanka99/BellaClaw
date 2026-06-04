import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AsyncQueue } from "../../utils/async-queue";
import { DatabaseConnector } from "../database";
import { cronEngineJobsTable } from "../database/schema";
import { resetCronEngineJobsTable } from "../database/test-utils";
import { CronSingleton } from "./index";

type TEngineWithInternals = {
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
}

async function insertDueOneTimeJob(cron: CronSingleton, name: string, scope: string) {
  const internals = cron as unknown as TCronSingletonInternals;
  const db = DatabaseConnector.instance.database;

  await internals.engine.queue.enqueue(async () => {
    await db.insert(cronEngineJobsTable).values({
      name,
      scope,
      group: null,
      type: "onetime",
      pattern: null,
      reminderText: null,
      reminderPromptData: null,
      reminderFallbackText: null,
      nextRunAt: Date.now() - 1_000,
      lastRunAt: null,
      createdAt: Date.now(),
    });
  });
}

describe("CronSingleton runtime safety", () => {
  beforeEach(async () => {
    cleanupCronSingleton();
    await resetCronEngineJobsTable();
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
