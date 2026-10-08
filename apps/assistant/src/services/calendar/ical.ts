import type { TOption } from "@bellaclaw/shared";
import ICAL from "ical.js";
import { normalizeEventTimes, patchEvent } from "./event-fields";
import { assertFollowingOrder, splitICalendarResource } from "./ical-following";
import { listICalendarEvents } from "./ical-listing";
import { mapICalendarEvent } from "./ical-mapping";
import {
  calendarTime,
  eventEnd,
  loadCalendarTimezones,
  loadMasterEvent,
  MAX_OCCURRENCES,
  occurrenceDetails,
  occurrenceKey,
  recurrenceIterator,
  replaceRecurrence,
  stamp,
  text,
} from "./ical-time";
import type { TCalendarEvent, TCreateEventArguments, TUpdateEventPatch } from "./types";

const RECURRENCE_PROPERTIES = ["rrule", "rdate", "exdate"];

export class ICalendarResource {
  public readonly calendar: ICAL.Component;
  public readonly master: ICAL.Event;
  public readonly timezone: string;

  public constructor(
    public readonly filename: string,
    data: string,
    calendarTimezone?: string,
  ) {
    this.calendar = new ICAL.Component(ICAL.parse(data));
    if (this.calendar.name !== "vcalendar") {
      throw new Error("iCloud returned an invalid calendar resource");
    }
    this.timezone = calendarTimezone ?? text(this.calendar, "x-wr-timezone") ?? "UTC";
    loadCalendarTimezones(this.calendar, this.timezone);
    const master = this.calendar
      .getAllSubcomponents("vevent")
      .find((component) => !component.hasProperty("recurrence-id"));
    if (master === undefined || !master.hasProperty("dtstart") || !master.hasProperty("uid")) {
      throw new Error("iCloud resource has no identifiable master event");
    }
    this.master = loadMasterEvent(master);
  }

  public static create(
    filename: string,
    uid: string,
    args: TCreateEventArguments,
  ): ICalendarResource {
    const calendar = new ICAL.Component("vcalendar");
    calendar.updatePropertyWithValue("version", "2.0");
    calendar.updatePropertyWithValue("prodid", "-//BellaClaw//Calendar//EN");
    const component = new ICAL.Component("vevent");
    calendar.addSubcomponent(component);
    const event = new ICAL.Event(component);
    event.uid = uid;
    event.summary = args.summary;
    const times = normalizeEventTimes(args.start, args.end, args.durationMinutes, args.timezone);
    event.startDate = calendarTime(calendar, times.start);
    event.endDate = calendarTime(calendar, { ...times.end, timeZone: "UTC" });
    if (args.description !== undefined) {
      event.description = args.description;
    }
    if (args.location !== undefined) {
      event.location = args.location;
    }
    component.updatePropertyWithValue("transp", (args.transparency ?? "opaque").toUpperCase());
    component.updatePropertyWithValue("status", "CONFIRMED");
    if (args.recurrence !== undefined) {
      replaceRecurrence(event, args.recurrence);
    }
    component.updatePropertyWithValue("created", ICAL.Time.fromJSDate(new Date(), true));
    stamp(event);
    return new ICalendarResource(filename, calendar.toString(), args.timezone);
  }

  public toString(): string {
    return this.calendar.toString();
  }

  public event(calendarId: string, occurrence?: string, etag?: string): TCalendarEvent {
    if (occurrence === undefined) {
      return mapICalendarEvent(
        this.filename,
        calendarId,
        this.master,
        this.master.startDate,
        eventEnd(this.master, this.master.startDate),
        this.timezone,
        undefined,
        etag,
      );
    }
    const original = this.resolveOccurrence(occurrence);
    const details = occurrenceDetails(this.master, original);
    const mapped = mapICalendarEvent(
      this.filename,
      calendarId,
      details.item,
      details.startDate,
      details.endDate,
      this.timezone,
      original,
      etag,
    );
    mapped.recurrence = [];
    if (mapped.status === "cancelled") {
      throw new Error("Recurring occurrence is cancelled");
    }
    return mapped;
  }

  public resolveOccurrence(occurrence: string): ICAL.Time {
    if (!this.master.isRecurring()) {
      throw new Error("Occurrence ID does not belong to a recurring series");
    }
    const iterator = recurrenceIterator(this.master);
    for (let step = 0; step < MAX_OCCURRENCES; step += 1) {
      const next = iterator.next();
      if (next === undefined || next === null || occurrenceKey(next) > occurrence) {
        throw new Error("Recurring occurrence no longer exists");
      }
      if (occurrenceKey(next) === occurrence) {
        return next;
      }
    }
    throw new Error(`Recurring occurrence lookup exceeded ${MAX_OCCURRENCES} instances`);
  }

  public listEvents(
    calendarId: string,
    timeMin: string,
    timeMax: string,
    etag?: string,
  ): TCalendarEvent[] {
    return listICalendarEvents(this, calendarId, timeMin, timeMax, etag);
  }

  private applyPatch(calendarId: string, event: ICAL.Event, patch: TUpdateEventPatch): void {
    const current = mapICalendarEvent(
      this.filename,
      calendarId,
      event,
      event.startDate,
      eventEnd(event, event.startDate),
      this.timezone,
    );
    const updated = patchEvent(current, patch);
    if (patch.summary !== undefined) {
      event.summary = updated.summary ?? "";
    }
    if (patch.description !== undefined) {
      event.description = updated.description ?? "";
    }
    if (patch.location !== undefined) {
      event.location = updated.location ?? "";
    }
    if (patch.start !== undefined) {
      event.startDate = calendarTime(this.calendar, updated.start);
      event.endDate = calendarTime(this.calendar, { ...updated.end, timeZone: "UTC" });
    }
    if (patch.transparency !== undefined) {
      event.component.updatePropertyWithValue("transp", patch.transparency.toUpperCase());
    }
    if (patch.recurrence !== undefined) {
      replaceRecurrence(event, patch.recurrence);
    }
    stamp(event);
  }

  public update(
    calendarId: string,
    scope: "occurrence" | "series",
    patch: TUpdateEventPatch,
    occurrence?: string,
  ): TCalendarEvent {
    if (scope === "series" || !this.master.isRecurring()) {
      if (
        this.master.isRecurring() &&
        scope === "series" &&
        (patch.start !== undefined || patch.recurrence !== undefined) &&
        (this.calendar.getAllSubcomponents("vevent").length > 1 ||
          this.master.component.hasProperty("exdate"))
      ) {
        throw new Error(
          "Changing series times or recurrence with modified occurrences or deleted occurrences is not supported; edit an occurrence instead",
        );
      }
      this.applyPatch(calendarId, this.master, patch);
      if (scope === "series") {
        for (const component of this.calendar.getAllSubcomponents("vevent")) {
          if (component.hasProperty("recurrence-id")) {
            this.applyPatch(calendarId, new ICAL.Event(component), patch);
          }
        }
      }
      return this.event(calendarId);
    }
    if (occurrence === undefined || patch.recurrence !== undefined) {
      throw new Error(
        "Occurrence scope requires a concrete occurrence and cannot change recurrence",
      );
    }
    const original = this.resolveOccurrence(occurrence);
    const details = occurrenceDetails(this.master, original);
    let component = this.calendar
      .getAllSubcomponents("vevent")
      .find(
        (candidate) =>
          candidate.hasProperty("recurrence-id") &&
          occurrenceKey(new ICAL.Event(candidate).recurrenceId) === occurrence,
      );
    if (component !== undefined && new ICAL.Event(component).modifiesFuture()) {
      throw new Error("Cannot edit only the boundary of a THISANDFUTURE override");
    }
    if (component === undefined) {
      component = new ICAL.Component(ICAL.parse(details.item.component.toString()));
      for (const name of RECURRENCE_PROPERTIES) {
        component.removeAllProperties(name);
      }
      component.removeAllProperties("recurrence-id");
      this.calendar.addSubcomponent(component);
    }
    const exception = new ICAL.Event(component);
    exception.startDate = details.startDate;
    exception.endDate = details.endDate;
    exception.recurrenceId = original;
    this.applyPatch(calendarId, exception, patch);
    const event = mapICalendarEvent(
      this.filename,
      calendarId,
      exception,
      exception.startDate,
      exception.endDate,
      this.timezone,
      original,
    );
    event.recurrence = [];
    return event;
  }

  public deleteOccurrence(occurrence: string): void {
    const original = this.resolveOccurrence(occurrence);
    for (const component of this.calendar.getAllSubcomponents("vevent")) {
      if (
        component.hasProperty("recurrence-id") &&
        occurrenceKey(new ICAL.Event(component).recurrenceId) === occurrence
      ) {
        if (new ICAL.Event(component).modifiesFuture()) {
          throw new Error("Cannot delete only the boundary of a THISANDFUTURE override");
        }
        this.calendar.removeSubcomponent(component);
      }
    }
    const excluded = new ICAL.Property("exdate");
    excluded.setValue(original);
    if (!original.isDate && original.zone !== ICAL.Timezone.utcTimezone) {
      excluded.setParameter("tzid", original.zone.tzid);
    }
    this.master.component.addProperty(excluded);
    stamp(this.master);
  }

  public isFirstOccurrence(occurrence: string): boolean {
    assertFollowingOrder(this);
    return occurrence === occurrenceKey(this.master.startDate);
  }

  public split(
    calendarId: string,
    occurrence: string,
    patch?: TUpdateEventPatch,
  ): TOption<ICalendarResource> {
    return splitICalendarResource(this, calendarId, occurrence, patch);
  }
}
