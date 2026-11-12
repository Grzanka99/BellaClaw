import { afterEach, describe, expect, mock, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { AutomationError, AutomationService } from "../../../automation";
import { ECronJobStatus, ECronJobType } from "../../../cron/types";
import type { TEventRequester } from "../../../events";
import { EEventType } from "../../../events/catalog";
import { testEventRequester } from "../../../events/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { SScheduleOnceArgs, scheduleOnce, validateScheduleOnceArgs } from ".";

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

// answers cron.job.schedule.requested with the scheduled job
function createRequester() {
  const request = mock(async (_type: EEventType, payload: Record<string, unknown>) => ({
    payload: {
      job: {
        ...payload,
        id: 1,
        type: ECronJobType.OneTime,
        status: ECronJobStatus.Active,
        nextRunAt: payload.fireAt,
        createdAt: Date.now(),
      },
    },
  }));
  const events = {
    ...testEventRequester,
    request: request as unknown as TEventRequester["request"],
  };

  return { request, context: { ...context, events } };
}

afterEach(() => {
  (AutomationService as unknown as { _instance: unknown })._instance = undefined;
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

  test("requests the schedule with validated content and the fire time in ms", async () => {
    const { request, context } = createRequester();
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

    const result = await tool.execute("call-2", {
      name: "direct",
      fireAt: "2026-08-01T10:00:00",
      reminderText: "Call Mum",
      reminderFallbackText: "Reminder unavailable",
    });

    expect(request).toHaveBeenCalledWith(
      EEventType.CronJobScheduleRequested,
      expect.objectContaining({
        scope: "discord:1",
        fireAt: Date.parse("2026-08-01T08:00:00.000Z"),
        content: { kind: "text", text: "Call Mum" },
      }),
      expect.objectContaining({
        outcome: EEventType.CronJobScheduled,
        step: expect.stringMatching(/^call-2:/),
      }),
    );
    expect(result.details).toMatchObject({
      name: "direct",
      nextRunAt: new Date("2026-08-01T08:00:00.000Z"),
      reminderText: "Call Mum",
    });
  });

  test("resolves automation names to ids for an automations-only job", async () => {
    const { request, context } = createRequester();
    const resolveNames = mock(async (_scope: string, names: string[]) => {
      if (names.includes("missing")) {
        throw new AutomationError("unknown-automation", "Unknown automations: missing");
      }

      return [7, 3];
    });
    (AutomationService as unknown as { _instance: unknown })._instance = { resolveNames };
    const tool = scheduleOnce.createAgentTool(context);

    await tool.execute("call", {
      name: "bus",
      fireAt: "2026-08-01T07:00:00",
      automations: [" bus ", "tram", "bus", ""],
    });

    expect(resolveNames).toHaveBeenCalledWith("discord:1", ["bus", "tram"]);
    expect(request).toHaveBeenCalledWith(
      EEventType.CronJobScheduleRequested,
      expect.objectContaining({ content: { kind: "automations" }, automationIds: [7, 3] }),
      expect.anything(),
    );

    await expect(
      tool.execute("call", {
        name: "bus",
        fireAt: "2026-08-01T07:00:00",
        automations: ["missing"],
      }),
    ).resolves.toMatchObject({ isError: true, details: { errorCode: "unknown-automation" } });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
