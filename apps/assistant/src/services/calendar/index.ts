import type { TOption } from "@bellaclaw/shared";
import { AsyncQueue, createLogger, repositoryPath } from "@bellaclaw/shared";
import { and, eq, ne } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { z } from "zod";
import { DatabaseConnector } from "../database";
import { calendarsTable } from "../database/schema";
import { calculateAvailability } from "./availability";
import { GwsCalendarClient } from "./gws";
import {
  ALL_DAY_DATE,
  countRuleOccurrencesBefore,
  splitRecurrence,
  type TRecurrenceSplit,
} from "./recurrence";
import type {
  TAvailabilityArguments,
  TAvailabilityResult,
  TCalendar,
  TCalendarAccess,
  TCalendarEvent,
  TCreateEventArguments,
  TDeleteEventArguments,
  TEventDateTime,
  TListEventsArguments,
  TListEventsResult,
  TRecurrenceScope,
  TUpdateEventArguments,
  TUpdateEventPatch,
} from "./types";

const GOOGLE_CREDENTIALS_FILE = repositoryPath(".secrets/google-calendar-service-account.json");
const MISSING_WRITE_CALENDAR_MESSAGE =
  "No writable calendar is configured for this chat. Share a Google calendar with the bot's service account granting write access, then send: !calendar_add-write CALENDAR_ID";

type TCalendarStatus = {
  ready: boolean;
  error: TOption<string>;
};

type TMutationTarget =
  | { kind: "single"; event: TCalendarEvent }
  | {
      kind: "following";
      master: TCalendarEvent;
      occurrence: TCalendarEvent;
      originalStartTime: TEventDateTime;
    };

const SOptionalString = z.string().or(z.undefined()).catch(undefined);
const SOptionalNumber = z.number().or(z.undefined()).catch(undefined);
const SOptionalBoolean = z.boolean().or(z.undefined()).catch(undefined);
const SLenientRecord = z.record(z.string(), z.unknown()).catch(() => ({}));
const SUnknownArray = z.array(z.unknown()).catch(() => []);

const SGoogleDateTime = SLenientRecord.pipe(
  z.object({
    date: SOptionalString,
    dateTime: SOptionalString,
    timeZone: SOptionalString,
  }),
);

const SGooglePerson = SLenientRecord.pipe(
  z.object({
    id: SOptionalString,
    email: SOptionalString,
    displayName: SOptionalString,
    responseStatus: SOptionalString,
    self: SOptionalBoolean,
    optional: SOptionalBoolean,
    resource: SOptionalBoolean,
    comment: SOptionalString,
    additionalGuests: SOptionalNumber,
  }),
);

const SGooglePayload = z.record(z.string(), z.unknown());

const SGoogleEvent = z.object({
  id: SOptionalString,
  etag: SOptionalString,
  status: SOptionalString,
  colorId: SOptionalString,
  eventLabelId: SOptionalString,
  eventLabelVersion: SOptionalString,
  sequence: SOptionalNumber,
  endTimeUnspecified: SOptionalBoolean,
  attendeesOmitted: SOptionalBoolean,
  gadget: z.unknown(),
  eventType: SOptionalString,
  summary: SOptionalString,
  description: SOptionalString,
  location: SOptionalString,
  start: SGoogleDateTime,
  end: SGoogleDateTime,
  transparency: SOptionalString,
  recurrence: SUnknownArray.transform((lines) => lines.filter((line) => typeof line === "string")),
  recurringEventId: SOptionalString,
  originalStartTime: z.undefined().or(SGoogleDateTime),
  organizer: z.undefined().or(SGooglePerson),
  creator: z.undefined().or(SGooglePerson),
  attendees: z.array(SGooglePerson).catch(() => []),
  attachments: SUnknownArray,
  hangoutLink: SOptionalString,
  conferenceData: z.unknown(),
  htmlLink: SOptionalString,
  visibility: SOptionalString,
  created: SOptionalString,
  updated: SOptionalString,
  iCalUID: SOptionalString,
  reminders: z.unknown(),
});

const UNSUPPORTED_MANAGED_FIELDS = [
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
];

function mapEvent(calendarId: string, value: unknown): TCalendarEvent {
  const payload = SGooglePayload.safeParse(value);
  const event = SGoogleEvent.safeParse(payload.data);
  if (!payload.success || !event.success || event.data.id === undefined) {
    throw new Error(`Google returned an event without an id for calendar ${calendarId}`);
  }
  return {
    calendarId,
    ...event.data,
    id: event.data.id,
    googleDetails: value,
    unsupportedManagedFields: UNSUPPORTED_MANAGED_FIELDS.filter(
      (key) => payload.data[key] !== undefined,
    ),
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

function normalizeEventTimes(
  start: string,
  end: TOption<string>,
  timezone: string,
  defaultDurationMs: TOption<number>,
): { start: Record<string, unknown>; end: Record<string, unknown> } {
  if (ALL_DAY_DATE.test(start)) {
    if (end !== undefined) {
      if (!ALL_DAY_DATE.test(end)) {
        throw new Error("All-day event end must also be a date");
      }
      return { start: { date: start }, end: { date: end } };
    }
    const timestamp = Date.parse(`${start}T00:00:00Z`);
    if (Number.isNaN(timestamp)) {
      throw new Error(`Invalid all-day date: ${start}`);
    }
    const endTimestamp = timestamp + (defaultDurationMs ?? 86_400_000);
    return {
      start: { date: start },
      end: { date: new Date(endTimestamp).toISOString().slice(0, 10) },
    };
  }

  const startTimestamp = Date.parse(start);
  if (Number.isNaN(startTimestamp)) {
    throw new Error(`Invalid event start: ${start}`);
  }
  let endValue = end;
  if (endValue === undefined) {
    endValue = new Date(startTimestamp + (defaultDurationMs ?? 60 * 60_000)).toISOString();
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
    let defaultDurationMs: TOption<number>;
    if (patch.end === undefined) {
      if (ALL_DAY_DATE.test(patch.start)) {
        if (currentEvent.start.date === undefined || currentEvent.end.date === undefined) {
          throw new Error("Changing between timed and all-day events requires an explicit end");
        }
        const currentStart = Date.parse(`${currentEvent.start.date}T00:00:00Z`);
        const currentEnd = Date.parse(`${currentEvent.end.date}T00:00:00Z`);
        const duration = currentEnd - currentStart;
        if (
          Number.isNaN(currentStart) ||
          Number.isNaN(currentEnd) ||
          duration <= 0 ||
          duration % 86_400_000 !== 0
        ) {
          throw new Error("Existing all-day event has invalid start or end");
        }
        defaultDurationMs = duration;
      } else {
        if (currentEvent.start.dateTime === undefined || currentEvent.end.dateTime === undefined) {
          throw new Error("Changing between all-day and timed events requires an explicit end");
        }
        const currentStart = Date.parse(currentEvent.start.dateTime);
        const currentEnd = Date.parse(currentEvent.end.dateTime);
        const duration = currentEnd - currentStart;
        if (Number.isNaN(currentStart) || Number.isNaN(currentEnd) || duration <= 0) {
          throw new Error("Existing timed event has invalid start or end");
        }
        defaultDurationMs = duration;
      }
    }
    const timezone = patch.timezone ?? currentEvent.start.timeZone ?? "UTC";
    const times = normalizeEventTimes(patch.start, patch.end, timezone, defaultDurationMs);
    body.start = times.start;
    body.end = times.end;
  } else if (patch.end !== undefined || patch.timezone !== undefined) {
    throw new Error("Updating end or timezone requires start");
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

  public async addReadonlyCalendar(userId: string, calendarId: string): Promise<TCalendar> {
    this.requireReady();
    const live = await this.client.probeCalendar(calendarId);
    if (
      live.accessRole !== "reader" &&
      live.accessRole !== "writer" &&
      live.accessRole !== "owner"
    ) {
      throw new Error(
        `Read-only calendar requires reader, writer, or owner access, received ${live.accessRole ?? "none"}`,
      );
    }
    const addedAt = Date.now();
    const inserted = await this.queue.enqueue(() =>
      this.db
        .insert(calendarsTable)
        .values({ userId, calendarId, access: "read", addedAt })
        .onConflictDoUpdate({
          target: [calendarsTable.userId, calendarsTable.calendarId],
          set: { access: "read", addedAt },
          setWhere: ne(calendarsTable.access, "write"),
        })
        .returning(),
    );
    if (inserted.length === 0) {
      throw new Error("Writable calendar cannot be added as read-only");
    }
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
    const times = normalizeEventTimes(args.start, args.end, args.timezone, undefined);
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

  private async resolveTarget(
    calendarId: string,
    eventId: string,
    scope: TRecurrenceScope,
    signal?: AbortSignal,
  ): Promise<TMutationTarget> {
    const resolved = await this.resolveMutation(calendarId, eventId, signal);
    if (scope === "occurrence") {
      const hasRecurringId = resolved.recurringEventId !== undefined;
      const hasOriginalStart = resolved.originalStartTime !== undefined;
      if (hasRecurringId !== hasOriginalStart || resolved.recurrence.length > 0) {
        throw new Error(
          "Occurrence scope requires a concrete recurring occurrence or a non-recurring event",
        );
      }
      return { kind: "single", event: resolved };
    }
    const masterId = resolved.recurringEventId ?? resolved.id;
    const master = await this.resolveMutation(calendarId, masterId, signal);
    if (scope === "series") {
      return { kind: "single", event: master };
    }
    if (resolved.recurringEventId === undefined || resolved.originalStartTime === undefined) {
      throw new Error("Following scope requires a concrete recurring occurrence");
    }
    if (isFirstOccurrence(master, resolved)) {
      return { kind: "single", event: master };
    }
    return {
      kind: "following",
      master,
      occurrence: resolved,
      originalStartTime: resolved.originalStartTime,
    };
  }

  private splitFollowing(
    master: TCalendarEvent,
    originalStartTime: TEventDateTime,
    signal?: AbortSignal,
  ): TRecurrenceSplit {
    let occurrenceNumber: TOption<number[]>;
    if (master.recurrence.some((line) => line.includes("COUNT="))) {
      signal?.throwIfAborted();
      occurrenceNumber = master.recurrence
        .filter((line) => line.startsWith("RRULE:") && line.includes("COUNT="))
        .map((line) => countRuleOccurrencesBefore([line], master.start, originalStartTime));
    }
    return splitRecurrence(master.recurrence, master.start, originalStartTime, occurrenceNumber);
  }

  public async updateEvent(args: TUpdateEventArguments): Promise<TCalendarEvent> {
    const calendarId = await this.requireWriteCalendarId(args.userId);
    const target = await this.resolveTarget(calendarId, args.eventId, args.scope, args.signal);
    if (target.kind === "single") {
      const body: Record<string, unknown> = {};
      applyPatch(body, args.patch, target.event);
      return mapEvent(
        calendarId,
        await this.client.patchEvent(calendarId, target.event.id, body, args.signal),
      );
    }

    const { master, occurrence } = target;
    assertFollowingSplitSafe(master);
    const split = this.splitFollowing(master, target.originalStartTime, args.signal);
    const successor = eventBody(master);
    successor.start = occurrence.start;
    successor.end = occurrence.end;
    successor.recurrence = split.successor;
    const deterministicId = successorId(calendarId, master.id, occurrence);
    successor.id = deterministicId;
    applyPatch(successor, args.patch, occurrence);
    await this.client.patchEvent(
      calendarId,
      master.id,
      { recurrence: split.original },
      args.signal,
    );
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
    const target = await this.resolveTarget(calendarId, args.eventId, args.scope, args.signal);
    if (target.kind === "single") {
      await this.client.deleteEvent(calendarId, target.event.id, args.signal);
      return;
    }
    const split = this.splitFollowing(target.master, target.originalStartTime, args.signal);
    await this.client.patchEvent(
      calendarId,
      target.master.id,
      { recurrence: split.original },
      args.signal,
    );
  }
}

export * from "./types";
