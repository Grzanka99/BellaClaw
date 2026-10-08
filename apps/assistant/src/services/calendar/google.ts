import type { TOption } from "@bellaclaw/shared";
import { repositoryPath } from "@bellaclaw/shared";
import { normalizeEventTimes } from "./event-fields";
import { applyPatch, assertMutableEvent, mapEvent } from "./google-events";
import { isFirstOccurrence, splitGoogleFollowingEvent } from "./google-following";
import { GwsCalendarClient } from "./gws";
import { countRuleOccurrencesBefore, splitRecurrence } from "./recurrence";
import {
  ECalendarProvider,
  type TCalendarEvent,
  type TCalendarProvider,
  type TCreateEventArguments,
  type TDeleteEventArguments,
  type TListEventsArguments,
  type TProviderCalendar,
  type TUpdateEventArguments,
} from "./types";

export class GoogleCalendarProvider implements TCalendarProvider {
  public readonly provider = ECalendarProvider.Google;
  public constructor(private client: GwsCalendarClient = new GwsCalendarClient()) {}

  public async setup(): Promise<void> {
    if (
      !(await Bun.file(repositoryPath(".secrets/google-calendar-service-account.json")).exists())
    ) {
      throw new Error("Google Calendar service-account credentials are missing");
    }
  }

  public async probeCalendar(calendarId: string, signal?: AbortSignal): Promise<TProviderCalendar> {
    const live = await this.client.probeCalendar(calendarId, signal);
    return {
      calendarId,
      summary: live.summary,
      readable:
        live.accessRole === "reader" || live.accessRole === "writer" || live.accessRole === "owner",
      writable: live.accessRole === "writer",
    };
  }

  public async discoverCalendars(signal?: AbortSignal): Promise<TProviderCalendar[]> {
    const calendars = await this.client.listCalendars(signal);
    return calendars.map((calendar) => ({
      calendarId: calendar.id,
      summary: calendar.summary,
      readable:
        calendar.accessRole === "reader" ||
        calendar.accessRole === "writer" ||
        calendar.accessRole === "owner",
      writable: calendar.accessRole === "writer",
    }));
  }

  public async listEvents(
    calendarId: string,
    args: TListEventsArguments,
  ): Promise<TCalendarEvent[]> {
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
    const response = await this.client.listEvents(calendarId, params, args.signal);
    return response.items.map((item) => mapEvent(calendarId, item));
  }

  public async createEvent(
    calendarId: string,
    args: TCreateEventArguments,
  ): Promise<TCalendarEvent> {
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

  public async updateEvent(
    calendarId: string,
    args: TUpdateEventArguments,
  ): Promise<TCalendarEvent> {
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

    const occurrenceNumber = await this.resolveOccurrenceNumber(master, resolved, args.signal);
    return splitGoogleFollowingEvent(
      this.client,
      calendarId,
      master,
      resolved,
      args,
      occurrenceNumber,
    );
  }

  public async deleteEvent(calendarId: string, args: TDeleteEventArguments): Promise<void> {
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
