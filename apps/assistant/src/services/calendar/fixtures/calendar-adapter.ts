import { mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { CalendarAdapter } from "..";
import { mapEvent } from "../google-events";
import { CalendarStore } from "../store";
import type {
  ECalendarProvider,
  TCreateEventArguments,
  TDeleteEventArguments,
  TUpdateEventArguments,
} from "../types";

export async function adapterFixture() {
  const directory = await mkdtemp(join(tmpdir(), "bellaclaw-calendar-"));
  const db = drizzle({ connection: { url: `file:${join(directory, "calendar.db")}` } });
  await db.run(sql`CREATE TABLE calendars (
    userId TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'google',
    calendarId TEXT NOT NULL, access TEXT NOT NULL CHECK(access IN ('read', 'write')),
    addedAt INTEGER NOT NULL, PRIMARY KEY(userId, provider, calendarId)
  )`);
  await db.run(sql`CREATE UNIQUE INDEX calendars_single_write_unique
    ON calendars(userId) WHERE access = 'write'`);
  const store = new CalendarStore(db);
  const adapter = new CalendarAdapter(store);
  return {
    db,
    store,
    adapter,
    close: async () => {
      db.$client.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function testProvider(provider: ECalendarProvider) {
  const event = (calendarId: string, id = "event:with#punctuation") => ({
    ...mapEvent(calendarId, {
      id,
      summary: "Planning",
      start: { dateTime: "2026-07-25T09:00:00Z" },
      end: { dateTime: "2026-07-25T10:00:00Z" },
    }),
    provider,
  });
  return {
    provider,
    setup: mock(async () => {}),
    discoverCalendars: mock(async () => []),
    probeCalendar: mock(async (calendarId: string) => ({
      calendarId,
      summary: "Shared",
      readable: true,
      writable: true,
    })),
    listEvents: mock(async (calendarId: string) => [event(calendarId)]),
    createEvent: mock(async (calendarId: string, _args: TCreateEventArguments) =>
      event(calendarId),
    ),
    updateEvent: mock(async (calendarId: string, args: TUpdateEventArguments) =>
      event(calendarId, args.eventId),
    ),
    deleteEvent: mock(async (_calendarId: string, _args: TDeleteEventArguments) => {}),
  };
}
