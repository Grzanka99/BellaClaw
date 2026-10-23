import { AsyncQueue } from "@bellaclaw/shared";
import { and, eq, ne } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { DatabaseConnector } from "../database";
import { calendarsTable } from "../database/schema";
import type { ECalendarProvider } from "./types";

export class CalendarStore {
  private queue = new AsyncQueue();

  public constructor(private db: LibSQLDatabase = DatabaseConnector.instance.database) {}

  public list(userId: string) {
    return this.queue.enqueue(() =>
      this.db.select().from(calendarsTable).where(eq(calendarsTable.userId, userId)),
    );
  }

  public async writeCalendar(userId: string) {
    const rows = await this.queue.enqueue(() =>
      this.db
        .select()
        .from(calendarsTable)
        .where(and(eq(calendarsTable.userId, userId), eq(calendarsTable.access, "write"))),
    );
    const calendar = rows[0];
    if (calendar === undefined) {
      throw new Error(
        "No writable calendar is configured for this chat. Use !calendar_add-write PROVIDER CALENDAR_ID",
      );
    }
    return calendar;
  }

  public setWritable(
    userId: string,
    provider: ECalendarProvider,
    calendarId: string,
    addedAt: number,
  ): Promise<void> {
    return this.queue.enqueue(() =>
      this.db.transaction(async (transaction) => {
        await transaction
          .delete(calendarsTable)
          .where(and(eq(calendarsTable.userId, userId), eq(calendarsTable.access, "write")));
        await transaction
          .insert(calendarsTable)
          .values({ userId, provider, calendarId, access: "write", addedAt })
          .onConflictDoUpdate({
            target: [calendarsTable.userId, calendarsTable.provider, calendarsTable.calendarId],
            set: { access: "write", addedAt },
          });
      }),
    );
  }

  public async addReadonly(
    userId: string,
    provider: ECalendarProvider,
    calendarId: string,
    addedAt: number,
  ): Promise<void> {
    const inserted = await this.queue.enqueue(() =>
      this.db
        .insert(calendarsTable)
        .values({ userId, provider, calendarId, access: "read", addedAt })
        .onConflictDoUpdate({
          target: [calendarsTable.userId, calendarsTable.provider, calendarsTable.calendarId],
          set: { access: "read", addedAt },
          setWhere: ne(calendarsTable.access, "write"),
        })
        .returning(),
    );
    if (inserted.length === 0) {
      throw new Error("Writable calendar cannot be added as read-only");
    }
  }

  public async removeReadonly(
    userId: string,
    provider: ECalendarProvider,
    calendarId: string,
  ): Promise<void> {
    const removed = await this.queue.enqueue(() =>
      this.db
        .delete(calendarsTable)
        .where(
          and(
            eq(calendarsTable.userId, userId),
            eq(calendarsTable.provider, provider),
            eq(calendarsTable.calendarId, calendarId),
            eq(calendarsTable.access, "read"),
          ),
        )
        .returning(),
    );
    if (removed.length === 0) {
      throw new Error(`Read-only calendar ${calendarId} is not configured`);
    }
  }
}
