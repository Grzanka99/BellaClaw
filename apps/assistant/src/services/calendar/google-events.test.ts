import { describe, expect, test } from "bun:test";
import { validateUpdateCalendarEventArgs } from "../ai/tools/update-calendar-event/handler";
import { calendarAdapter, googleEvent, writeCalendarDatabase } from "./google-fixtures.test";
import type { GwsCalendarClient } from "./gws";

const database = writeCalendarDatabase();

describe("Google calendar regression", () => {
  test("routes occurrence, series, and following updates", async () => {
    const patched: string[] = [];
    const inserted: Record<string, unknown>[] = [];
    const events = new Map<string, unknown>([
      [
        "instance",
        googleEvent("instance", {
          recurringEventId: "master",
          originalStartTime: { dateTime: "2026-07-25T09:00:00Z" },
        }),
      ],
      [
        "master",
        googleEvent("master", {
          status: "confirmed",
          colorId: "7",
          sequence: 3,
          start: { dateTime: "2026-07-24T09:00:00Z" },
          end: { dateTime: "2026-07-24T10:00:00Z" },
          recurrence: ["RRULE:FREQ=DAILY;UNTIL=20260801T090000Z"],
        }),
      ],
    ]);
    const client = {
      getEvent: async (_calendarId: string, eventId: string) => events.get(eventId),
      patchEvent: async (_calendarId: string, eventId: string, body: Record<string, unknown>) => {
        patched.push(eventId);
        return googleEvent(eventId, body);
      },
      insertEvent: async (_calendarId: string, body: Record<string, unknown>) => {
        inserted.push(body);
        return googleEvent("successor", body);
      },
    } as unknown as GwsCalendarClient;
    const service = calendarAdapter(database, client);
    const patch = {
      summary: "Changed",
      description: undefined,
      location: undefined,
      start: undefined,
      end: undefined,
      durationMinutes: undefined,
      timezone: undefined,
      transparency: undefined,
      recurrence: undefined,
    };

    await service.updateEvent({
      userId: "user-1",
      eventId: "google:trusted-writer:instance",
      scope: "occurrence",
      patch,
      signal: undefined,
    });
    await service.updateEvent({
      userId: "user-1",
      eventId: "google:trusted-writer:instance",
      scope: "series",
      patch,
      signal: undefined,
    });
    await service.updateEvent({
      userId: "user-1",
      eventId: "google:trusted-writer:instance",
      scope: "following",
      patch,
      signal: undefined,
    });

    expect(patched).toEqual(["instance", "master", "master"]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.summary).toBe("Changed");
    expect(inserted[0]?.status).toBe("confirmed");
    expect(inserted[0]?.colorId).toBe("7");
    expect(inserted[0]?.sequence).toBe(3);
  });

  for (const conversion of [
    {
      name: "timed to all-day",
      masterStart: { dateTime: "2026-07-24T09:00:00Z" },
      masterEnd: { dateTime: "2026-07-24T10:00:00Z" },
      occurrenceStart: { dateTime: "2026-07-25T09:00:00Z" },
      occurrenceEnd: { dateTime: "2026-07-25T10:00:00Z" },
      start: "2026-07-25",
    },
    {
      name: "all-day to timed",
      masterStart: { date: "2026-07-24" },
      masterEnd: { date: "2026-07-25" },
      occurrenceStart: { date: "2026-07-25" },
      occurrenceEnd: { date: "2026-07-26" },
      start: "2026-07-25T09:00:00Z",
    },
  ]) {
    test(`rejects an incomplete ${conversion.name} following conversion without writes`, async () => {
      const writes: string[] = [];
      const recurrence = ["RRULE:FREQ=DAILY;COUNT=10"];
      const master = googleEvent("master", {
        start: conversion.masterStart,
        end: conversion.masterEnd,
        recurrence,
      });
      const events = new Map<string, unknown>([
        ["master", master],
        [
          "instance",
          googleEvent("instance", {
            recurringEventId: "master",
            originalStartTime: conversion.occurrenceStart,
            start: conversion.occurrenceStart,
            end: conversion.occurrenceEnd,
          }),
        ],
      ]);
      const client = {
        getEvent: async (_calendarId: string, eventId: string) => events.get(eventId),
        patchEvent: async (_calendarId: string, eventId: string, body: Record<string, unknown>) => {
          writes.push("patch");
          Object.assign(master, body);
          return googleEvent(eventId, body);
        },
        insertEvent: async (_calendarId: string, body: Record<string, unknown>) => {
          writes.push("insert");
          return googleEvent("successor", body);
        },
      } as unknown as GwsCalendarClient;
      const service = calendarAdapter(database, client);
      const patch = validateUpdateCalendarEventArgs({
        eventId: "google:trusted-writer:instance",
        scope: "following",
        start: conversion.start,
      });

      await expect(
        service.updateEvent({
          userId: "user-1",
          eventId: "google:trusted-writer:instance",
          scope: "following",
          patch,
        }),
      ).rejects.toThrow("requires an explicit end or duration");
      expect(writes).toEqual([]);
      expect(master).toHaveProperty("recurrence", recurrence);
    });
  }

  test("returns extended Google details without using them as mutation input", async () => {
    const client = {
      insertEvent: async () =>
        googleEvent("created", {
          etag: '"etag"',
          sequence: 4,
          attendees: [
            {
              id: "person-id",
              email: "guest@example.com",
              optional: true,
              resource: false,
              comment: "Maybe",
              additionalGuests: 2,
            },
          ],
          workingLocationProperties: { type: "homeOffice" },
        }),
    } as unknown as GwsCalendarClient;
    const service = calendarAdapter(database, client);

    const result = await service.createEvent({
      userId: "user-1",
      summary: "Read details",
      start: "2026-07-25T09:00:00Z",
      timezone: "UTC",
    });

    expect(result.etag).toBe('"etag"');
    expect(result.sequence).toBe(4);
    expect(result.attendees[0]).toMatchObject({
      id: "person-id",
      optional: true,
      resource: false,
      comment: "Maybe",
      additionalGuests: 2,
    });
    expect(result.googleDetails).toMatchObject({
      workingLocationProperties: { type: "homeOffice" },
    });
  });

  test("rejects unpreserved following metadata before trimming the master", async () => {
    let patched = false;
    const events = new Map<string, unknown>([
      [
        "instance",
        googleEvent("instance", {
          recurringEventId: "master",
          originalStartTime: { dateTime: "2026-07-25T09:00:00Z" },
        }),
      ],
      [
        "master",
        googleEvent("master", {
          start: { dateTime: "2026-07-24T09:00:00Z" },
          end: { dateTime: "2026-07-24T10:00:00Z" },
          recurrence: ["RRULE:FREQ=DAILY;COUNT=10"],
          attendees: [{ email: "guest@example.com" }],
        }),
      ],
    ]);
    const client = {
      getEvent: async (_calendarId: string, eventId: string) => events.get(eventId),
      patchEvent: async () => {
        patched = true;
        return googleEvent("master");
      },
    } as unknown as GwsCalendarClient;
    const service = calendarAdapter(database, client);

    expect(
      service.updateEvent({
        userId: "user-1",
        eventId: "google:trusted-writer:instance",
        scope: "following",
        patch: { summary: "Changed" },
      }),
    ).rejects.toThrow("attendees");
    expect(patched).toBe(false);
  });
});
