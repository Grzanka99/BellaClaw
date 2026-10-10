import ICAL from "ical.js";
import { calendarBoundary } from "./event-fields";
import type { ICalendarResource } from "./ical";
import { mapICalendarEvent } from "./ical-mapping";
import {
  eventEnd,
  eventTime,
  latestClockInstant,
  MAX_OCCURRENCES,
  occurrenceDetails,
  occurrenceKey,
  recurrenceIterator,
  timezoneComponent,
  zonedClock,
} from "./ical-time";
import type { TCalendarEvent } from "./types";

export function listICalendarEvents(
  resource: ICalendarResource,
  calendarId: string,
  timeMin: string,
  timeMax: string,
  etag?: string,
): TCalendarEvent[] {
  const start = Date.parse(timeMin);
  const end = Date.parse(timeMax);
  const events: TCalendarEvent[] = [];
  const seen = new Set<string>();
  const append = (event: TCalendarEvent) => {
    const eventStart = calendarBoundary(event.start, resource.timezone);
    const eventEnd = calendarBoundary(event.end, resource.timezone);
    if (
      event.status !== "cancelled" &&
      eventStart < end &&
      eventEnd > start &&
      !seen.has(event.id)
    ) {
      events.push(event);
      seen.add(event.id);
    }
  };
  const appendOverrides = () => {
    for (const component of resource.calendar.getAllSubcomponents("vevent")) {
      if (component.hasProperty("recurrence-id")) {
        const exception = new ICAL.Event(component);
        append(
          mapICalendarEvent(
            resource.filename,
            calendarId,
            exception,
            exception.startDate,
            eventEnd(exception, exception.startDate),
            resource.timezone,
            exception.recurrenceId,
            etag,
          ),
        );
      }
    }
  };
  if (resource.master.isRecurrenceException()) {
    appendOverrides();
    return events;
  }
  if (!resource.master.isRecurring()) {
    const original = occurrenceKey(resource.master.startDate);
    const excluded = resource.master.component
      .getAllProperties("exdate")
      .flatMap((property) => property.getValues())
      .some((value) => value instanceof ICAL.Time && occurrenceKey(value) === original);
    if (!excluded) {
      append(resource.event(calendarId, undefined, etag));
    }
    return events;
  }
  let expansionEnd = end;
  for (const exception of resource.calendar.getAllSubcomponents("vevent")) {
    if (exception.hasProperty("recurrence-id")) {
      const event = new ICAL.Event(exception);
      if (event.modifiesFuture()) {
        let zone = resource.master.startDate.zone;
        if (resource.master.startDate.isDate) {
          zone = timezoneComponent(resource.calendar, resource.timezone);
        }
        const original = zonedClock(event.recurrenceId, zone);
        const moved = zonedClock(event.startDate, zone);
        const cutoff = zonedClock(ICAL.Time.fromJSDate(new Date(end), true), zone);
        cutoff.addDuration(original.subtractDate(moved));
        expansionEnd = Math.max(expansionEnd, latestClockInstant(cutoff));
      }
    }
  }
  const iterator = recurrenceIterator(resource.master);
  let completed = false;
  for (let step = 0; step < MAX_OCCURRENCES; step += 1) {
    const next = iterator.next();
    if (
      next === undefined ||
      next === null ||
      calendarBoundary(eventTime(next), resource.timezone) >= expansionEnd
    ) {
      completed = true;
      break;
    }
    const details = occurrenceDetails(resource.master, next);
    const event = mapICalendarEvent(
      resource.filename,
      calendarId,
      details.item,
      details.startDate,
      details.endDate,
      resource.timezone,
      next,
      etag,
    );
    event.recurrence = [];
    append(event);
  }
  if (!completed) {
    throw new Error(`iCloud recurrence expansion exceeded ${MAX_OCCURRENCES} instances`);
  }
  appendOverrides();
  return events;
}
