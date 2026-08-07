import type { TOption } from "@bellaclaw/shared";
import { AsyncQueue, createLogger, repositoryPath } from "@bellaclaw/shared";
import { and, eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { DatabaseConnector } from "../database";
import { calendarsTable } from "../database/schema";
import { calculateAvailability } from "./availability";
import { GwsCalendarClient } from "./gws";
import { countRuleOccurrencesBefore, splitRecurrence } from "./recurrence";
import type {
  TAvailabilityArguments,
  TAvailabilityResult,
  TCalendar,
  TCalendarAccess,
  TCalendarEvent,
  TCalendarPerson,
  TCreateEventArguments,
  TDeleteEventArguments,
  TEventDateTime,
  TListEventsArguments,
  TListEventsResult,
  TUpdateEventArguments,
  TUpdateEventPatch,
} from "./types";

const GOOGLE_CREDENTIALS_FILE = repositoryPath(".secrets/google-calendar-service-account.json");
const MISSING_WRITE_CALENDAR_MESSAGE =
  "No writable calendar is configured for this chat. Share a Google calendar with the bot's service account granting write access, then send: !write-calendar <calendarId>";

type TCalendarStatus = {
  ready: boolean;
  error: TOption<string>;
};

function readString(value: unknown, key: string): TOption<string> {
  if (typeof value === "object" && value !== null) {
    const candidate = Reflect.get(value, key);
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
}

function readBoolean(value: unknown, key: string): TOption<boolean> {
  if (typeof value === "object" && value !== null && typeof Reflect.get(value, key) === "boolean") {
    return Reflect.get(value, key);
  }
  return undefined;
}

function readNumber(value: unknown, key: string): TOption<number> {
  if (typeof value === "object" && value !== null && typeof Reflect.get(value, key) === "number") {
    return Reflect.get(value, key);
  }
  return undefined;
}

function readObject(value: unknown, key: string): TOption<unknown> {
  if (typeof value === "object" && value !== null) {
    return Reflect.get(value, key);
  }
  return undefined;
}

function readStringArray(value: unknown, key: string): string[] {
  const candidate = readObject(value, key);
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate.filter((item) => typeof item === "string");
}

function readArray(value: unknown, key: string): unknown[] {
  const candidate = readObject(value, key);
  if (Array.isArray(candidate)) {
    return candidate;
  }
  return [];
}

function mapDateTime(value: unknown): TEventDateTime {
  return {
    date: readString(value, "date"),
    dateTime: readString(value, "dateTime"),
    timeZone: readString(value, "timeZone"),
  };
}

function mapPerson(value: unknown): TCalendarPerson {
  return {
    id: readString(value, "id"),
    email: readString(value, "email"),
    displayName: readString(value, "displayName"),
    responseStatus: readString(value, "responseStatus"),
    self: readBoolean(value, "self"),
    optional: readBoolean(value, "optional"),
    resource: readBoolean(value, "resource"),
    comment: readString(value, "comment"),
    additionalGuests: readNumber(value, "additionalGuests"),
  };
}

function mapEvent(calendarId: string, value: unknown): TCalendarEvent {
  const id = readString(value, "id");
  if (id === undefined) {
    throw new Error(`Google returned an event without an id for calendar ${calendarId}`);
  }
  const attendeesValue = readObject(value, "attendees");
  const attendees: TCalendarPerson[] = [];
  if (Array.isArray(attendeesValue)) {
    for (const attendee of attendeesValue) {
      attendees.push(mapPerson(attendee));
    }
  }
  const organizerValue = readObject(value, "organizer");
  let organizer: TOption<TCalendarPerson>;
  if (organizerValue !== undefined) {
    organizer = mapPerson(organizerValue);
  }
  const creatorValue = readObject(value, "creator");
  let creator: TOption<TCalendarPerson>;
  if (creatorValue !== undefined) {
    creator = mapPerson(creatorValue);
  }
  let originalStartTime: TOption<TEventDateTime>;
  const originalStartValue = readObject(value, "originalStartTime");
  if (originalStartValue !== undefined) {
    originalStartTime = mapDateTime(originalStartValue);
  }
  return {
    calendarId,
    id,
    etag: readString(value, "etag"),
    status: readString(value, "status"),
    colorId: readString(value, "colorId"),
    eventLabelId: readString(value, "eventLabelId"),
    eventLabelVersion: readString(value, "eventLabelVersion"),
    sequence: readNumber(value, "sequence"),
    endTimeUnspecified: readBoolean(value, "endTimeUnspecified"),
    attendeesOmitted: readBoolean(value, "attendeesOmitted"),
    gadget: readObject(value, "gadget"),
    eventType: readString(value, "eventType"),
    summary: readString(value, "summary"),
    description: readString(value, "description"),
    location: readString(value, "location"),
    start: mapDateTime(readObject(value, "start")),
    end: mapDateTime(readObject(value, "end")),
    transparency: readString(value, "transparency"),
    recurrence: readStringArray(value, "recurrence"),
    recurringEventId: readString(value, "recurringEventId"),
    originalStartTime,
    organizer,
    creator,
    attendees,
    attachments: readArray(value, "attachments"),
    hangoutLink: readString(value, "hangoutLink"),
    conferenceData: readObject(value, "conferenceData"),
    htmlLink: readString(value, "htmlLink"),
    visibility: readString(value, "visibility"),
    created: readString(value, "created"),
    updated: readString(value, "updated"),
    iCalUID: readString(value, "iCalUID"),
    reminders: readObject(value, "reminders"),
    googleDetails: value,
    unsupportedManagedFields: [
      "extendedProperties",
      "source",
      "anyoneCanAddSelf",
      "guestsCanInviteOthers",
      "guestsCanModify",
      "guestsCanSeeOtherGuests",
      "privateCopy",
      "locked",
      "workingLocationProperties",
      "outOfOfficeProperties",
      "focusTimeProperties",
      "birthdayProperties",
    ].filter((key) => readObject(value, key) !== undefined),
  };
}

function assertMutableEvent(event: TCalendarEvent): void {
  if (event.status === "cancelled") {
    throw new Error(`Calendar event ${event.id} is cancelled`);
  }
  if (event.eventType !== undefined && event.eventType !== "default") {
    throw new Error(`Calendar event ${event.id} has unsupported type ${event.eventType}`);
  }
}

function nextDate(date: string): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid all-day date: ${date}`);
  }
  return new Date(timestamp + 86_400_000).toISOString().slice(0, 10);
}

function normalizeEventTimes(
  start: string,
  end: TOption<string>,
  durationMinutes: TOption<number>,
  timezone: string,
): { start: Record<string, unknown>; end: Record<string, unknown> } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    if (end !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      throw new Error("All-day event end must also be a date");
    }
    if (durationMinutes !== undefined) {
      throw new Error("All-day events do not accept durationMinutes");
    }
    return {
      start: { date: start },
      end: { date: end ?? nextDate(start) },
    };
  }

  const startTimestamp = Date.parse(start);
  if (Number.isNaN(startTimestamp)) {
    throw new Error(`Invalid event start: ${start}`);
  }
  let endValue = end;
  if (endValue === undefined) {
    const minutes = durationMinutes ?? 60;
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Error("durationMinutes must be positive");
    }
    endValue = new Date(startTimestamp + minutes * 60_000).toISOString();
  }
  const endTimestamp = Date.parse(endValue);
  if (Number.isNaN(endTimestamp) || endTimestamp <= startTimestamp) {
    throw new Error("Event end must be a valid time after start");
  }
  return {
    start: { dateTime: start, timeZone: timezone },
    end: { dateTime: endValue, timeZone: timezone },
  };
}

function eventBody(event: TCalendarEvent): Record<string, unknown> {
  const body: Record<string, unknown> = {
    start: event.start,
    end: event.end,
    recurrence: event.recurrence,
  };
  if (event.summary !== undefined) {
    body.summary = event.summary;
  }
  if (event.description !== undefined) {
    body.description = event.description;
  }
  if (event.location !== undefined) {
    body.location = event.location;
  }
  if (event.transparency !== undefined) {
    body.transparency = event.transparency;
  }
  if (event.visibility !== undefined) {
    body.visibility = event.visibility;
  }
  if (event.status !== undefined) {
    body.status = event.status;
  }
  if (event.colorId !== undefined) {
    body.colorId = event.colorId;
  }
  if (event.sequence !== undefined) {
    body.sequence = event.sequence;
  }
  body.reminders = event.reminders ?? { useDefault: true };
  return body;
}

function assertFollowingSplitSafe(event: TCalendarEvent): void {
  const excluded = [...event.unsupportedManagedFields];
  if (event.eventLabelId !== undefined || event.eventLabelVersion !== undefined) {
    excluded.push("eventLabel");
  }
  if (event.endTimeUnspecified !== undefined) {
    excluded.push("endTimeUnspecified");
  }
  if (event.attendeesOmitted !== undefined) {
    excluded.push("attendeesOmitted");
  }
  if (event.gadget !== undefined) {
    excluded.push("gadget");
  }
  if (event.attendees.length > 0) {
    excluded.push("attendees");
  }
  if (event.conferenceData !== undefined || event.hangoutLink !== undefined) {
    excluded.push("conferenceData");
  }
  if (event.attachments.length > 0) {
    excluded.push("attachments");
  }
  if (excluded.length > 0) {
    throw new Error(`Following scope cannot safely split managed fields: ${excluded.join(", ")}`);
  }
}

function isFirstOccurrence(master: TCalendarEvent, occurrence: TCalendarEvent): boolean {
  const masterStart = master.start.dateTime ?? master.start.date;
  const originalStart =
    occurrence.originalStartTime?.dateTime ?? occurrence.originalStartTime?.date;
  if (masterStart === undefined || originalStart === undefined) {
    return false;
  }
  return Date.parse(masterStart) === Date.parse(originalStart);
}

function successorId(calendarId: string, masterId: string, occurrence: TCalendarEvent): string {
  const originalStart =
    occurrence.originalStartTime?.dateTime ?? occurrence.originalStartTime?.date ?? "";
  const digest = new Bun.CryptoHasher("sha256")
    .update(`${calendarId}\0${masterId}\0${originalStart}`)
    .digest("hex");
  return `b${digest}`;
}

function isConfirmedNotFound(error: unknown): boolean {
  const detail = String(error).toLowerCase();
  return detail.includes("404") || detail.includes("not found");
}

function eventStartTimestamp(event: TCalendarEvent): number {
  const start = event.start.dateTime ?? event.start.date;
  if (start === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const timestamp = Date.parse(start);
  if (Number.isNaN(timestamp)) {
    return Number.POSITIVE_INFINITY;
  }
  return timestamp;
}

function applyPatch(
  body: Record<string, unknown>,
  patch: TUpdateEventPatch,
  currentEvent: TCalendarEvent,
): void {
  if (patch.summary !== undefined) {
    body.summary = patch.summary;
  }
  if (patch.description !== undefined) {
    body.description = patch.description;
  }
  if (patch.location !== undefined) {
    body.location = patch.location;
  }
  if (patch.transparency !== undefined) {
    body.transparency = patch.transparency;
  }
  if (patch.recurrence !== undefined) {
    body.recurrence = patch.recurrence;
  }
  if (patch.start !== undefined) {
    let end = patch.end;
    if (end === undefined && patch.durationMinutes === undefined) {
      const patchIsAllDay = /^\d{4}-\d{2}-\d{2}$/.test(patch.start);
      if (patchIsAllDay) {
        if (currentEvent.start.date === undefined || currentEvent.end.date === undefined) {
          throw new Error(
            "Changing between timed and all-day events requires an explicit end or duration",
          );
        }
        const currentStart = Date.parse(`${currentEvent.start.date}T00:00:00Z`);
        const currentEnd = Date.parse(`${currentEvent.end.date}T00:00:00Z`);
        const newStart = Date.parse(`${patch.start}T00:00:00Z`);
        const duration = currentEnd - currentStart;
        if (
          Number.isNaN(currentStart) ||
          Number.isNaN(currentEnd) ||
          Number.isNaN(newStart) ||
          duration <= 0 ||
          duration % 86_400_000 !== 0
        ) {
          throw new Error("Existing all-day event has invalid start or end");
        }
        end = new Date(newStart + duration).toISOString().slice(0, 10);
      } else {
        if (currentEvent.start.dateTime === undefined || currentEvent.end.dateTime === undefined) {
          throw new Error(
            "Changing between all-day and timed events requires an explicit end or duration",
          );
        }
        const currentStart = Date.parse(currentEvent.start.dateTime);
        const currentEnd = Date.parse(currentEvent.end.dateTime);
        const newStart = Date.parse(patch.start);
        const duration = currentEnd - currentStart;
        if (
          Number.isNaN(currentStart) ||
          Number.isNaN(currentEnd) ||
          Number.isNaN(newStart) ||
          duration <= 0
        ) {
          throw new Error("Existing timed event has invalid start or end");
        }
        end = new Date(newStart + duration).toISOString();
      }
    }
    const timezone = patch.timezone ?? currentEvent.start.timeZone ?? "UTC";
    const times = normalizeEventTimes(patch.start, end, patch.durationMinutes, timezone);
    body.start = times.start;
    body.end = times.end;
  } else if (
    patch.end !== undefined ||
    patch.durationMinutes !== undefined ||
    patch.timezone !== undefined
  ) {
    throw new Error("Updating end, duration, or timezone requires start");
  }
}

export class CalendarService {
  private static _instance: CalendarService;
  private logger = createLogger("CALENDAR");
  private queue = new AsyncQueue();
  private status: TCalendarStatus = { ready: false, error: "Calendar setup has not run" };

  public constructor(
    private db: LibSQLDatabase = DatabaseConnector.instance.database,
    private client: GwsCalendarClient = new GwsCalendarClient(),
  ) {}

  public static get instance(): CalendarService {
    if (!CalendarService._instance) {
      CalendarService._instance = new CalendarService();
    }
    return CalendarService._instance;
  }

  public getStatus(): TCalendarStatus {
    return { ...this.status };
  }

  private requireReady(): void {
    if (!this.status.ready) {
      throw new Error(this.status.error ?? "Calendar is unavailable");
    }
  }

  private async requireWriteCalendarId(userId: string): Promise<string> {
    this.requireReady();
    const rows = await this.queue.enqueue(() =>
      this.db
        .select()
        .from(calendarsTable)
        .where(and(eq(calendarsTable.userId, userId), eq(calendarsTable.access, "write"))),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(MISSING_WRITE_CALENDAR_MESSAGE);
    }
    return row.calendarId;
  }

  public async setup(): Promise<void> {
    try {
      if (!(await Bun.file(GOOGLE_CREDENTIALS_FILE).exists())) {
        throw new Error(
          `Google Calendar credentials are unavailable at ${GOOGLE_CREDENTIALS_FILE}`,
        );
      }
      this.status = { ready: true, error: undefined };
      this.logger.info("Calendar service is ready");
    } catch (error) {
      this.status = { ready: false, error: String(error) };
      this.logger.error(`Calendar service is unavailable: ${String(error)}`);
    }
  }

  public async setWriteCalendar(userId: string, calendarId: string): Promise<TCalendar> {
    this.requireReady();
    const live = await this.client.probeCalendar(calendarId);
    if (live.accessRole !== "writer") {
      throw new Error(
        `Writable calendar requires exact writer access, received ${live.accessRole ?? "none"}`,
      );
    }
    const addedAt = Date.now();
    await this.queue.enqueue(async () => {
      await this.db.transaction(async (transaction) => {
        await transaction
          .delete(calendarsTable)
          .where(and(eq(calendarsTable.userId, userId), eq(calendarsTable.access, "write")));
        await transaction
          .insert(calendarsTable)
          .values({ userId, calendarId, access: "write", addedAt })
          .onConflictDoUpdate({
            target: [calendarsTable.userId, calendarsTable.calendarId],
            set: { access: "write", addedAt },
          });
      });
    });
    return {
      calendarId,
      access: "write",
      addedAt,
      summary: live.summary,
      error: undefined,
    };
  }

  public async listCalendars(userId: string, signal?: AbortSignal): Promise<TCalendar[]> {
    this.requireReady();
    const rows = await this.queue.enqueue(() =>
      this.db.select().from(calendarsTable).where(eq(calendarsTable.userId, userId)),
    );
    return Promise.all(
      rows.map(async (row) => {
        let access: TCalendarAccess = "read";
        if (row.access === "write") {
          access = "write";
        }
        try {
          const live = await this.client.probeCalendar(row.calendarId, signal);
          return {
            calendarId: row.calendarId,
            access,
            addedAt: row.addedAt,
            summary: live.summary,
            error: undefined,
          };
        } catch (error) {
          if (signal?.aborted) {
            throw error;
          }
          return {
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

  public async addReadonlyCalendar(
    userId: string,
    calendarId: string,
    signal?: AbortSignal,
  ): Promise<TCalendar> {
    this.requireReady();
    const existing = await this.queue.enqueue(() =>
      this.db
        .select()
        .from(calendarsTable)
        .where(and(eq(calendarsTable.userId, userId), eq(calendarsTable.calendarId, calendarId))),
    );
    if (existing[0]?.access === "write") {
      throw new Error("Writable calendar cannot be added as read-only");
    }
    const live = await this.client.probeCalendar(calendarId, signal);
    if (live.accessRole !== "reader") {
      throw new Error(
        `Read-only calendar requires exact reader access, received ${live.accessRole ?? "none"}`,
      );
    }
    const addedAt = Date.now();
    await this.queue.enqueue(async () => {
      await this.db
        .insert(calendarsTable)
        .values({ userId, calendarId, access: "read", addedAt })
        .onConflictDoUpdate({
          target: [calendarsTable.userId, calendarsTable.calendarId],
          set: { access: "read", addedAt },
        });
    });
    return {
      calendarId,
      access: "read",
      addedAt,
      summary: live.summary,
      error: undefined,
    };
  }

  public async removeReadonlyCalendar(userId: string, calendarId: string): Promise<void> {
    this.requireReady();
    const removed = await this.queue.enqueue(() =>
      this.db
        .delete(calendarsTable)
        .where(
          and(
            eq(calendarsTable.userId, userId),
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

  public async listEvents(args: TListEventsArguments): Promise<TListEventsResult> {
    this.requireReady();
    if (Date.parse(args.timeMin) >= Date.parse(args.timeMax)) {
      throw new Error("timeMax must be after timeMin");
    }
    const rows = await this.queue.enqueue(() =>
      this.db.select().from(calendarsTable).where(eq(calendarsTable.userId, args.userId)),
    );
    const events: TCalendarEvent[] = [];
    const failures: Array<{ calendarId: string; error: string }> = [];
    await Promise.all(
      rows.map(async (row) => {
        try {
          const params: Record<string, unknown> = {
            timeMin: args.timeMin,
            timeMax: args.timeMax,
            singleEvents: true,
            showDeleted: false,
            maxResults: 2500,
          };
          if (args.query !== undefined) {
            params.q = args.query;
          }
          const response = await this.client.listEvents(row.calendarId, params, args.signal);
          for (const item of response.items) {
            events.push(mapEvent(row.calendarId, item));
          }
        } catch (error) {
          if (args.signal?.aborted) {
            throw error;
          }
          failures.push({ calendarId: row.calendarId, error: String(error) });
        }
      }),
    );
    events.sort((left, right) => {
      const leftTimestamp = eventStartTimestamp(left);
      const rightTimestamp = eventStartTimestamp(right);
      if (leftTimestamp < rightTimestamp) {
        return -1;
      }
      if (leftTimestamp > rightTimestamp) {
        return 1;
      }
      return left.id.localeCompare(right.id);
    });
    return { events, failures };
  }

  public async findAvailability(args: TAvailabilityArguments): Promise<TAvailabilityResult> {
    const result = await this.listEvents({
      userId: args.userId,
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      signal: args.signal,
    });
    return calculateAvailability(
      result.events,
      result.failures,
      args.timeMin,
      args.timeMax,
      args.timezone,
      args.durationMinutes,
    );
  }

  public async createEvent(args: TCreateEventArguments): Promise<TCalendarEvent> {
    const calendarId = await this.requireWriteCalendarId(args.userId);
    const times = normalizeEventTimes(args.start, args.end, args.durationMinutes, args.timezone);
    const body: Record<string, unknown> = {
      summary: args.summary,
      start: times.start,
      end: times.end,
      reminders: { useDefault: true },
    };
    if (args.description !== undefined) {
      body.description = args.description;
    }
    if (args.location !== undefined) {
      body.location = args.location;
    }
    if (args.transparency !== undefined) {
      body.transparency = args.transparency;
    }
    if (args.recurrence !== undefined) {
      body.recurrence = args.recurrence;
    }
    return mapEvent(calendarId, await this.client.insertEvent(calendarId, body, args.signal));
  }

  private async resolveMutation(
    calendarId: string,
    eventId: string,
    signal?: AbortSignal,
  ): Promise<TCalendarEvent> {
    const event = mapEvent(calendarId, await this.client.getEvent(calendarId, eventId, signal));
    if (event.id !== eventId) {
      throw new Error(`Google returned event ${event.id} while resolving ${eventId}`);
    }
    assertMutableEvent(event);
    return event;
  }

  private async resolveOccurrenceNumber(
    master: TCalendarEvent,
    occurrence: TCalendarEvent,
    signal?: AbortSignal,
  ): Promise<TOption<number[]>> {
    if (!master.recurrence.some((line) => line.includes("COUNT="))) {
      return undefined;
    }
    if (occurrence.originalStartTime === undefined) {
      throw new Error("COUNT recurrence boundary cannot be resolved");
    }
    const originalStartTime = occurrence.originalStartTime;
    signal?.throwIfAborted();
    return master.recurrence
      .filter((line) => line.startsWith("RRULE:") && line.includes("COUNT="))
      .map((line) => countRuleOccurrencesBefore([line], master.start, originalStartTime));
  }

  public async updateEvent(args: TUpdateEventArguments): Promise<TCalendarEvent> {
    const calendarId = await this.requireWriteCalendarId(args.userId);
    const resolved = await this.resolveMutation(calendarId, args.eventId, args.signal);
    if (args.scope === "occurrence") {
      const hasRecurringId = resolved.recurringEventId !== undefined;
      const hasOriginalStart = resolved.originalStartTime !== undefined;
      if (hasRecurringId !== hasOriginalStart || resolved.recurrence.length > 0) {
        throw new Error(
          "Occurrence scope requires a concrete recurring occurrence or a non-recurring event",
        );
      }
      const body: Record<string, unknown> = {};
      applyPatch(body, args.patch, resolved);
      return mapEvent(
        calendarId,
        await this.client.patchEvent(calendarId, resolved.id, body, args.signal),
      );
    }

    const masterId = resolved.recurringEventId ?? resolved.id;
    const master = await this.resolveMutation(calendarId, masterId, args.signal);
    if (args.scope === "series") {
      const body: Record<string, unknown> = {};
      applyPatch(body, args.patch, master);
      return mapEvent(
        calendarId,
        await this.client.patchEvent(calendarId, master.id, body, args.signal),
      );
    }
    if (resolved.recurringEventId === undefined || resolved.originalStartTime === undefined) {
      throw new Error("Following scope requires a concrete recurring occurrence");
    }
    if (isFirstOccurrence(master, resolved)) {
      const body: Record<string, unknown> = {};
      applyPatch(body, args.patch, master);
      return mapEvent(
        calendarId,
        await this.client.patchEvent(calendarId, master.id, body, args.signal),
      );
    }

    assertFollowingSplitSafe(master);
    const occurrenceNumber = await this.resolveOccurrenceNumber(master, resolved, args.signal);
    const split = splitRecurrence(
      master.recurrence,
      master.start,
      resolved.originalStartTime,
      occurrenceNumber,
    );
    await this.client.patchEvent(
      calendarId,
      master.id,
      { recurrence: split.original },
      args.signal,
    );
    const successor = eventBody(master);
    successor.start = resolved.start;
    successor.end = resolved.end;
    successor.recurrence = split.successor;
    const deterministicId = successorId(calendarId, master.id, resolved);
    successor.id = deterministicId;
    applyPatch(successor, args.patch, resolved);
    try {
      return mapEvent(
        calendarId,
        await this.client.insertEvent(calendarId, successor, args.signal),
      );
    } catch (error) {
      try {
        const existing = mapEvent(
          calendarId,
          await this.client.getEvent(calendarId, deterministicId, AbortSignal.timeout(5_000)),
        );
        if (existing.id !== deterministicId) {
          throw new Error(
            `Google returned event ${existing.id} while verifying successor ${deterministicId}`,
          );
        }
        return existing;
      } catch (verificationError) {
        if (!isConfirmedNotFound(verificationError)) {
          throw new Error(
            `Failed to create successor series and could not verify its state: ${String(error)}; verification: ${String(verificationError)}`,
          );
        }
      }
      try {
        await this.client.patchEvent(
          calendarId,
          master.id,
          { recurrence: master.recurrence },
          AbortSignal.timeout(5_000),
        );
      } catch (restoreError) {
        throw new Error(
          `Failed to create successor series and restore the original: ${String(error)}; restore: ${String(restoreError)}`,
        );
      }
      throw new Error(`Failed to create successor series; original restored: ${String(error)}`);
    }
  }

  public async deleteEvent(args: TDeleteEventArguments): Promise<void> {
    const calendarId = await this.requireWriteCalendarId(args.userId);
    const resolved = await this.resolveMutation(calendarId, args.eventId, args.signal);
    if (args.scope === "occurrence") {
      const hasRecurringId = resolved.recurringEventId !== undefined;
      const hasOriginalStart = resolved.originalStartTime !== undefined;
      if (hasRecurringId !== hasOriginalStart || resolved.recurrence.length > 0) {
        throw new Error(
          "Occurrence scope requires a concrete recurring occurrence or a non-recurring event",
        );
      }
      await this.client.deleteEvent(calendarId, resolved.id, args.signal);
      return;
    }
    const masterId = resolved.recurringEventId ?? resolved.id;
    const master = await this.resolveMutation(calendarId, masterId, args.signal);
    if (args.scope === "series") {
      await this.client.deleteEvent(calendarId, master.id, args.signal);
      return;
    }
    if (resolved.recurringEventId === undefined || resolved.originalStartTime === undefined) {
      throw new Error("Following scope requires a concrete recurring occurrence");
    }
    if (isFirstOccurrence(master, resolved)) {
      await this.client.deleteEvent(calendarId, master.id, args.signal);
      return;
    }
    const occurrenceNumber = await this.resolveOccurrenceNumber(master, resolved, args.signal);
    const split = splitRecurrence(
      master.recurrence,
      master.start,
      resolved.originalStartTime,
      occurrenceNumber,
    );
    await this.client.patchEvent(
      calendarId,
      master.id,
      { recurrence: split.original },
      args.signal,
    );
  }
}

export * from "./types";
