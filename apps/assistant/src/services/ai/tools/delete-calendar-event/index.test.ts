import { describe, expect, mock, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import type { TEventRequester } from "../../../events";
import { EEventType } from "../../../events/catalog";
import { testEventRequester } from "../../../events/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { removeReadonlyCalendar } from "../remove-readonly-calendar";
import { deleteCalendarEvent, SDeleteCalendarEventArgs } from ".";

function contextWith(request: ReturnType<typeof mock>) {
  return {
    chatId: "discord:1",
    settings: DefaultConfigRecord,
    trace: { turnId: "test", chatId: undefined, platform: undefined },
    events: { ...testEventRequester, request: request as unknown as TEventRequester["request"] },
    verifySettings: mock(async () => undefined),
    runScheduledTask: mock(async () => {
      throw new Error("not used");
    }),
  };
}

describe("delete-calendar-event", () => {
  test("accepts valid args", () => {
    expect(
      compile(SDeleteCalendarEventArgs, { formats }).check({
        eventId: "event",
        scope: "occurrence",
      }),
    ).toBe(true);
  });

  test("requests void calendar mutations and returns explicit success", async () => {
    const request = mock(async () => ({ payload: {} }));
    const context = contextWith(request);

    const removeResult = await removeReadonlyCalendar
      .createAgentTool(context)
      .execute("remove", { calendarId: "shared" });
    const deleteResult = await deleteCalendarEvent
      .createAgentTool(context)
      .execute("delete", { eventId: "event", scope: "series" });

    expect(request).toHaveBeenCalledWith(
      EEventType.CalendarSourceRemoveRequested,
      { chatId: "discord:1", calendarId: "shared" },
      expect.objectContaining({ outcome: EEventType.CalendarSourceRemoved, key: "discord:1" }),
    );
    expect(request).toHaveBeenCalledWith(
      EEventType.CalendarEventDeleteRequested,
      { chatId: "discord:1", eventId: "event", scope: "series" },
      expect.objectContaining({ outcome: EEventType.CalendarEventDeleted, key: "discord:1" }),
    );
    expect(removeResult.details).toEqual({ success: true });
    expect(deleteResult.details).toEqual({ success: true });
  });
});
