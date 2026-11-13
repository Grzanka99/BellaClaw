import { afterEach, describe, expect, mock, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { AutomationService } from "../../../automation";
import { CronScheduler } from "../../../cron";
import { ECronJobStatus, ECronJobType, type TCronJob, toCronJobRecord } from "../../../cron/types";
import type { TEventRequester } from "../../../events";
import { testEventRequester } from "../../../events/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { SUpdateCronJobArgs, updateCronJob, validateUpdateCronJobArgs } from ".";

const context = {
  chatId: "discord:1",
  settings: DefaultConfigRecord,
  trace: { turnId: "test", chatId: undefined, platform: undefined },
  events: testEventRequester,
  verifySettings: mock(async () => undefined),
  runScheduledTask: mock(async () => {
    throw new Error("not used");
  }),
};

// records the schedule requests the tool sends and answers with the job
function createEvents(job: TCronJob) {
  const createRecurring = mock(async (_payload: Record<string, unknown>) => undefined);
  const createOnce = mock(async (_payload: Record<string, unknown>) => undefined);
  const request = async (_type: unknown, payload: Record<string, unknown>) => {
    if ("pattern" in payload) {
      await createRecurring(payload);
    } else {
      await createOnce(payload);
    }

    return { payload: { job: toCronJobRecord(job) } };
  };
  const events = {
    ...testEventRequester,
    request: request as unknown as TEventRequester["request"],
  };

  return { createRecurring, createOnce, events };
}

afterEach(() => {
  (CronScheduler as unknown as { _instance: unknown })._instance = undefined;
  (AutomationService as unknown as { _instance: unknown })._instance = undefined;
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
      reminderText: "   ",
      reminderPromptData: "",
      reminderFallbackText: "",
      taskPrompt: "",
      taskFallbackText: "",
    });

    expect(update.pattern).toBeUndefined();
    expect(update.fireAt).toBeUndefined();
    expect(update.content).toBeUndefined();
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

  test("replaces content and keeps the schedule when only content is updated", async () => {
    const existing: TCronJob = {
      id: 1,
      name: "daily",
      scope: "discord:1",
      type: ECronJobType.Recurring,
      pattern: "0 8 * * *",
      status: ECronJobStatus.Active,
      nextRunAt: new Date("2026-08-01T08:00:00.000Z"),
      lastRunAt: null,
      createdAt: new Date(),
      finishedAt: null,
      finishedReason: null,
      timezone: "Europe/Warsaw",
      automationIds: [],
      content: { kind: "task", prompt: "Old task", fallback: "Old fallback" },
    };
    const { createRecurring, events } = createEvents(existing);
    (CronScheduler as unknown as { _instance: unknown })._instance = {
      get: mock(async () => existing),
    };
    const tool = updateCronJob.createAgentTool({ ...context, events });

    await tool.execute("call", {
      name: "daily",
      reminderText: "New",
    });

    expect(createRecurring).toHaveBeenCalledWith(
      expect.objectContaining({
        pattern: "0 8 * * *",
        content: { kind: "text", text: "New" },
        overwrite: true,
      }),
    );
  });

  describe("update-cron-job schedule fields", () => {
    const recurringJob: TCronJob = {
      id: 1,
      name: "water-plants",
      scope: "discord:1",
      type: ECronJobType.Recurring,
      pattern: "0 11 * * 6",
      status: ECronJobStatus.Active,
      nextRunAt: new Date("2026-11-07T10:00:00.000Z"),
      lastRunAt: null,
      createdAt: new Date(),
      finishedAt: null,
      finishedReason: null,
      timezone: "Europe/Warsaw",
      automationIds: [],
      content: { kind: "text", text: "Water the plants" },
    };
    const oneTimeJob: TCronJob = {
      ...recurringJob,
      type: ECronJobType.OneTime,
      pattern: null,
    };
    const generatedContent = {
      reminderPromptData: '{"topic":"plants"}',
      reminderFallbackText: "Time to water the plants",
    };
    const generatedJobContent = {
      kind: "generated",
      promptData: '{"topic":"plants"}',
      fallback: "Time to water the plants",
    };

    function installJob(job: TCronJob) {
      const { createRecurring, createOnce, events } = createEvents(job);
      (CronScheduler as unknown as { _instance: unknown })._instance = {
        get: mock(async () => job),
      };
      const tool = updateCronJob.createAgentTool({ ...context, events });

      return { tool, createRecurring, createOnce };
    }

    test("rejects fireAt on recurring jobs", async () => {
      const { tool, createRecurring } = installJob(recurringJob);

      await expect(
        tool.execute("call", {
          name: "water-plants",
          pattern: "",
          fireAt: "2026-10-10T18:35:06+02:00",
          reminderText: "",
          taskPrompt: "",
          taskFallbackText: "",
          ...generatedContent,
        }),
      ).resolves.toMatchObject({
        isError: true,
        details: { errorCode: "fire-at-on-recurring-job" },
        content: [{ text: expect.stringContaining("omit fireAt for this recurring reminder") }],
      });
      expect(createRecurring).not.toHaveBeenCalled();
    });

    test("saves the corrected content-only call and keeps the schedule", async () => {
      const { tool, createRecurring } = installJob(recurringJob);

      await tool.execute("call", { name: "water-plants", ...generatedContent });

      expect(createRecurring).toHaveBeenCalledWith(
        expect.objectContaining({
          pattern: "0 11 * * 6",
          timezone: "Europe/Warsaw",
          overwrite: true,
          content: generatedJobContent,
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
        expect.objectContaining({ pattern: "0 11 * * 6", content: generatedJobContent }),
      );
    });

    test("resolves fireAt for one-time jobs after loading the job", async () => {
      const { tool, createOnce } = installJob(oneTimeJob);

      await tool.execute("call", { name: "water-plants", fireAt: "2026-12-25T03:30:00" });

      expect(createOnce).toHaveBeenCalledWith(
        expect.objectContaining({
          fireAt: Date.parse("2026-12-25T02:30:00.000Z"),
          content: { kind: "text", text: "Water the plants" },
        }),
      );
    });

    test("rejects an offset fireAt on one-time jobs", async () => {
      const { tool, createOnce } = installJob(oneTimeJob);

      await expect(
        tool.execute("call", { name: "water-plants", fireAt: "2026-12-25T03:30:00+01:00" }),
      ).resolves.toMatchObject({
        isError: true,
        details: { errorCode: "invalid-fire-at" },
        content: [{ text: expect.stringContaining("no Z or offset") }],
      });
      expect(createOnce).not.toHaveBeenCalled();
    });

    test("rejects a pattern on one-time jobs", async () => {
      const { tool, createOnce } = installJob(oneTimeJob);

      await expect(
        tool.execute("call", { name: "water-plants", pattern: "0 8 * * *" }),
      ).resolves.toMatchObject({
        isError: true,
        details: { errorCode: "pattern-on-one-time-job" },
        content: [{ text: expect.stringContaining("omit pattern for this one-time reminder") }],
      });
      expect(createOnce).not.toHaveBeenCalled();
    });
  });

  describe("update-cron-job automations", () => {
    const taskJob: TCronJob = {
      id: 1,
      name: "briefing",
      scope: "discord:1",
      type: ECronJobType.Recurring,
      pattern: "0 8 * * *",
      status: ECronJobStatus.Active,
      nextRunAt: new Date("2026-08-01T08:00:00.000Z"),
      lastRunAt: null,
      createdAt: new Date(),
      finishedAt: null,
      finishedReason: null,
      timezone: "Europe/Warsaw",
      automationIds: [4],
      content: { kind: "task", prompt: "Write my briefing.", fallback: "Unavailable." },
    };
    const automationsJob: TCronJob = {
      ...taskJob,
      content: { kind: "automations" },
    };

    function installJob(job: TCronJob) {
      const { createRecurring, events } = createEvents(job);
      const resolveNames = mock(async (_scope: string, names: string[]) =>
        names.map((_name, index) => index + 10),
      );
      (CronScheduler as unknown as { _instance: unknown })._instance = {
        get: mock(async () => job),
      };
      (AutomationService as unknown as { _instance: unknown })._instance = { resolveNames };

      return {
        tool: updateCronJob.createAgentTool({ ...context, events }),
        createRecurring,
        resolveNames,
      };
    }

    test("keeps attached automations when the list is omitted", async () => {
      const { tool, createRecurring, resolveNames } = installJob(taskJob);

      await tool.execute("call", { name: "briefing", pattern: "0 9 * * *" });

      expect(resolveNames).not.toHaveBeenCalled();
      expect(createRecurring).toHaveBeenCalledWith(
        expect.objectContaining({ pattern: "0 9 * * *", automationIds: [4] }),
      );
    });

    test("replaces the list with the supplied names", async () => {
      const { tool, createRecurring, resolveNames } = installJob(taskJob);

      await tool.execute("call", { name: "briefing", automations: ["news", "weather"] });

      expect(resolveNames).toHaveBeenCalledWith("discord:1", ["news", "weather"]);
      expect(createRecurring).toHaveBeenCalledWith(
        expect.objectContaining({ content: taskJob.content, automationIds: [10, 11] }),
      );
    });

    test("switching to a reminder requires clearing the automations in the same call", async () => {
      const { tool, createRecurring } = installJob(taskJob);

      await expect(
        tool.execute("call", { name: "briefing", reminderText: "Stretch." }),
      ).resolves.toMatchObject({
        isError: true,
        details: { errorCode: "automations-without-task" },
        content: [{ text: expect.stringContaining("also pass automations: []") }],
      });
      expect(createRecurring).not.toHaveBeenCalled();

      await tool.execute("call", { name: "briefing", reminderText: "Stretch.", automations: [] });

      expect(createRecurring).toHaveBeenCalledWith(
        expect.objectContaining({ content: { kind: "text", text: "Stretch." }, automationIds: [] }),
      );
    });

    test("rejects clearing every automation of a job without its own content", async () => {
      const { tool, createRecurring } = installJob(automationsJob);

      await expect(
        tool.execute("call", { name: "briefing", automations: [] }),
      ).resolves.toMatchObject({
        isError: true,
        details: { errorCode: "missing-content" },
        content: [{ text: expect.stringContaining("removing all automations") }],
      });
      expect(createRecurring).not.toHaveBeenCalled();

      await tool.execute("call", {
        name: "briefing",
        automations: [],
        taskPrompt: "Summarize.",
        taskFallbackText: "Nothing.",
      });

      expect(createRecurring).toHaveBeenCalledWith(
        expect.objectContaining({
          content: { kind: "task", prompt: "Summarize.", fallback: "Nothing." },
          automationIds: [],
        }),
      );
    });
  });
});
