import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { repositoryPath } from "@bellaclaw/shared";
import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { validateUpdateCalendarEventArgs } from "../ai/tools/update-calendar-event";
import { DatabaseConnector } from "../database";
import { calendarsTable } from "../database/schema";
import { resetEventTables } from "../database/test-utils";
import { CommandRejectedError, EventBus } from "../events";
import { EEventType } from "../events/catalog";
import { withEventContext } from "../events/test-utils";
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

function connector(db: LibSQLDatabase): DatabaseConnector {
  return {
    run: <T>(callback: (handle: LibSQLDatabase) => Promise<T>) => callback(db),
  } as unknown as DatabaseConnector;
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
    const service = new CalendarService(connector(database), {} as unknown as GwsCalendarClient);

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
    const service = new CalendarService(connector(database), client);
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
    const service = new CalendarService(connector(selectingDatabase([])), client);
    Object.assign(service, { status: { ready: true, error: undefined } });

    await expect(
      service.createEvent({
        userId: "user-without-calendar",
        commandId: "command-1",
        summary: "Blocked",
        description: undefined,
        location: undefined,
        start: "2026-07-25T09:00:00Z",
        end: undefined,
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
    const service = new CalendarService(connector(selectingDatabase([])), client);
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
    const service = new CalendarService(connector(database), client);
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
    const service = new CalendarService(connector(database), client);
    Object.assign(service, { status: { ready: true, error: undefined } });

    await service.createEvent({
      userId: "user-1",
      commandId: "command-1",
      summary: "Safe",
      description: undefined,
      location: undefined,
      start: "2026-07-25T09:00:00Z",
      end: undefined,
      timezone: "UTC",
      transparency: undefined,
      recurrence: undefined,
      signal: undefined,
    });

    expect(calls[0]?.calendarId).toBe("trusted-writer");
    expect(calls[0]?.body.reminders).toEqual({ useDefault: true });
    expect(calls[0]?.body.end).toEqual({ dateTime: "2026-07-25T10:00:00.000Z", timeZone: "UTC" });
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
    const service = new CalendarService(connector(database), client);
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
    const service = new CalendarService(connector(database), client);
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
    const service = new CalendarService(connector(listDatabase), client);
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
    const service = new CalendarService(connector(database), client);
    Object.assign(service, { status: { ready: true, error: undefined } });
    const patch = {
      summary: "Changed",
      description: undefined,
      location: undefined,
      start: undefined,
      end: undefined,
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
      const service = new CalendarService(connector(database), client);
      Object.assign(service, { status: { ready: true, error: undefined } });
      const patch = validateUpdateCalendarEventArgs({
        eventId: "instance",
        scope: "following",
        start: conversion.start,
      });

      await expect(
        service.updateEvent({ userId: "user-1", eventId: "instance", scope: "following", patch }),
      ).rejects.toThrow("requires an explicit end");
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
    const service = new CalendarService(connector(database), client);
    Object.assign(service, { status: { ready: true, error: undefined } });

    const result = await service.createEvent({
      userId: "user-1",
      commandId: "command-1",
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
    const service = new CalendarService(connector(database), client);
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
      const service = new CalendarService(connector(database), client);
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
    const service = new CalendarService(connector(database), client);
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
    const service = new CalendarService(connector(database), client);
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

describe("CalendarService create idempotency", () => {
  const database = writeCalendarDatabase();
  const args = {
    userId: "user-1",
    commandId: "0190f0a0-0000-7000-8000-000000000001",
    summary: "Once",
    start: "2026-07-25T09:00:00Z",
    timezone: "UTC",
  };

  test("derives a valid Google event id from the command id", async () => {
    const ids: unknown[] = [];
    const client = {
      insertEvent: async (_calendarId: string, body: Record<string, unknown>) => {
        ids.push(body.id);
        return googleEvent(String(body.id));
      },
    } as unknown as GwsCalendarClient;
    const service = new CalendarService(connector(database), client);
    Object.assign(service, { status: { ready: true, error: undefined } });

    await service.createEvent(args);
    await service.createEvent(args);
    await service.createEvent({ ...args, commandId: "another-command" });

    expect(String(ids[0])).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  test("a repeated create returns the event the first create made", async () => {
    let insertedId = "";
    const client = {
      insertEvent: async (_calendarId: string, body: Record<string, unknown>) => {
        insertedId = String(body.id);
        throw new Error(
          "gws exited with code 1: error[api]: The requested identifier already exists.",
        );
      },
      getEvent: async (_calendarId: string, eventId: string) =>
        googleEvent(eventId, { summary: "Once" }),
    } as unknown as GwsCalendarClient;
    const service = new CalendarService(connector(database), client);
    Object.assign(service, { status: { ready: true, error: undefined } });

    const result = await service.createEvent(args);

    expect(result.id).toBe(insertedId);
    expect(result.summary).toBe("Once");
  });

  test("a failed create whose event does not exist keeps the insert error", async () => {
    const client = {
      insertEvent: async () => {
        throw new Error("gws exited with code 1: error[api]: Invalid recurrence rule.");
      },
      getEvent: async () => {
        throw new Error("gws exited with code 1: error[api]: Not Found");
      },
    } as unknown as GwsCalendarClient;
    const service = new CalendarService(connector(database), client);
    Object.assign(service, { status: { ready: true, error: undefined } });

    await expect(service.createEvent(args)).rejects.toThrow("Invalid recurrence rule.");
  });
});

describe("calendar commands", () => {
  const inserted: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  let rows: Record<string, unknown>[] = [];

  beforeEach(async () => {
    inserted.length = 0;
    deleted.length = 0;
    rows = [{ userId: "chat-1", calendarId: "trusted-writer", access: "write", addedAt: 1 }];
    await resetEventTables();
    Object.assign(EventBus, { _instance: undefined });
    const database = {
      select: () => ({ from: () => ({ where: async () => rows }) }),
    } as unknown as LibSQLDatabase;
    const client = {
      insertEvent: async (_calendarId: string, body: Record<string, unknown>) => {
        inserted.push(body);
        return googleEvent(String(body.id), { summary: body.summary });
      },
      getEvent: async (_calendarId: string, eventId: string) => googleEvent(eventId),
      patchEvent: async (_calendarId: string, eventId: string, body: Record<string, unknown>) =>
        googleEvent(eventId, body),
      deleteEvent: async (_calendarId: string, eventId: string) => {
        deleted.push(eventId);
        return {};
      },
    } as unknown as GwsCalendarClient;
    const service = new CalendarService(connector(database), client);
    await service.setup();
    Object.assign(service, { status: { ready: true, error: undefined } });
    await EventBus.instance.start();
  });

  afterEach(async () => {
    await EventBus.instance.stop();
  });

  function requestRemove(calendarId: string) {
    return withEventContext((ctx) =>
      ctx.request(
        EEventType.CalendarSourceRemoveRequested,
        { chatId: "chat-1", calendarId },
        {
          outcome: EEventType.CalendarSourceRemoved,
          step: undefined,
          key: "chat-1",
          timeoutMs: undefined,
        },
      ),
    );
  }

  test("create calls Google, then answers with the created event", async () => {
    const created = await withEventContext((ctx) =>
      ctx.request(
        EEventType.CalendarEventCreateRequested,
        { chatId: "chat-1", summary: "Lunch", start: "2026-07-25T09:00:00Z", timezone: "UTC" },
        {
          outcome: EEventType.CalendarEventCreated,
          step: undefined,
          key: "chat-1",
          timeoutMs: undefined,
        },
      ),
    );

    expect(inserted).toHaveLength(1);
    expect(created.payload.chatId).toBe("chat-1");
    expect(created.payload.event).toMatchObject({
      calendarId: "trusted-writer",
      id: inserted[0]?.id,
      summary: "Lunch",
    });
    expect(String(inserted[0]?.id)).toMatch(/^[0-9a-v]{5,1024}$/);
  });

  test("create without a writable calendar is rejected with the service message", async () => {
    rows = [];

    const rejected = await withEventContext((ctx) =>
      ctx.request(
        EEventType.CalendarEventCreateRequested,
        { chatId: "chat-1", summary: "Lunch", start: "2026-07-25T09:00:00Z", timezone: "UTC" },
        {
          outcome: EEventType.CalendarEventCreated,
          step: undefined,
          key: "chat-1",
          timeoutMs: undefined,
        },
      ),
    ).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(CommandRejectedError);
    expect(rejected).toMatchObject({ message: expect.stringContaining("No writable calendar") });
    expect(inserted).toHaveLength(0);
  });

  test("update answers with the patched event", async () => {
    const updated = await withEventContext((ctx) =>
      ctx.request(
        EEventType.CalendarEventUpdateRequested,
        { chatId: "chat-1", eventId: "event-1", scope: "occurrence", patch: { summary: "Dinner" } },
        {
          outcome: EEventType.CalendarEventUpdated,
          step: undefined,
          key: "chat-1",
          timeoutMs: undefined,
        },
      ),
    );

    expect(updated.payload.event).toMatchObject({ id: "event-1", summary: "Dinner" });
  });

  test("delete removes the event and answers with its target", async () => {
    const result = await withEventContext((ctx) =>
      ctx.request(
        EEventType.CalendarEventDeleteRequested,
        { chatId: "chat-1", eventId: "event-1", scope: "series" },
        {
          outcome: EEventType.CalendarEventDeleted,
          step: undefined,
          key: "chat-1",
          timeoutMs: undefined,
        },
      ),
    );

    expect(deleted).toEqual(["event-1"]);
    expect(result.payload).toEqual({ chatId: "chat-1", eventId: "event-1", scope: "series" });
  });

  test("removing a read-only source answers removed, and a missing one is rejected", async () => {
    const db = DatabaseConnector.instance.database;
    await db.delete(calendarsTable);
    await db
      .insert(calendarsTable)
      .values({ userId: "chat-1", calendarId: "shared", access: "read", addedAt: 1 });

    const removed = await requestRemove("shared");
    const rejected = await requestRemove("missing").catch((error: unknown) => error);

    expect(removed.payload).toEqual({ chatId: "chat-1", calendarId: "shared" });
    expect(await db.select().from(calendarsTable)).toEqual([]);
    expect(rejected).toBeInstanceOf(CommandRejectedError);
    expect(rejected).toMatchObject({ message: "Read-only calendar missing is not configured" });
  });

  test("a failed source removal rolls back the delete with its outcome and ack", async () => {
    const db = DatabaseConnector.instance.database;
    await db.delete(calendarsTable);
    await db
      .insert(calendarsTable)
      .values({ userId: "chat-1", calendarId: "shared", access: "read", addedAt: 1 });
    await db.run(
      sql`CREATE TRIGGER refuse_removed BEFORE INSERT ON events WHEN NEW.type = 'calendar.source.removed' BEGIN SELECT RAISE(ABORT, 'outcome refused'); END`,
    );

    try {
      await expect(requestRemove("shared")).rejects.toBeInstanceOf(CommandRejectedError);
    } finally {
      await db.run(sql`DROP TRIGGER refuse_removed`);
    }

    expect(await db.select().from(calendarsTable)).toHaveLength(1);
  });
});
