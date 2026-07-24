import { afterEach, describe, expect, mock, test } from "bun:test";
import { ECronJobStatus, ECronJobType } from "../../../lib/cron-engine";
import { CronSingleton } from "../../cron";
import { Memory } from "../../memory";
import { SettingsService } from "../../settings";
import { DefaultConfigRecord, EConfigKey } from "../../settings/schema";
import { EAiProvider, EModelPurpose } from "../types";
import { createMemoryTools, createSchedulingTools, createSettingsTools } from "./executable";

const context = {
  chatId: "discord:1",
  settings: DefaultConfigRecord,
  verifySettings: mock(async () => undefined),
};

function reset() {
  (CronSingleton as unknown as { _instance: unknown })._instance = undefined;
  (Memory as unknown as { _instance: unknown })._instance = undefined;
  (SettingsService as unknown as { _instance: unknown })._instance = undefined;
}

afterEach(reset);

describe("production executable tools", () => {
  test("uses the schedule-once handler validation and date conversion", async () => {
    const createOnce = mock(async (args) => ({
      ...args,
      id: 1,
      type: ECronJobType.OneTime,
      status: ECronJobStatus.Active,
      nextRunAt: args.fireAt,
      lastRunAt: undefined,
      createdAt: new Date(),
      finishedAt: undefined,
      finishedReason: undefined,
    }));
    (CronSingleton as unknown as { _instance: unknown })._instance = { createOnce };
    const tool = createSchedulingTools(context).find(
      (candidate) => candidate.name === "schedule-once",
    );

    await expect(
      tool?.execute("call", {
        name: "missing-content",
        fireAt: "2026-08-01T10:00:00+02:00",
      }),
    ).rejects.toThrow("Provide reminderText, reminderPromptData, or taskPrompt");

    await tool?.execute("call", {
      name: "direct",
      fireAt: "2026-08-01T10:00:00+02:00",
      reminderText: "Call Mum",
      reminderFallbackText: "Reminder unavailable",
    });

    expect(createOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "discord:1",
        fireAt: new Date("2026-08-01T08:00:00.000Z"),
        reminderText: "Call Mum",
        reminderFallbackText: "Reminder unavailable",
      }),
    );
  });

  test("preserves existing fallback when updating cron content without a new fallback", async () => {
    const existing = {
      id: 1,
      name: "daily",
      scope: "discord:1",
      group: undefined,
      type: ECronJobType.Recurring,
      pattern: "0 8 * * *",
      status: ECronJobStatus.Active,
      nextRunAt: new Date("2026-08-01T08:00:00.000Z"),
      lastRunAt: undefined,
      createdAt: new Date(),
      finishedAt: undefined,
      finishedReason: undefined,
      timezone: "Europe/Warsaw",
      reminderText: "Old",
      reminderPromptData: undefined,
      reminderFallbackText: "Existing fallback",
      taskPrompt: undefined,
      taskFallbackText: undefined,
    };
    const createRecurring = mock(async (args) => ({ ...existing, ...args }));
    (CronSingleton as unknown as { _instance: unknown })._instance = {
      get: mock(async () => existing),
      createRecurring,
    };
    const tool = createSchedulingTools(context).find(
      (candidate) => candidate.name === "update-cron-job",
    );

    await tool?.execute("call", {
      name: "daily",
      reminderText: "New",
    });

    expect(createRecurring).toHaveBeenCalledWith(
      expect.objectContaining({
        reminderText: "New",
        reminderFallbackText: "Existing fallback",
        reminderPromptData: undefined,
        taskPrompt: undefined,
      }),
    );
  });

  test("propagates service failures as model-visible tool errors", async () => {
    (CronSingleton as unknown as { _instance: unknown })._instance = {
      cancel: mock(async () => ({ operation: "cancel", error: "database unavailable" })),
    };
    const tool = createSchedulingTools(context).find(
      (candidate) => candidate.name === "unschedule-cron-job",
    );

    await expect(tool?.execute("call", { name: "daily" })).rejects.toThrow(
      "cancel failed: database unavailable",
    );
  });

  test("verifies every model purpose used by the harness before changing providers", async () => {
    const verifySettings = mock(async () => "verification failed");
    (SettingsService as unknown as { _instance: unknown })._instance = {
      getAll: mock(async () => DefaultConfigRecord),
    };
    const tool = createSettingsTools({ ...context, verifySettings }).find(
      (candidate) => candidate.name === "update-settings",
    );

    await expect(tool?.execute("call", { aiProvider: EAiProvider.Openrouter })).rejects.toThrow(
      "verification failed",
    );
    expect(verifySettings).toHaveBeenCalledWith(
      expect.objectContaining({
        [EConfigKey.AiProvider]: EAiProvider.Openrouter,
      }),
      [EModelPurpose.ToolCheap, EModelPurpose.ToolAccurate, EModelPurpose.ChatAccurate],
    );
  });

  test("uses the memory handler converter and propagates memory failures", async () => {
    const find = mock(async () => ({ operation: "find", error: "database unavailable" }));
    (Memory as unknown as { _instance: unknown })._instance = { find };
    const tool = createMemoryTools(context)[0];

    await expect(
      tool?.execute("call", {
        timeRange: {
          start: "2026-08-01T10:00:00+02:00",
          end: "2026-08-01T11:00:00+02:00",
        },
      }),
    ).rejects.toThrow("Memory find failed: database unavailable");
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        timeRange: {
          start: new Date("2026-08-01T08:00:00.000Z"),
          end: new Date("2026-08-01T09:00:00.000Z"),
        },
      }),
    );
  });
});
