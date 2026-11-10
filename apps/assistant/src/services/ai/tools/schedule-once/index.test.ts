import { afterEach, describe, expect, mock, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { CronScheduler } from "../../../cron";
import { ECronJobStatus, ECronJobType } from "../../../cron/types";
import { DefaultConfigRecord } from "../../../settings/schema";
import { SScheduleOnceArgs, scheduleOnce, validateScheduleOnceArgs } from ".";

const context = {
  chatId: "discord:1",
  settings: DefaultConfigRecord,
  trace: { turnId: "test", chatId: undefined, platform: undefined },
  verifySettings: mock(async () => undefined),
};

afterEach(() => {
  (CronScheduler as unknown as { _instance: unknown })._instance = undefined;
});

describe("schedule-once", () => {
  test("rejects invalid and offset fire dates in the schema", () => {
    expect(compile(SScheduleOnceArgs, { formats }).check({ name: "x", fireAt: "invalid" })).toBe(
      false,
    );
    expect(
      compile(SScheduleOnceArgs, { formats }).check({ name: "x", fireAt: "2026-07-13T12:00:00Z" }),
    ).toBe(false);
  });

  test("resolves local schedule dates with the offset valid at fire time", () => {
    const summer = validateScheduleOnceArgs(
      { name: "summer-reminder", fireAt: "2026-07-13T12:00:00", reminderText: "Reminder" },
      "Europe/Warsaw",
    );
    expect(summer.fireAt).toEqual(new Date("2026-07-13T10:00:00.000Z"));

    const winter = validateScheduleOnceArgs(
      { name: "winter-reminder", fireAt: "2026-10-27T08:00", reminderText: "Reminder" },
      "Europe/Warsaw",
    );
    expect(winter.fireAt).toEqual(new Date("2026-10-27T07:00:00.000Z"));
  });

  test("rejects local schedule dates that do not exist", () => {
    for (const fireAt of ["2027-04-31T10:00:00", "2027-02-29T10:00", "2027-03-28T02:30:00"]) {
      expect(() =>
        validateScheduleOnceArgs({ name: "x", fireAt, reminderText: "Reminder" }, "Europe/Warsaw"),
      ).toThrow("does not exist in Europe/Warsaw");
    }
  });

  test("does not count blank schedule content as a second content mode", () => {
    const once = validateScheduleOnceArgs(
      {
        name: "blank-fields-reminder",
        fireAt: "2026-07-13T12:00:00",
        reminderText: "Reminder",
        reminderPromptData: "",
        reminderFallbackText: "   ",
        taskPrompt: "",
        taskFallbackText: "   ",
      },
      "Europe/Warsaw",
    );
    expect(once.content).toEqual({ kind: "text", text: "Reminder" });
  });

  test("uses the schedule-once handler validation and date conversion", async () => {
    const createOnce = mock(async (args) => ({
      ...args,
      id: 1,
      type: ECronJobType.OneTime,
      status: ECronJobStatus.Active,
      nextRunAt: args.fireAt,
      pattern: null,
      lastRunAt: null,
      createdAt: new Date(),
      finishedAt: null,
      finishedReason: null,
    }));
    (CronScheduler as unknown as { _instance: unknown })._instance = { createOnce };
    const tool = scheduleOnce.createAgentTool(context);

    await expect(
      tool.execute("call", {
        name: "missing-content",
        fireAt: "2026-08-01T10:00:00",
      }),
    ).resolves.toMatchObject({
      isError: true,
      details: { errorCode: "missing-content" },
      content: [
        {
          text: expect.stringContaining("Provide reminderText, reminderPromptData, or taskPrompt"),
        },
      ],
    });

    await tool.execute("call", {
      name: "direct",
      fireAt: "2026-08-01T10:00:00",
      reminderText: "Call Mum",
      reminderFallbackText: "Reminder unavailable",
    });

    expect(createOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "discord:1",
        fireAt: new Date("2026-08-01T08:00:00.000Z"),
        content: { kind: "text", text: "Call Mum" },
      }),
    );
  });
});
