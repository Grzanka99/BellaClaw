import type { TOption } from "@bellaclaw/shared";
import ICAL from "ical.js";
import { z } from "zod";
import type { TCalendarEvent, TEventDateTime, TUpdateEventPatch } from "./types";

function nextDate(date: string): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid all-day date: ${date}`);
  }
  return new Date(timestamp + 86_400_000).toISOString().slice(0, 10);
}

export function normalizeEventTimes(
  start: string,
  end: TOption<string>,
  durationMinutes: TOption<number>,
  timezone: string,
): { start: TEventDateTime; end: TEventDateTime } {
  if (isCalendarDate(start)) {
    if (end !== undefined && !isCalendarDate(end)) {
      throw new Error("All-day event end must also be a date");
    }
    if (durationMinutes !== undefined) {
      throw new Error("All-day events do not accept durationMinutes");
    }
    return {
      start: { date: start, dateTime: undefined, timeZone: undefined },
      end: { date: end ?? nextDate(start), dateTime: undefined, timeZone: undefined },
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
    start: { date: undefined, dateTime: start, timeZone: timezone },
    end: { date: undefined, dateTime: endValue, timeZone: timezone },
  };
}

export function patchEvent(currentEvent: TCalendarEvent, patch: TUpdateEventPatch): TCalendarEvent {
  const body = { ...currentEvent };
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
      const patchIsAllDay = isCalendarDate(patch.start);
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
  return body;
}

const SCalendarDate = z.iso.date();

export function isCalendarDate(value: string): boolean {
  const result = SCalendarDate.safeParse(value);
  return result.success;
}

export function validateRecurrence(lines: string[]): void {
  for (const line of lines) {
    try {
      const property = ICAL.Property.fromString(line);
      if (
        !["rrule", "rdate", "exdate"].includes(property.name) ||
        property.getValues().length === 0
      ) {
        throw new Error("Unsupported recurrence property");
      }
    } catch {
      throw new Error("Recurrence lines must use valid RRULE, RDATE, or EXDATE syntax");
    }
  }
}

function localMidnight(date: string, timezone: string): number {
  const target = Date.parse(`${date}T00:00:00Z`);
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(candidate));
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const represented = Date.parse(
      `${values.get("year")}-${values.get("month")}-${values.get("day")}T${values.get("hour")}:${values.get("minute")}:${values.get("second")}Z`,
    );
    candidate += target - represented;
  }
  return candidate;
}

export function calendarBoundary(
  value: { date: TOption<string>; dateTime: TOption<string> },
  timezone: string,
): number {
  if (value.dateTime !== undefined) {
    return Date.parse(value.dateTime);
  }
  if (value.date !== undefined) {
    return localMidnight(value.date, timezone);
  }
  return Number.NaN;
}
