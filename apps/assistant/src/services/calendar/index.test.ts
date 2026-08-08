import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { repositoryPath } from "@bellaclaw/shared";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { CalendarService } from ".";
import type { GwsCalendarClient } from "./gws";

function googleEvent(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    eventType: "default",
    start: { dateTime: "2026-07-25T09:00:00Z" },
    end: { dateTime: "2026-07-25T10:00:00Z" },
    ...extra,
  };
}

function selectingDatabase(rows: Record<string, unknown>[]): LibSQLDatabase {
  return {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  } as unknown as LibSQLDatabase;
}

function writeCalendarDatabase(): LibSQLDatabase {
  return selectingDatabase([
    { userId: "user-1", calendarId: "trusted-writer", access: "write", addedAt: 1 },
  ]);
}

describe("CalendarService mutation boundary", () => {
  const database = writeCalendarDatabase();

  test("setup becomes ready from the credentials file alone", async () => {
    const credentialsPath = repositoryPath(".secrets/google-calendar-service-account.json");
    const credentials = Bun.file(credentialsPath);
    const existed = await credentials.exists();
    if (!existed) {
      await mkdir(repositoryPath(".secrets"), { recursive: true });
      await Bun.write(credentialsPath, "{}");
    }
    const service = new CalendarService(database, {} as unknown as GwsCalendarClient);

    try {
      await service.setup();
      expect(service.getStatus()).toEqual({ ready: true, error: undefined });
    } finally {
      if (!existed) {
        await credentials.delete();
      }
    }
  });

  test("setting the write calendar accepts only the exact writer role", async () => {
    const client = {
      probeCalendar: async () => ({ accessRole: "reader", summary: "Wrong role" }),
    } as unknown as GwsCalendarClient;
    const service = new CalendarService(database, client);
    Object.assign(service, { status: { ready: true, error: undefined } });

    await expect(service.setWriteCalendar("user-1", "other-calendar")).rejects.toThrow(
      "requires exact writer access",
    );
  });

  test("write calendars are resolved per user", async () => {
    const calls: Array<{ calendarId: string }> = [];
    const client = {
      insertEvent: async (calendarId: string) => {
        calls.push({ calendarId });
        return googleEvent("created");
      },
    } as unknown as GwsCalendarClient;
    const service = new CalendarService(selectingDatabase([]), client);
    Object.assign(service, { status: { ready: true, error: undefined } });

    await expect(
      service.createEvent({
        userId: "user-without-calendar",
        summary: "Blocked",
        description: undefined,
        location: undefined,
        start: "2026-07-25T09:00:00Z",
        end: undefined,
        durationMinutes: undefined,
        timezone: "UTC",
        transparency: undefined,
        recurrence: undefined,
        signal: undefined,
      }),
    ).rejects.toThrow("No writable calendar is configured");
    expect(calls).toHaveLength(0);
  });

  test("read-only add rejects roles below reader", async () => {
    const client = {
      probeCalendar: async () => ({ accessRole: "freeBusyReader", summary: "Wrong role" }),
    } as unknown as GwsCalendarClient;
    const service = new CalendarService(selectingDatabase([]), client);
    Object.assign(service, { status: { ready: true, error: undefined } });

    await expect(service.addReadonlyCalendar("user-1", "other-calendar")).rejects.toThrow(
      "requires reader, writer, or owner access",
    );
  });

  test("read-only add stores another user's writable calendar as read", async () => {
    const inserted: Record<string, unknown>[] = [];
    const client = {
      probeCalendar: async () => ({ accessRole: "writer", summary: "Housemate" }),
    } as unknown as GwsCalendarClient;
    const database = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoUpdate: () => ({
            returning: async () => {
              inserted.push(values);
              return [values];
            },
          }),
        }),
      }),
    } as unknown as LibSQLDatabase;
    const service = new CalendarService(database, client);
    Object.assign(service, { status: { ready: true, error: undefined } });

    const calendar = await service.addReadonlyCalendar("user-1", "housemate-calendar");

    expect(calendar.access).toBe("read");
    expect(inserted[0]?.access).toBe("read");
    expect(inserted[0]?.userId).toBe("user-1");
  });

  test("create always targets the trusted writable calendar and uses default reminders", async () => {
    const calls: Array<{ calendarId: string; body: Record<string, unknown> }> = [];
    const client = {
      insertEvent: async (calendarId: string, body: Record<string, unknown>) => {
        calls.push({ calendarId, body });
        return googleEvent("created");
      },
    } as unknown as GwsCalendarClient;
    const service = new CalendarService(database, client);
    Object.assign(service, { status: { ready: true, error: undefined } });

    await service.createEvent({
      userId: "user-1",
      summary: "Safe",
      description: undefined,
      location: undefined,
      start: "2026-07-25T09:00:00Z",
      end: undefined,
      durationMinutes: undefined,
      timezone: "UTC",
      transparency: undefined,
      recurrence: undefined,
      signal: undefined,
    });

    expect(calls[0]?.calendarId).toBe("trusted-writer");
    expect(calls[0]?.body.reminders).toEqual({ useDefault: true });
  });

  test("preserves a timed event duration when moving only its start", async () => {
    let patchedBody: Record<string, unknown> | undefined;
    const client = {
      getEvent: async () =>
        googleEvent("timed", {
          start: { dateTime: "2026-07-25T09:00:00Z", timeZone: "Europe/Warsaw" },
          end: { dateTime: "2026-07-25T11:00:00Z", timeZone: "Europe/Warsaw" },
        }),
      patchEvent: async (_calendarId: string, _eventId: string, body: Record<string, unknown>) => {
        patchedBody = body;
        return googleEvent("timed", body);
      },
    } as unknown as GwsCalendarClient;
    const service = new CalendarService(database, client);
    Object.assign(service, { status: { ready: true, error: undefined } });

    await service.updateEvent({
      userId: "user-1",
      eventId: "timed",
      scope: "occurrence",
      patch: { start: "2026-07-26T12:00:00Z" },
    });

    expect(patchedBody?.start).toEqual({
      dateTime: "2026-07-26T12:00:00Z",
      timeZone: "Europe/Warsaw",
    });
    expect(patchedBody?.end).toEqual({
      dateTime: "2026-07-26T14:00:00.000Z",
      timeZone: "Europe/Warsaw",
    });
  });

  test("preserves a multi-day all-day duration when moving only its start", async () => {
    let patchedBody: Record<string, unknown> | undefined;
    const client = {
      getEvent: async () =>
        googleEvent("all-day", {
          start: { date: "2026-07-25" },
          end: { date: "2026-07-28" },
        }),
      patchEvent: async (_calendarId: string, _eventId: string, body: Record<string, unknown>) => {
        patchedBody = body;
        return googleEvent("all-day", body);
      },
    } as unknown as GwsCalendarClient;
    const service = new CalendarService(database, client);
    Object.assign(service, { status: { ready: true, error: undefined } });

    await service.updateEvent({
      userId: "user-1",
      eventId: "all-day",
      scope: "occurrence",
      patch: { start: "2026-08-10" },
    });

    expect(patchedBody?.start).toEqual({ date: "2026-08-10" });
    expect(patchedBody?.end).toEqual({ date: "2026-08-13" });
  });

  test("sorts timed events by their actual instants across UTC offsets", async () => {
    const listDatabase = writeCalendarDatabase();
    const client = {
      listEvents: async () => ({
        items: [
          googleEvent("later", { start: { dateTime: "2026-07-25T08:00:00Z" } }),
          googleEvent("earlier", { start: { dateTime: "2026-07-25T09:00:00+02:00" } }),
        ],
      }),
    } as unknown as GwsCalendarClient;
    const service = new CalendarService(listDatabase, client);
    Object.assign(service, { status: { ready: true, error: undefined } });

    const result = await service.listEvents({
      userId: "user-1",
      timeMin: "2026-07-25T00:00:00Z",
      timeMax: "2026-07-26T00:00:00Z",
    });

    expect(result.events.map((event) => event.id)).toEqual(["earlier", "later"]);
  });

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
    const service = new CalendarService(database, client);
    Object.assign(service, { status: { ready: true, error: undefined } });
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
      eventId: "instance",
      scope: "occurrence",
      patch,
      signal: undefined,
    });
    await service.updateEvent({
      userId: "user-1",
      eventId: "instance",
      scope: "series",
      patch,
      signal: undefined,
    });
    await service.updateEvent({
      userId: "user-1",
      eventId: "instance",
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
    const service = new CalendarService(database, client);
    Object.assign(service, { status: { ready: true, error: undefined } });

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
    const service = new CalendarService(database, client);
    Object.assign(service, { status: { ready: true, error: undefined } });

    expect(
      service.updateEvent({
        userId: "user-1",
        eventId: "instance",
        scope: "following",
        patch: { summary: "Changed" },
      }),
    ).rejects.toThrow("attendees");
    expect(patched).toBe(false);
  });

  test("rejects non-recreatable following metadata before trimming the master", async () => {
    for (const metadata of [
      { eventLabelId: "label", eventLabelVersion: "1" },
      { endTimeUnspecified: true },
      { attendeesOmitted: true },
      { gadget: { type: "legacy" } },
    ]) {
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
            ...metadata,
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
      const service = new CalendarService(database, client);
      Object.assign(service, { status: { ready: true, error: undefined } });

      await expect(
        service.updateEvent({
          userId: "user-1",
          eventId: "instance",
          scope: "following",
          patch: { summary: "Changed" },
        }),
      ).rejects.toThrow("cannot safely split");
      expect(patched).toBe(false);
    }
  });

  test("rejects an unanchored following boundary before trimming the master", async () => {
    let patched = false;
    const events = new Map<string, unknown>([
      [
        "instance",
        googleEvent("instance", {
          recurringEventId: "master",
          originalStartTime: { dateTime: "2026-07-29T09:00:00Z" },
        }),
      ],
      [
        "master",
        googleEvent("master", {
          start: { dateTime: "2026-07-24T09:00:00Z" },
          end: { dateTime: "2026-07-24T10:00:00Z" },
          recurrence: [
            "RRULE:FREQ=DAILY;COUNT=10",
            "RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=8",
            "RDATE:20260729T090000Z",
          ],
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
    const service = new CalendarService(database, client);
    Object.assign(service, { status: { ready: true, error: undefined } });

    await expect(
      service.updateEvent({
        userId: "user-1",
        eventId: "instance",
        scope: "following",
        patch: { summary: "Changed" },
      }),
    ).rejects.toThrow("not generated by every RRULE");
    expect(patched).toBe(false);
  });

  test("rejects special event mutation before patching", async () => {
    let patched = false;
    const client = {
      getEvent: async () => googleEvent("birthday", { eventType: "birthday" }),
      patchEvent: async () => {
        patched = true;
        return googleEvent("birthday");
      },
    } as unknown as GwsCalendarClient;
    const service = new CalendarService(database, client);
    Object.assign(service, { status: { ready: true, error: undefined } });

    expect(
      service.updateEvent({
        userId: "user-1",
        eventId: "birthday",
        scope: "occurrence",
        patch: {
          summary: "No",
          description: undefined,
          location: undefined,
          start: undefined,
          end: undefined,
          durationMinutes: undefined,
          timezone: undefined,
          transparency: undefined,
          recurrence: undefined,
        },
        signal: undefined,
      }),
    ).rejects.toThrow("unsupported type");
    expect(patched).toBe(false);
  });
});
