import type { TOption } from "@bellaclaw/shared";
import type { DAVCalendarObject } from "tsdav";
import { ICalendarResource } from "./ical";
import { ICloudCalendarClient } from "./icloud-client";
import { CalendarObjectNotFound } from "./icloud-objects";
import {
  ECalendarProvider,
  type TCalendarEvent,
  type TCalendarProvider,
  type TCreateEventArguments,
  type TDeleteEventArguments,
  type TListEventsArguments,
  type TUpdateEventArguments,
} from "./types";

export class ICloudCalendarProvider implements TCalendarProvider {
  public readonly provider = ECalendarProvider.ICloud;
  public constructor(private client = new ICloudCalendarClient()) {}

  public setup(): Promise<void> {
    return this.client.setup();
  }
  public discoverCalendars(signal?: AbortSignal) {
    return this.client.discoverCalendars(signal);
  }
  public probeCalendar(calendarId: string, signal?: AbortSignal) {
    return this.client.probeCalendar(calendarId, signal);
  }

  public async listEvents(
    calendarId: string,
    args: TListEventsArguments,
  ): Promise<TCalendarEvent[]> {
    const calendar = await this.client.calendar(calendarId, args.signal);
    const objects = await this.client.listObjects(
      calendar,
      args.timeMin,
      args.timeMax,
      args.signal,
    );
    const events: TCalendarEvent[] = [];
    for (const object of objects) {
      args.signal?.throwIfAborted();
      const resource = this.client.parseResource(calendar, object);
      events.push(...resource.listEvents(calendarId, args.timeMin, args.timeMax, object.etag));
    }
    if (args.query !== undefined) {
      const query = args.query.toLowerCase();
      return events.filter((event) =>
        [
          event.summary,
          event.description,
          event.location,
          ...event.attendees.flatMap((attendee) => [attendee.email, attendee.displayName]),
        ].some((value) => value?.toLowerCase().includes(query)),
      );
    }
    return events;
  }

  public async createEvent(
    calendarId: string,
    args: TCreateEventArguments,
  ): Promise<TCalendarEvent> {
    const calendar = await this.client.calendar(calendarId, args.signal);
    const uid = crypto.randomUUID();
    const resource = ICalendarResource.create(`${uid}.ics`, `${uid}@bellaclaw`, args);
    await this.client.createObject(calendar, resource, args.signal);
    const created = await this.client.getObject(calendar, resource.filename, args.signal);
    return this.client.parseResource(calendar, created).event(calendarId, undefined, created.etag);
  }

  public async updateEvent(
    calendarId: string,
    args: TUpdateEventArguments,
  ): Promise<TCalendarEvent> {
    const calendar = await this.client.calendar(calendarId, args.signal);
    const [filename, occurrence, extra] = args.eventId.split("#");
    if (!filename || extra !== undefined) {
      throw new Error("Invalid iCloud event ID");
    }
    const object = await this.client.getObject(calendar, filename, args.signal);
    const resource = this.client.parseResource(calendar, object);
    const current = resource.event(calendarId, occurrence);
    if (current.status === "cancelled") {
      throw new Error("iCloud event is cancelled");
    }
    if (args.scope !== "following") {
      const updated = resource.update(calendarId, args.scope, args.patch, occurrence);
      const saved = await this.client.saveObject(object, resource.toString(), args.signal);
      return { ...updated, etag: saved.etag };
    }
    if (occurrence === undefined) {
      throw new Error("Following scope requires a concrete recurring occurrence");
    }
    if (resource.isFirstOccurrence(occurrence)) {
      const updated = resource.update(calendarId, "series", args.patch);
      const saved = await this.client.saveObject(object, resource.toString(), args.signal);
      return { ...updated, etag: saved.etag };
    }
    const successor = resource.split(calendarId, occurrence, args.patch);
    if (successor === undefined) {
      throw new Error("Following scope could not create a successor series");
    }
    let trimmed: TOption<DAVCalendarObject>;
    try {
      trimmed = await this.client.saveObject(object, resource.toString(), args.signal);
      await this.client.createObject(calendar, successor, args.signal);
      return successor.event(calendarId);
    } catch (error) {
      const recoverySignal = AbortSignal.timeout(30_000);
      if (trimmed === undefined) {
        try {
          const stored = await this.client.getObject(calendar, filename, recoverySignal);
          const verified = this.client.parseResource(calendar, stored);
          if (verified.toString() === resource.toString()) {
            if (typeof object.data !== "string") {
              throw new Error("Original calendar data is unavailable");
            }
            await this.client.saveObject(stored, object.data, recoverySignal);
          } else if (stored.data !== object.data) {
            throw new Error("Original series changed after trim; cannot safely restore it");
          }
        } catch (restoreError) {
          throw new Error(
            `Series trim failed and original series could not be verified or restored: ${String(error)}; ${String(restoreError)}`,
          );
        }
        throw new Error(
          `Series trim failed; original series restored or unchanged: ${String(error)}`,
        );
      }
      try {
        const existing = await this.client.getObject(calendar, successor.filename, recoverySignal);
        const verified = this.client.parseResource(calendar, existing);
        if (
          verified.master.uid !== successor.master.uid ||
          verified.toString() !== successor.toString()
        ) {
          throw new Error("Successor state differs from the requested event");
        }
        return verified.event(calendarId, undefined, existing.etag);
      } catch (verificationError) {
        if (!(verificationError instanceof CalendarObjectNotFound)) {
          throw new Error(
            `Could not verify successor series after failed creation: ${String(error)}; ${String(verificationError)}`,
          );
        }
      }
      try {
        if (typeof object.data !== "string") {
          throw new Error("Original calendar data is unavailable");
        }
        await this.client.saveObject(trimmed, object.data, recoverySignal);
      } catch (restoreError) {
        throw new Error(
          `Successor creation failed and original series could not be restored: ${String(error)}; ${String(restoreError)}`,
        );
      }
      throw new Error(`Successor creation failed; original series restored: ${String(error)}`);
    }
  }

  public async deleteEvent(calendarId: string, args: TDeleteEventArguments): Promise<void> {
    const calendar = await this.client.calendar(calendarId, args.signal);
    const [filename, occurrence, extra] = args.eventId.split("#");
    if (!filename || extra !== undefined) {
      throw new Error("Invalid iCloud event ID");
    }
    const object = await this.client.getObject(calendar, filename, args.signal);
    const resource = this.client.parseResource(calendar, object);
    resource.event(calendarId, occurrence);
    if (args.scope === "following" && occurrence === undefined) {
      throw new Error("Following scope requires a concrete recurring occurrence");
    }
    if (args.scope === "occurrence" && resource.master.isRecurring()) {
      if (occurrence === undefined) {
        throw new Error("Occurrence scope requires a concrete recurring occurrence");
      }
      resource.deleteOccurrence(occurrence);
      await this.client.saveObject(object, resource.toString(), args.signal);
      return;
    }
    if (
      args.scope === "following" &&
      occurrence !== undefined &&
      !resource.isFirstOccurrence(occurrence)
    ) {
      resource.split(calendarId, occurrence);
      await this.client.saveObject(object, resource.toString(), args.signal);
      return;
    }
    await this.client.deleteObject(object, args.signal);
  }
}
