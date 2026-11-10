import { afterEach, describe, expect, mock, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { ECronJobStatus, ECronJobType } from "../../../lib/cron-engine";
import { CronSingleton } from "../../cron";
import { DefaultConfigRecord } from "../../settings/schema";
import { SUpdateCronJobArgs, updateCronJob, validateUpdateCronJobArgs } from "./update-cron-job";

const context = {
  chatId: "discord:1",
  settings: DefaultConfigRecord,
  trace: { turnId: "test", chatId: undefined, platform: undefined },
  verifySettings: mock(async () => undefined),
};

afterEach(() => {
  (CronSingleton as unknown as { _instance: unknown })._instance = undefined;
});

describe("update-cron-job", () => {
  test("rejects unknown fields", () => {
    expect(compile(SUpdateCronJobArgs, { formats }).check({ name: "x", unknown: true })).toBe(
      false,
    );
  });

  test("treats blank cron job updates as absent instead of content edits", () => {
    const update = validateUpdateCronJobArgs({
      name: "daily-news",
      pattern: "",
      fireAt: "  ",
      group: "",
      reminderText: "   ",
      reminderPromptData: "",
      reminderFallbackText: "",
      taskPrompt: "",
      taskFallbackText: "",
    });

    expect(update.pattern).toBeUndefined();
    expect(update.fireAt).toBeUndefined();
    expect(update.group).toBeUndefined();
    expect(update.reminderText).toBeUndefined();
    expect(update.taskPrompt).toBeUndefined();
  });

  test("rejects both pattern and fireAt", () => {
    expect(() =>
      validateUpdateCronJobArgs({
        name: "daily-news",
        pattern: "0 8 * * *",
        fireAt: "2026-07-13T10:00:00",
      }),
    ).toThrow("Provide either pattern or fireAt");
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
    const tool = updateCronJob.createAgentTool(context);

    await tool.execute("call", {
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

  describe("update-cron-job schedule fields", () => {
    const recurringJob = {
      id: 1,
      name: "water-plants",
      scope: "discord:1",
      group: undefined,
      type: ECronJobType.Recurring,
      pattern: "0 11 * * 6",
      status: ECronJobStatus.Active,
      nextRunAt: new Date("2026-11-07T10:00:00.000Z"),
      lastRunAt: undefined,
      createdAt: new Date(),
      finishedAt: undefined,
      finishedReason: undefined,
      timezone: "Europe/Warsaw",
      reminderText: "Water the plants",
      reminderPromptData: undefined,
      reminderFallbackText: "Water the plants",
      taskPrompt: undefined,
      taskFallbackText: undefined,
    };
    const oneTimeJob = {
      ...recurringJob,
      type: ECronJobType.OneTime,
      pattern: undefined,
    };
    const generatedContent = {
      reminderPromptData: '{"topic":"plants"}',
      reminderFallbackText: "Time to water the plants",
    };

    function installJob(job: typeof recurringJob | typeof oneTimeJob) {
      const createRecurring = mock(async (args) => ({ ...job, ...args }));
      const createOnce = mock(async (args) => ({ ...job, ...args }));
      (CronSingleton as unknown as { _instance: unknown })._instance = {
        get: mock(async () => job),
        createRecurring,
        createOnce,
      };
      const tool = updateCronJob.createAgentTool(context);

      return { tool, createRecurring, createOnce };
    }

    test("rejects fireAt on recurring jobs", async () => {
      const { tool, createRecurring } = installJob(recurringJob);

      await expect(
        tool.execute("call", {
          name: "water-plants",
          pattern: "",
          fireAt: "2026-10-10T18:35:06+02:00",
          group: "",
          reminderText: "",
          taskPrompt: "",
          taskFallbackText: "",
          ...generatedContent,
        }),
      ).rejects.toThrow("omit fireAt for this recurring reminder");
      expect(createRecurring).not.toHaveBeenCalled();
    });

    test("saves the corrected content-only call and keeps the schedule", async () => {
      const { tool, createRecurring } = installJob(recurringJob);

      await tool.execute("call", { name: "water-plants", ...generatedContent });

      expect(createRecurring).toHaveBeenCalledWith(
        expect.objectContaining({
          pattern: "0 11 * * 6",
          timezone: "Europe/Warsaw",
          reminderText: undefined,
          overwrite: true,
          ...generatedContent,
        }),
      );
    });

    test("treats blank schedule fields as omitted", async () => {
      const { tool, createRecurring } = installJob(recurringJob);

      await tool.execute("call", {
        name: "water-plants",
        pattern: "",
        fireAt: "",
        ...generatedContent,
      });

      expect(createRecurring).toHaveBeenCalledWith(
        expect.objectContaining({ pattern: "0 11 * * 6", ...generatedContent }),
      );
    });

    test("resolves fireAt for one-time jobs after loading the job", async () => {
      const { tool, createOnce } = installJob(oneTimeJob);

      await tool.execute("call", { name: "water-plants", fireAt: "2026-12-25T03:30:00" });

      expect(createOnce).toHaveBeenCalledWith(
        expect.objectContaining({ fireAt: new Date("2026-12-25T02:30:00.000Z") }),
      );
    });

    test("rejects an offset fireAt on one-time jobs", async () => {
      const { tool, createOnce } = installJob(oneTimeJob);

      await expect(
        tool.execute("call", { name: "water-plants", fireAt: "2026-12-25T03:30:00+01:00" }),
      ).rejects.toThrow("no Z or offset");
      expect(createOnce).not.toHaveBeenCalled();
    });

    test("rejects a pattern on one-time jobs", async () => {
      const { tool, createOnce } = installJob(oneTimeJob);

      await expect(
        tool.execute("call", { name: "water-plants", pattern: "0 8 * * *" }),
      ).rejects.toThrow("omit pattern for this one-time reminder");
      expect(createOnce).not.toHaveBeenCalled();
    });
  });
});
