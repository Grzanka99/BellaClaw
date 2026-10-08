import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { CalendarAdapter, ECalendarProvider } from ".";
import { GoogleCalendarProvider } from "./google";
import type { GwsCalendarClient } from "./gws";
import { CalendarStore } from "./store";

export function googleEvent(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    eventType: "default",
    start: { dateTime: "2026-07-25T09:00:00Z" },
    end: { dateTime: "2026-07-25T10:00:00Z" },
    ...extra,
  };
}

export function selectingDatabase(rows: Record<string, unknown>[]): LibSQLDatabase {
  return {
    select: () => ({
      from: () => ({
        where: async () => rows.map((row) => ({ provider: ECalendarProvider.Google, ...row })),
      }),
    }),
  } as unknown as LibSQLDatabase;
}

export function writeCalendarDatabase(): LibSQLDatabase {
  return selectingDatabase([
    { userId: "user-1", calendarId: "trusted-writer", access: "write", addedAt: 1 },
  ]);
}

export function calendarAdapter(
  database: LibSQLDatabase,
  client: GwsCalendarClient,
): CalendarAdapter {
  const adapter = new CalendarAdapter(new CalendarStore(database));
  adapter.registerProvider(new GoogleCalendarProvider(client));
  return adapter;
}
