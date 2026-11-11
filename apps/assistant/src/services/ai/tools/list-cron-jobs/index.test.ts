import { afterEach, describe, expect, mock, test } from "bun:test";
import { AutomationService } from "../../../automation";
import { CronScheduler } from "../../../cron";
import { ECronJobStatus, ECronJobType, type TCronJob } from "../../../cron/types";
import { DefaultConfigRecord } from "../../../settings/schema";
import { listCronJobs } from ".";

const context = {
  chatId: "discord:1",
  settings: DefaultConfigRecord,
  trace: { turnId: "test", chatId: undefined, platform: undefined },
  verifySettings: mock(async () => undefined),
  runScheduledTask: mock(async () => {
    throw new Error("not used");
  }),
};

afterEach(() => {
  (CronScheduler as unknown as { _instance: unknown })._instance = undefined;
  (AutomationService as unknown as { _instance: unknown })._instance = undefined;
});

describe("list-cron-jobs", () => {
  test("shows attached automations by name in run order, skipping deleted ones", async () => {
    const job: TCronJob = {
      id: 1,
      name: "bus",
      scope: "discord:1",
      type: ECronJobType.Recurring,
      pattern: "0 7 * * *",
      status: ECronJobStatus.Active,
      nextRunAt: new Date("2026-08-01T05:00:00.000Z"),
      lastRunAt: null,
      createdAt: new Date(),
      finishedAt: null,
      finishedReason: null,
      timezone: "Europe/Warsaw",
      content: { kind: "automations" },
      automationIds: [5, 9, 2],
    };
    const getByIds = mock(async () => [
      { id: 2, name: "tram" },
      { id: 5, name: "bus" },
    ]);
    (CronScheduler as unknown as { _instance: unknown })._instance = {
      list: mock(async () => [job, { ...job, id: 2, name: "plain", automationIds: [] }]),
    };
    (AutomationService as unknown as { _instance: unknown })._instance = { getByIds };

    const result = await listCronJobs.createAgentTool(context).execute("call", {});

    expect(getByIds).toHaveBeenCalledWith("discord:1", [5, 9, 2]);
    expect(result.details).toMatchObject([
      { name: "bus", automations: ["bus", "tram"] },
      { name: "plain", automations: [] },
    ]);
  });
});
