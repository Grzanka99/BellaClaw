import type { TOption } from "@bellaclaw/shared";
import ICAL from "ical.js";
import { tzlib_get_ical_block } from "timezones-ical-library";
import type { TEventDateTime } from "../../types";

export const MAX_OCCURRENCES = 50_000;
const RECURRENCE_PROPERTIES = ["rrule", "rdate", "exdate"];

export function loadCalendarTimezones(calendar: ICAL.Component, calendarTimezone: string): void {
  for (const component of calendar.getAllSubcomponents("vevent")) {
    for (const property of component.getAllProperties()) {
      const timezone = property.getParameter("tzid");
      if (typeof timezone === "string") {
        timezoneComponent(calendar, timezone);
        continue;
      }
      if (!["dtstart", "dtend", "recurrence-id", "exdate", "rdate"].includes(property.name)) {
        continue;
      }
      const values = property.getValues();
      let changed = false;
      for (const value of values) {
        if (
          value instanceof ICAL.Time &&
          !value.isDate &&
          value.zone === ICAL.Timezone.localTimezone
        ) {
          value.zone = timezoneComponent(calendar, calendarTimezone);
          changed = true;
        }
      }
      if (changed) {
        if (property.isMultiValue) {
          property.setValues(values);
        } else {
          property.setValue(values[0]);
        }
        if (
          calendarTimezone !== "UTC" &&
          calendarTimezone !== "Etc/UTC" &&
          calendarTimezone !== "Z"
        ) {
          property.setParameter("tzid", calendarTimezone);
        }
      }
    }
  }
}

export function occurrenceKey(value: ICAL.Time): string {
  if (value.isDate) {
    return value.toString();
  }
  return value.convertToZone(ICAL.Timezone.utcTimezone).toString();
}

export function loadMasterEvent(component: ICAL.Component): ICAL.Event {
  const master = new ICAL.Event(component, { exceptions: [] });
  if (master.isRecurrenceException()) {
    return master;
  }
  for (const child of component.parent?.getAllSubcomponents("vevent") ?? []) {
    if (!child.hasProperty("recurrence-id")) {
      continue;
    }
    const exception = new ICAL.Event(child);
    const original = exception.recurrenceId;
    if (!original.isDate) {
      exception.recurrenceId = original.convertToZone(ICAL.Timezone.utcTimezone);
    }
    // ICAL indexes by string; use UTC keys while retaining the stored timezone.
    master.relateException(exception);
    exception.recurrenceId = original;
  }
  return master;
}

export function recurrenceIterator(event: ICAL.Event): ICAL.RecurExpansion {
  if (!event.component.hasProperty("rdate") || event.component.hasProperty("rrule")) {
    return event.iterator();
  }
  const start = occurrenceKey(event.startDate);
  const included = event.component
    .getAllProperties("rdate")
    .some((property) =>
      property
        .getValues()
        .some((value) => value instanceof ICAL.Time && occurrenceKey(value) === start),
    );
  if (included) {
    return event.iterator();
  }
  // ICAL omits DTSTART in RDATE-only sets; add it to an expansion copy, retaining stored dates.
  const component = new ICAL.Component(
    ICAL.parse(event.component.toString()),
    event.component.parent,
  );
  const first = new ICAL.Property("rdate");
  first.setValue(event.startDate);
  if (!event.startDate.isDate && event.startDate.zone !== ICAL.Timezone.utcTimezone) {
    first.setParameter("tzid", event.startDate.zone.tzid);
  }
  component.addProperty(first);
  return new ICAL.RecurExpansion({ component, dtstart: event.startDate });
}

export function occurrenceDetails(master: ICAL.Event, occurrence: ICAL.Time) {
  const details = master.getOccurrenceDetails(occurrence);
  const event = details.item;
  if (
    event.component.hasProperty("recurrence-id") &&
    occurrenceKey(event.recurrenceId) === occurrenceKey(occurrence)
  ) {
    return { ...details, startDate: event.startDate, endDate: eventEnd(event, event.startDate) };
  }
  let startDate = details.startDate;
  if (event.modifiesFuture()) {
    // Range moves follow the master's clock even if the override uses another zone.
    const zone = master.startDate.zone;
    const original = zonedClock(event.recurrenceId, zone);
    const moved = zonedClock(event.startDate, zone);
    startDate = zonedClock(occurrence, zone);
    startDate.addDuration(moved.subtractDate(original));
  }
  return { ...details, startDate, endDate: eventEnd(event, startDate) };
}

export function eventEnd(event: ICAL.Event, start: ICAL.Time): ICAL.Time {
  if (
    event.component.hasProperty("dtend") &&
    occurrenceKey(start) === occurrenceKey(event.startDate)
  ) {
    return event.endDate;
  }
  const duration = event.duration;
  let end = start.clone();
  if (start.isDate) {
    end.addDuration(duration);
    return end;
  }
  let seconds = duration.toSeconds();
  if (event.component.hasProperty("duration")) {
    const calendarDuration = new ICAL.Duration({
      weeks: duration.weeks,
      days: duration.days,
      isNegative: duration.isNegative,
    });
    end = zonedClock(end, event.startDate.zone);
    end.addDuration(calendarDuration);
    seconds -= calendarDuration.toSeconds();
  }
  // Local times cannot identify which instance of an autumn repeated hour was calculated.
  return ICAL.Time.fromJSDate(new Date((end.toUnixTime() + seconds) * 1000), true);
}

export function zonedClock(value: ICAL.Time, zone: ICAL.Timezone): ICAL.Time {
  if (value.isDate || value.zone.tzid === zone.tzid) {
    return value.clone();
  }
  const seconds = value.toUnixTime();
  const utc = ICAL.Time.fromJSDate(new Date(seconds * 1000), true);
  // Expand VTIMEZONE, then select its offset by UTC transition instant rather than local clock.
  zone.utcOffset(utc);
  let offset = zone.changes[0]?.prevUtcOffset ?? 0;
  for (const change of zone.changes) {
    const transition =
      Date.UTC(
        change.year,
        change.month - 1,
        change.day,
        change.hour,
        change.minute,
        change.second,
      ) / 1000;
    if (transition > seconds) {
      break;
    }
    offset = change.utcOffset;
  }
  utc.adjust(0, 0, 0, offset);
  utc.zone = zone;
  return utc;
}

export function latestClockInstant(value: ICAL.Time): number {
  const clock =
    Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second) / 1000;
  value.zone.utcOffset(value);
  for (const change of value.zone.changes) {
    const transition =
      Date.UTC(
        change.year,
        change.month - 1,
        change.day,
        change.hour,
        change.minute,
        change.second,
      ) / 1000;
    const before = transition + change.prevUtcOffset;
    const after = transition + change.utcOffset;
    if (clock >= Math.min(before, after) && clock < Math.max(before, after)) {
      // Both gap and fold cutoffs need the later bound to avoid omitting occurrences.
      return (clock - Math.min(change.prevUtcOffset, change.utcOffset)) * 1000;
    }
  }
  return value.toUnixTime() * 1000;
}

export function timezoneComponent(calendar: ICAL.Component, timezone: string): ICAL.Timezone {
  if (timezone === "UTC" || timezone === "Etc/UTC" || timezone === "Z") {
    return ICAL.Timezone.utcTimezone;
  }
  const existing = calendar.getTimeZoneByID(timezone);
  if (existing) {
    return existing;
  }
  const block = tzlib_get_ical_block(timezone);
  if (!Array.isArray(block) || block[0] === undefined) {
    throw new Error(`Unsupported iCalendar timezone: ${timezone}`);
  }
  const component = new ICAL.Component(ICAL.parse(block[0]));
  // The library answers aliases with the link target's block; keep the requested identifier.
  component.updatePropertyWithValue("tzid", timezone);
  calendar.addSubcomponent(component);
  return calendar.getTimeZoneByID(timezone);
}

export function calendarTime(calendar: ICAL.Component, value: TEventDateTime): ICAL.Time {
  if (value.date !== undefined) {
    return ICAL.Time.fromDateString(value.date);
  }
  if (value.dateTime === undefined) {
    throw new Error("Calendar time requires a date or date-time");
  }
  const zone = timezoneComponent(calendar, value.timeZone ?? "UTC");
  const instant = ICAL.Time.fromJSDate(new Date(value.dateTime), true);
  const converted = zonedClock(instant, zone);
  if (converted.toUnixTime() !== instant.toUnixTime()) {
    throw new Error(
      `iCloud cannot preserve this start in ${zone.tzid} during the repeated DST hour; use UTC timezone`,
    );
  }
  return converted;
}

export function eventTime(value: ICAL.Time, calendarTimezone?: string): TEventDateTime {
  if (value.isDate) {
    return { date: value.toString(), dateTime: undefined, timeZone: calendarTimezone };
  }
  if (value.zone === ICAL.Timezone.localTimezone) {
    throw new Error("iCloud event has a floating time without a calendar timezone");
  }
  return { date: undefined, dateTime: value.toJSDate().toISOString(), timeZone: value.zone.tzid };
}

export function text(component: ICAL.Component, name: string): TOption<string> {
  const value = component.getFirstPropertyValue(name);
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

export function recurrence(event: ICAL.Event): string[] {
  return event.component
    .getAllProperties()
    .filter((property) => RECURRENCE_PROPERTIES.includes(property.name))
    .map((property) => property.toICALString());
}

export function replaceRecurrence(event: ICAL.Event, lines: string[]): void {
  for (const name of RECURRENCE_PROPERTIES) {
    event.component.removeAllProperties(name);
  }
  for (const line of lines) {
    const property = ICAL.Property.fromString(line);
    if (!RECURRENCE_PROPERTIES.includes(property.name)) {
      throw new Error("Recurrence lines must use RRULE, RDATE, or EXDATE");
    }
    event.component.addProperty(property);
  }
}

export function stamp(event: ICAL.Event): void {
  const sequence = Number(
    text(event.component, "sequence") ?? event.component.getFirstPropertyValue("sequence") ?? 0,
  );
  event.component.updatePropertyWithValue("sequence", sequence + 1);
  const now = ICAL.Time.fromJSDate(new Date(), true);
  event.component.updatePropertyWithValue("dtstamp", now);
  event.component.updatePropertyWithValue("last-modified", now);
}
