import { describe, expect, test } from "bun:test";
import { calculateAvailability } from "./availability";
import type { TCalendarEvent } from "./types";

function event(
  id: string,
  start: string,
  end: string,
  status?: string,
  transparency?: string,
): TCalendarEvent {
  return {
    calendarId: "calendar",
    id,
    etag: undefined,
    status,
    colorId: undefined,
    eventLabelId: undefined,
    eventLabelVersion: undefined,
    sequence: undefined,
    endTimeUnspecified: undefined,
    attendeesOmitted: undefined,
    gadget: undefined,
    eventType: "default",
    summary: id,
    description: undefined,
    location: undefined,
    start: { date: undefined, dateTime: start, timeZone: "UTC" },
    end: { date: undefined, dateTime: end, timeZone: "UTC" },
    transparency,
    recurrence: [],
    recurringEventId: undefined,
    originalStartTime: undefined,
    organizer: undefined,
    creator: undefined,
    attendees: [],
    attachments: [],
    hangoutLink: undefined,
    conferenceData: undefined,
    htmlLink: undefined,
    visibility: undefined,
    created: undefined,
    updated: undefined,
    iCalUID: undefined,
    reminders: undefined,
    googleDetails: undefined,
    unsupportedManagedFields: [],
  };
}

describe("calendar availability", () => {
  test("filters free/cancelled events, merges overlaps, and preserves failures", () => {
    const result = calculateAvailability(
      [
        event("one", "2026-07-25T09:00:00Z", "2026-07-25T10:00:00Z"),
        event("two", "2026-07-25T09:30:00Z", "2026-07-25T11:00:00Z"),
        event("free", "2026-07-25T12:00:00Z", "2026-07-25T13:00:00Z", undefined, "transparent"),
        event("gone", "2026-07-25T14:00:00Z", "2026-07-25T15:00:00Z", "cancelled"),
      ],
      [{ calendarId: "revoked", error: "forbidden" }],
      "2026-07-25T08:00:00Z",
      "2026-07-25T16:00:00Z",
      "UTC",
      60,
    );

    expect(result.busy).toHaveLength(1);
    expect(result.busy[0]?.end).toBe("2026-07-25T11:00:00.000Z");
    expect(result.busy[0]?.events).toHaveLength(2);
    expect(result.free).toEqual([]);
    expect(result.failures).toEqual([{ calendarId: "revoked", error: "forbidden" }]);
  });

  test("does not claim free slots when every source failed", () => {
    const result = calculateAvailability(
      [],
      [
        { calendarId: "one", error: "forbidden" },
        { calendarId: "two", error: "unavailable" },
      ],
      "2026-07-25T08:00:00Z",
      "2026-07-25T16:00:00Z",
      "UTC",
      60,
    );

    expect(result.busy).toEqual([]);
    expect(result.free).toEqual([]);
    expect(result.failures).toHaveLength(2);
  });

  test("uses owner timezone DST boundaries for all-day events", () => {
    const allDay = event("holiday", "", "");
    allDay.start = { date: "2026-03-29", dateTime: undefined, timeZone: undefined };
    allDay.end = { date: "2026-03-30", dateTime: undefined, timeZone: undefined };

    const result = calculateAvailability(
      [allDay],
      [],
      "2026-03-28T23:00:00Z",
      "2026-03-29T22:00:00Z",
      "Europe/Warsaw",
    );

    expect(result.busy).toEqual([
      {
        start: "2026-03-28T23:00:00.000Z",
        end: "2026-03-29T22:00:00.000Z",
        events: [allDay],
      },
    ]);
  });
});
