import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AsyncQueue } from "@bellaclaw/shared";
import { ECronJobStatus, ECronJobType } from "../../lib/cron-engine";
import { DatabaseConnector } from "../database";
import { cronEngineJobsTable } from "../database/schema";
import { resetCronEngineJobsTable } from "../database/test-utils";
import { CronSingleton } from "./index";

type TCronSingletonInternals = {
  fire: (id: number) => Promise<void>;
  queue: AsyncQueue;
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

  const row = await internals.queue.enqueue(async () => {
    return db
      .insert(cronEngineJobsTable)
      .values({
        name,
        scope,
        group: null,
        type: ECronJobType.OneTime,
        pattern: null,
        reminderText: null,
        reminderPromptData: null,
        reminderFallbackText: null,
        nextRunAt: Date.now() - 1_000,
        lastRunAt: null,
        createdAt: Date.now(),
        status: ECronJobStatus.Active,
        finishedAt: null,
        finishedReason: null,
      })
      .returning()
      .get();
  });

  return row.id;
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
    const id = await insertDueOneTimeJob(cron, "error", "scope-a");

    const cronEvents: string[] = [];
    cron.onFire((ctx) => {
      cronEvents.push(ctx.name);
    });

    const internals = cron as unknown as TCronSingletonInternals;
    await internals.fire(id);

    expect(cronEvents).toEqual(["error"]);
  });
});
