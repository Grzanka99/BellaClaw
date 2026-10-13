import { calendarBoundary } from "./event-fields";
import type { TAvailabilityResult, TBusyInterval, TCalendarEvent, TCalendarFailure } from "./types";

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
      start: calendarBoundary(event.start, event.start.timeZone ?? timezone),
      end: calendarBoundary(event.end, event.end.timeZone ?? timezone),
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
