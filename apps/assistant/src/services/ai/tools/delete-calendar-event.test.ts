import { afterEach, describe, expect, mock, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { CalendarService } from "../../calendar";
import { DefaultConfigRecord } from "../../settings/schema";
import { deleteCalendarEvent, SDeleteCalendarEventArgs } from "./delete-calendar-event";
import { removeReadonlyCalendar } from "./remove-readonly-calendar";

const context = {
  chatId: "discord:1",
  settings: DefaultConfigRecord,
  trace: { turnId: "test", chatId: undefined, platform: undefined },
  verifySettings: mock(async () => undefined),
};

afterEach(() => {
  (CalendarService as unknown as { _instance: unknown })._instance = undefined;
});

describe("delete-calendar-event", () => {
  test("accepts valid args", () => {
    expect(
      compile(SDeleteCalendarEventArgs, { formats }).check({
        eventId: "event",
        scope: "occurrence",
      }),
    ).toBe(true);
  });

  test("returns explicit success for void calendar mutations", async () => {
    const removeReadonlyCalendarMock = mock(async () => undefined);
    const deleteEvent = mock(async () => undefined);
    (CalendarService as unknown as { _instance: unknown })._instance = {
      removeReadonlyCalendar: removeReadonlyCalendarMock,
      deleteEvent,
    };

    const removeResult = await removeReadonlyCalendar
      .createAgentTool(context)
      .execute("remove", { calendarId: "shared" });
    const deleteResult = await deleteCalendarEvent
      .createAgentTool(context)
      .execute("delete", { eventId: "event", scope: "series" });

    expect(removeResult.details).toEqual({ success: true });
    expect(deleteResult.details).toEqual({ success: true });
  });
});
