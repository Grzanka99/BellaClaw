import type { TOption } from "../../types";
import type { TAvailabilityResult, TBusyInterval, TCalendarEvent, TCalendarFailure } from "./types";

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

function eventBoundary(
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

export function calculateAvailability(
  events: TCalendarEvent[],
  failures: TCalendarFailure[],
  timeMin: string,
  timeMax: string,
  timezone: string,
  durationMinutes?: number,
): TAvailabilityResult {
  const candidates = events
    .filter((event) => event.status !== "cancelled" && event.transparency !== "transparent")
    .map((event) => ({
      start: eventBoundary(event.start, timezone),
      end: eventBoundary(event.end, timezone),
      event,
    }))
    .filter(
      (interval) =>
        !Number.isNaN(interval.start) &&
        !Number.isNaN(interval.end) &&
        interval.end > interval.start,
    )
    .sort((left, right) => left.start - right.start);

  const busy: TBusyInterval[] = [];
  for (const candidate of candidates) {
    const previous = busy.at(-1);
    if (previous !== undefined && candidate.start <= Date.parse(previous.end)) {
      if (candidate.end > Date.parse(previous.end)) {
        previous.end = new Date(candidate.end).toISOString();
      }
      previous.events.push(candidate.event);
      continue;
    }
    busy.push({
      start: new Date(candidate.start).toISOString(),
      end: new Date(candidate.end).toISOString(),
      events: [candidate.event],
    });
  }

  const free: Array<{ start: string; end: string }> = [];
  if (durationMinutes !== undefined && failures.length === 0) {
    const rangeStart = Date.parse(timeMin);
    const rangeEnd = Date.parse(timeMax);
    let cursor = rangeStart;
    for (const interval of busy) {
      const start = Math.max(Date.parse(interval.start), rangeStart);
      if (start - cursor >= durationMinutes * 60_000) {
        free.push({ start: new Date(cursor).toISOString(), end: new Date(start).toISOString() });
      }
      cursor = Math.max(cursor, Date.parse(interval.end));
    }
    if (rangeEnd - cursor >= durationMinutes * 60_000) {
      free.push({ start: new Date(cursor).toISOString(), end: new Date(rangeEnd).toISOString() });
    }
  }

  return { busy, free, failures };
}
