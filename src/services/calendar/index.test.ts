import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
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

describe("CalendarService mutation boundary", () => {
  const database = {} as unknown as LibSQLDatabase;

  test("setup accepts exact writer access and reconciles the write row", async () => {
    const credentialsPath = `${process.cwd()}/.secrets/google-calendar-service-account.json`;
    const credentials = Bun.file(credentialsPath);
    const existed = await credentials.exists();
    if (!existed) {
      await mkdir(`${process.cwd()}/.secrets`, { recursive: true });
      await Bun.write(credentialsPath, "{}");
    }
    let reconciled = 0;
    const transaction = {
      delete: () => ({ where: async () => undefined }),
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: async () => {
            reconciled += 1;
          },
        }),
      }),
    };
    const setupDatabase = {
      transaction: async (callback: (value: typeof transaction) => Promise<void>) =>
        callback(transaction),
    } as unknown as LibSQLDatabase;
    const client = {
      probeCalendar: async () => ({ accessRole: "writer", summary: "Writer" }),
    } as unknown as GwsCalendarClient;
    const service = new CalendarService(setupDatabase, client, "trusted-writer");

    try {
      await service.setup();
      expect(service.getStatus()).toEqual({ ready: true, error: undefined });
      expect(reconciled).toBe(1);
    } finally {
      if (!existed) {
        await credentials.delete();
      }
    }
  });

  test("read-only add accepts only the exact reader role", async () => {
    const client = {
      probeCalendar: async () => ({ accessRole: "writer", summary: "Wrong role" }),
    } as unknown as GwsCalendarClient;
    const service = new CalendarService(database, client, "trusted-writer");
    Object.assign(service, { status: { ready: true, error: undefined } });

    expect(service.addReadonlyCalendar("other-calendar")).rejects.toThrow(
      "requires exact reader access",
    );
  });

  test("create always targets the trusted writable calendar and uses default reminders", async () => {
    const calls: Array<{ calendarId: string; body: Record<string, unknown> }> = [];
    const client = {
      insertEvent: async (calendarId: string, body: Record<string, unknown>) => {
        calls.push({ calendarId, body });
        return googleEvent("created");
      },
    } as unknown as GwsCalendarClient;
    const service = new CalendarService(database, client, "trusted-writer");
    Object.assign(service, { status: { ready: true, error: undefined } });

    await service.createEvent({
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
    const service = new CalendarService(database, client, "trusted-writer");
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
      eventId: "instance",
      scope: "occurrence",
      patch,
      signal: undefined,
    });
    await service.updateEvent({ eventId: "instance", scope: "series", patch, signal: undefined });
    await service.updateEvent({
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
    const service = new CalendarService(database, client, "trusted-writer");
    Object.assign(service, { status: { ready: true, error: undefined } });

    const result = await service.createEvent({
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
    const service = new CalendarService(database, client, "trusted-writer");
    Object.assign(service, { status: { ready: true, error: undefined } });

    expect(
      service.updateEvent({
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
      const service = new CalendarService(database, client, "trusted-writer");
      Object.assign(service, { status: { ready: true, error: undefined } });

      await expect(
        service.updateEvent({
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
    const service = new CalendarService(database, client, "trusted-writer");
    Object.assign(service, { status: { ready: true, error: undefined } });

    await expect(
      service.updateEvent({
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
    const service = new CalendarService(database, client, "trusted-writer");
    Object.assign(service, { status: { ready: true, error: undefined } });

    expect(
      service.updateEvent({
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
