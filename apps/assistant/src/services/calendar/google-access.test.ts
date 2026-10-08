import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { repositoryPath } from "@bellaclaw/shared";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { ECalendarProvider } from ".";
import { GoogleCalendarProvider } from "./google";
import {
  calendarAdapter,
  googleEvent,
  selectingDatabase,
  writeCalendarDatabase,
} from "./google-fixtures.test";
import type { GwsCalendarClient } from "./gws";

const database = writeCalendarDatabase();

describe("Google calendar regression", () => {
  test("setup becomes ready from the credentials file alone", async () => {
    const credentialsPath = repositoryPath(".secrets/google-calendar-service-account.json");
    const credentials = Bun.file(credentialsPath);
    const existed = await credentials.exists();
    if (!existed) {
      await mkdir(repositoryPath(".secrets"), { recursive: true });
      await Bun.write(credentialsPath, "{}");
    }
    const service = calendarAdapter(database, {} as unknown as GwsCalendarClient);

    try {
      await service.setup();
      await expect(new GoogleCalendarProvider().setup()).resolves.toBeUndefined();
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
    const service = calendarAdapter(database, client);

    await expect(
      service.setWriteCalendar("user-1", ECalendarProvider.Google, "other-calendar"),
    ).rejects.toThrow("requires write access");
  });

  test("write calendars are resolved per user", async () => {
    const calls: Array<{ calendarId: string }> = [];
    const client = {
      insertEvent: async (calendarId: string) => {
        calls.push({ calendarId });
        return googleEvent("created");
      },
    } as unknown as GwsCalendarClient;
    const service = calendarAdapter(selectingDatabase([]), client);

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
    const service = calendarAdapter(selectingDatabase([]), client);

    await expect(
      service.addReadonlyCalendar("user-1", ECalendarProvider.Google, "other-calendar"),
    ).rejects.toThrow("requires access to event details");
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
    const service = calendarAdapter(database, client);

    const calendar = await service.addReadonlyCalendar(
      "user-1",
      ECalendarProvider.Google,
      "housemate-calendar",
    );

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
    const service = calendarAdapter(database, client);

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
    const service = calendarAdapter(database, client);

    await service.updateEvent({
      userId: "user-1",
      eventId: "google:trusted-writer:timed",
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
    const service = calendarAdapter(database, client);

    await service.updateEvent({
      userId: "user-1",
      eventId: "google:trusted-writer:all-day",
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
    const service = calendarAdapter(listDatabase, client);

    const result = await service.listEvents({
      userId: "user-1",
      timeMin: "2026-07-25T00:00:00Z",
      timeMax: "2026-07-26T00:00:00Z",
    });

    expect(result.events.map((event) => event.id)).toEqual([
      "google:trusted-writer:earlier",
      "google:trusted-writer:later",
    ]);
  });
});
