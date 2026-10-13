import type { TOption } from "@bellaclaw/shared";
import { createLogger } from "@bellaclaw/shared";
import { calculateAvailability } from "./availability";
import { CalendarStore } from "./store";
import type {
  ECalendarProvider,
  TAvailabilityArguments,
  TAvailabilityResult,
  TCalendar,
  TCalendarAccess,
  TCalendarEvent,
  TCalendarProvider,
  TCreateEventArguments,
  TDeleteEventArguments,
  TListEventsArguments,
  TListEventsResult,
  TUpdateEventArguments,
} from "./types";

function eventReference(event: TCalendarEvent): TCalendarEvent {
  const prefix = `${event.provider}:${encodeURIComponent(event.calendarId)}:`;
  let recurringEventId: TOption<string>;
  if (event.recurringEventId !== undefined) {
    recurringEventId = `${prefix}${encodeURIComponent(event.recurringEventId)}`;
  }
  return { ...event, id: `${prefix}${encodeURIComponent(event.id)}`, recurringEventId };
}

export class CalendarAdapter {
  private static _instance: TOption<CalendarAdapter>;
  private logger = createLogger("CALENDAR");
  private providers = new Map<ECalendarProvider, TCalendarProvider>();
  private errors = new Map<ECalendarProvider, string>();

  public constructor(private store: CalendarStore = new CalendarStore()) {}

  public static get instance(): CalendarAdapter {
    if (!CalendarAdapter._instance) {
      CalendarAdapter._instance = new CalendarAdapter();
    }
    return CalendarAdapter._instance;
  }

  public registerProvider(provider: TCalendarProvider): void {
    this.providers.set(provider.provider, provider);
  }

  public async setup(): Promise<void> {
    await Promise.all(
      [...this.providers.values()].map(async (provider) => {
        try {
          await provider.setup();
          this.errors.delete(provider.provider);
          this.logger.info(`${provider.provider} calendar is ready`);
        } catch (error) {
          this.errors.set(provider.provider, String(error));
          this.logger.warning(`${provider.provider} calendar is unavailable: ${String(error)}`);
        }
      }),
    );
  }

  private requireProvider(provider: ECalendarProvider): TCalendarProvider {
    const implementation = this.providers.get(provider);
    if (implementation === undefined) {
      throw new Error(`Calendar provider ${provider} is not registered`);
    }
    const error = this.errors.get(provider);
    if (error !== undefined) {
      throw new Error(error);
    }
    return implementation;
  }

  public async discoverCalendars(provider: ECalendarProvider, signal?: AbortSignal) {
    const calendars = await this.requireProvider(provider).discoverCalendars(signal);
    return calendars.map((calendar) => ({ ...calendar, provider }));
  }

  public async setWriteCalendar(
    userId: string,
    provider: ECalendarProvider,
    calendarId: string,
  ): Promise<TCalendar> {
    const live = await this.requireProvider(provider).probeCalendar(calendarId);
    if (!live.writable) {
      throw new Error("Writable calendar requires write access to events");
    }
    const addedAt = Date.now();
    await this.store.setWritable(userId, provider, calendarId, addedAt);
    return {
      provider,
      calendarId,
      access: "write",
      addedAt,
      summary: live.summary,
      error: undefined,
    };
  }

  public async addReadonlyCalendar(
    userId: string,
    provider: ECalendarProvider,
    calendarId: string,
  ): Promise<TCalendar> {
    const live = await this.requireProvider(provider).probeCalendar(calendarId);
    if (!live.readable) {
      throw new Error("Read-only calendar requires access to event details");
    }
    const addedAt = Date.now();
    await this.store.addReadonly(userId, provider, calendarId, addedAt);
    return {
      provider,
      calendarId,
      access: "read",
      addedAt,
      summary: live.summary,
      error: undefined,
    };
  }

  public async listCalendars(userId: string, signal?: AbortSignal): Promise<TCalendar[]> {
    const rows = await this.store.list(userId);
    return Promise.all(
      rows.map(async (row) => {
        let access: TCalendarAccess = "read";
        if (row.access === "write") {
          access = "write";
        }
        try {
          const live = await this.requireProvider(row.provider).probeCalendar(
            row.calendarId,
            signal,
          );
          return {
            provider: row.provider,
            calendarId: row.calendarId,
            access,
            addedAt: row.addedAt,
            summary: live.summary,
            error: undefined,
          };
        } catch (error) {
          signal?.throwIfAborted();
          return {
            provider: row.provider,
            calendarId: row.calendarId,
            access,
            addedAt: row.addedAt,
            summary: undefined,
            error: String(error),
          };
        }
      }),
    );
  }

  public async removeReadonlyCalendar(
    userId: string,
    provider: ECalendarProvider,
    calendarId: string,
  ): Promise<void> {
    await this.store.removeReadonly(userId, provider, calendarId);
  }

  public async listEvents(args: TListEventsArguments): Promise<TListEventsResult> {
    const start = Date.parse(args.timeMin);
    const end = Date.parse(args.timeMax);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      throw new Error("timeMax must be after a valid timeMin");
    }
    const rows = await this.store.list(args.userId);
    const events: TCalendarEvent[] = [];
    const failures: TListEventsResult["failures"] = [];
    await Promise.all(
      rows.map(async (row) => {
        try {
          const found = await this.requireProvider(row.provider).listEvents(row.calendarId, args);
          events.push(...found.map(eventReference));
        } catch (error) {
          args.signal?.throwIfAborted();
          failures.push({
            provider: row.provider,
            calendarId: row.calendarId,
            error: String(error),
          });
        }
      }),
    );
    events.sort((left, right) => {
      const difference =
        Date.parse(left.start.dateTime ?? left.start.date ?? "") -
        Date.parse(right.start.dateTime ?? right.start.date ?? "");
      if (Number.isFinite(difference) && difference !== 0) {
        return difference;
      }
      return left.id.localeCompare(right.id);
    });
    return { events, failures };
  }

  public async findAvailability(args: TAvailabilityArguments): Promise<TAvailabilityResult> {
    const result = await this.listEvents(args);
    return calculateAvailability(
      result.events,
      result.failures,
      args.timeMin,
      args.timeMax,
      args.timezone,
      args.durationMinutes,
    );
  }

  private async mutationTarget(userId: string, reference: string) {
    const calendar = await this.store.writeCalendar(userId);
    const [provider, calendarId, eventId, extra] = reference.split(":");
    if (
      provider !== calendar.provider ||
      calendarId === undefined ||
      eventId === undefined ||
      extra !== undefined ||
      decodeURIComponent(calendarId) !== calendar.calendarId
    ) {
      throw new Error(
        "Event must belong to this chat's writable calendar; resolve its ID with list-calendar-events",
      );
    }
    return { calendar, eventId: decodeURIComponent(eventId) };
  }

  public async createEvent(args: TCreateEventArguments): Promise<TCalendarEvent> {
    const calendar = await this.store.writeCalendar(args.userId);
    return eventReference(
      await this.requireProvider(calendar.provider).createEvent(calendar.calendarId, args),
    );
  }

  public async updateEvent(args: TUpdateEventArguments): Promise<TCalendarEvent> {
    const target = await this.mutationTarget(args.userId, args.eventId);
    return eventReference(
      await this.requireProvider(target.calendar.provider).updateEvent(target.calendar.calendarId, {
        ...args,
        eventId: target.eventId,
      }),
    );
  }

  public async deleteEvent(args: TDeleteEventArguments): Promise<void> {
    const target = await this.mutationTarget(args.userId, args.eventId);
    await this.requireProvider(target.calendar.provider).deleteEvent(target.calendar.calendarId, {
      ...args,
      eventId: target.eventId,
    });
  }
}

export * from "./types";
