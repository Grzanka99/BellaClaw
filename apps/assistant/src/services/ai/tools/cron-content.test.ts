import { describe, expect, test } from "bun:test";
import { ECronJobStatus, ECronJobType } from "../../cron/types";
import { CommandRejectedError } from "../../events";
import { ERejectionCode } from "../../events/catalog";
import { parseAutomationNames, parseCronContent, runCronJobOperation } from "./cron-content";

describe("parseCronContent", () => {
  test("treats empty and whitespace-only fields as absent", () => {
    for (const blank of ["", "   "]) {
      expect(
        parseCronContent(
          {
            reminderText: blank,
            reminderPromptData: blank,
            reminderFallbackText: blank,
            taskPrompt: blank,
            taskFallbackText: blank,
          },
          false,
        ),
      ).toBeUndefined();
    }
  });

  test("preserves populated fields verbatim", () => {
    expect(parseCronContent({ reminderText: " Buy milk ", taskPrompt: "" }, true)).toEqual({
      kind: "text",
      text: " Buy milk ",
    });
  });

  test("converts each content mode", () => {
    expect(
      parseCronContent({ reminderPromptData: '{"a":1}', reminderFallbackText: "Fallback" }, true),
    ).toEqual({ kind: "generated", promptData: '{"a":1}', fallback: "Fallback" });
    expect(parseCronContent({ taskPrompt: "Find news", taskFallbackText: "None" }, true)).toEqual({
      kind: "task",
      prompt: "Find news",
      fallback: "None",
    });
  });

  test("rejects invalid combinations with stable codes", () => {
    const cases: Array<[Parameters<typeof parseCronContent>[0], boolean, string, string]> = [
      [
        {},
        true,
        "missing-content",
        "Provide reminderText, reminderPromptData, or taskPrompt, or attach automations",
      ],
      [
        { reminderFallbackText: "x" },
        true,
        "missing-content",
        "Provide reminderText, reminderPromptData, or taskPrompt, or attach automations",
      ],
      [
        { reminderText: "a", taskPrompt: "b", taskFallbackText: "c" },
        false,
        "conflicting-content-modes",
        "Provide only one of reminderText, reminderPromptData, or taskPrompt",
      ],
      [
        { reminderPromptData: "{}" },
        false,
        "invalid-fallback-pairing",
        "reminderFallbackText is required when reminderPromptData is set",
      ],
      [
        { reminderFallbackText: "x" },
        false,
        "invalid-fallback-pairing",
        "reminderFallbackText requires reminderText or reminderPromptData",
      ],
      [
        { taskPrompt: "x" },
        false,
        "invalid-fallback-pairing",
        "taskFallbackText is required when taskPrompt is set",
      ],
      [
        { taskFallbackText: "x" },
        false,
        "invalid-fallback-pairing",
        "taskFallbackText requires taskPrompt",
      ],
      [
        { reminderText: "a", automations: ["weather"] },
        false,
        "automations-without-task",
        "automations can only be combined with taskPrompt, not with reminders",
      ],
      [
        { reminderPromptData: "{}", reminderFallbackText: "x", automations: ["weather"] },
        true,
        "automations-without-task",
        "automations can only be combined with taskPrompt, not with reminders",
      ],
      [
        { automations: [" ", ""] },
        true,
        "missing-content",
        "Provide reminderText, reminderPromptData, or taskPrompt, or attach automations",
      ],
    ];

    for (const [args, required, code, message] of cases) {
      let thrown: unknown;
      try {
        if (required) {
          parseCronContent(args, true);
        } else {
          parseCronContent(args, false);
        }
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code, message });
    }
  });
});

describe("automations", () => {
  test("trims names and drops blanks and duplicates, keeping an omitted list omitted", () => {
    expect(parseAutomationNames([" bus ", "", "weather", "bus"])).toEqual(["bus", "weather"]);
    expect(parseAutomationNames([])).toEqual([]);
    expect(parseAutomationNames(undefined)).toBeUndefined();
  });

  test("a new job with automations and no content mode sends only automation text", () => {
    expect(parseCronContent({ automations: ["bus"], reminderText: " " }, true)).toEqual({
      kind: "automations",
    });
    expect(parseCronContent({ automations: ["bus"] }, false)).toBeUndefined();
  });

  test("automations combine with a task", () => {
    expect(
      parseCronContent(
        { automations: ["weather"], taskPrompt: "Umbrella?", taskFallbackText: "Unknown" },
        true,
      ),
    ).toEqual({ kind: "task", prompt: "Umbrella?", fallback: "Unknown" });
    expect(parseCronContent({ automations: [], reminderText: "Hi" }, false)).toEqual({
      kind: "text",
      text: "Hi",
    });
  });
});

describe("runCronJobOperation", () => {
  test("returns the flat job result the model sees", async () => {
    const nextRunAt = new Date("2026-08-01T08:00:00.000Z");
    const createdAt = new Date("2026-07-01T08:00:00.000Z");
    const result = await runCronJobOperation(async () => ({
      id: 1,
      name: "daily",
      scope: "discord:1",
      type: ECronJobType.Recurring,
      pattern: "0 8 * * *",
      content: { kind: "generated", promptData: "{}", fallback: "Fallback" },
      nextRunAt,
      lastRunAt: null,
      createdAt,
      status: ECronJobStatus.Active,
      finishedAt: null,
      finishedReason: null,
      timezone: "Europe/Warsaw",
      automationIds: [],
    }));

    expect(JSON.stringify(result)).toBe(
      JSON.stringify({
        id: 1,
        name: "daily",
        scope: "discord:1",
        type: "recurring",
        pattern: "0 8 * * *",
        nextRunAt,
        createdAt,
        status: "active",
        timezone: "Europe/Warsaw",
        reminderPromptData: "{}",
        reminderFallbackText: "Fallback",
      }),
    );
  });

  test("returns no reminder or task fields for an automations-only job", async () => {
    const result = await runCronJobOperation(async () => ({
      id: 2,
      name: "bus",
      scope: "discord:1",
      type: ECronJobType.Recurring,
      pattern: "0 7 * * *",
      content: { kind: "automations" },
      nextRunAt: new Date("2026-08-01T07:00:00.000Z"),
      lastRunAt: null,
      createdAt: new Date("2026-07-01T07:00:00.000Z"),
      status: ECronJobStatus.Active,
      finishedAt: null,
      finishedReason: null,
      timezone: null,
      automationIds: [3],
    }));

    expect(result).toMatchObject({ name: "bus", pattern: "0 7 * * *" });
    expect(result.reminderText).toBeUndefined();
    expect(result.reminderPromptData).toBeUndefined();
    expect(result.reminderFallbackText).toBeUndefined();
    expect(result.taskPrompt).toBeUndefined();
    expect(result.taskFallbackText).toBeUndefined();
  });

  test("turns rejected cron commands into tool errors with the scheduler code", async () => {
    await expect(
      runCronJobOperation(async () => {
        throw new CommandRejectedError(
          ERejectionCode.Failed,
          "cancel failed: No job found with name: daily",
          "job-not-found",
        );
      }),
    ).rejects.toMatchObject({
      code: "job-not-found",
      message: "cancel failed: No job found with name: daily",
    });
  });
});
