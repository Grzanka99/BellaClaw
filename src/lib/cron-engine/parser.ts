import type { TOption } from "../../types";

const MAX_ITERATIONS = 525_600 * 4;
const MINUTE_MS = 60_000;
const ZONED_INSTANT_SEARCH_MS = 36 * 60 * 60 * 1000;
const ZONED_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

type TCronFields = {
  minuteSet: Set<number>;
  hourSet: Set<number>;
  domSet: Set<number>;
  monthSet: Set<number>;
  dowSet: Set<number>;
  domIsWildcard: boolean;
  dowIsWildcard: boolean;
};

type TZonedDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function isValidCron(pattern: string): boolean {
  const parts = pattern.trim().split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }

  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];

  for (let i = 0; i < 5; i++) {
    const part = parts[i];
    if (part === undefined) {
      return false;
    }

    const range = ranges[i];
    if (!range) {
      return false;
    }

    const [min, max] = range;
    if (!validateField(part, min, max)) {
      return false;
    }
  }

  return true;
}

function validateField(field: string, min: number, max: number): boolean {
  const segments = field.split(",");

  for (const seg of segments) {
    if (seg === "") {
      return false;
    }

    if (seg === "*") {
      continue;
    }

    const stepMatch = seg.match(/^(.+?)\/(\d+)$/);
    if (stepMatch) {
      const [, base, stepStr] = stepMatch;
      const step = Number(stepStr);
      if (!step || step < 1) {
        return false;
      }

      if (base === "*") {
        continue;
      }

      if (!base || !validateRangeOrValue(base, min, max)) {
        return false;
      }

      continue;
    }

    if (!validateRangeOrValue(seg, min, max)) {
      return false;
    }
  }

  return true;
}

function validateRangeOrValue(segment: string, min: number, max: number): boolean {
  if (segment.includes("-")) {
    const [a, b] = segment.split("-");
    if (!a || !b) {
      return false;
    }

    const aNum = Number(a);
    const bNum = Number(b);
    if (
      Number.isNaN(aNum) ||
      Number.isNaN(bNum) ||
      !Number.isInteger(aNum) ||
      !Number.isInteger(bNum)
    ) {
      return false;
    }

    if (aNum < min || aNum > max || bNum < min || bNum > max) {
      return false;
    }

    if (aNum > bNum) {
      return false;
    }

    return true;
  }

  const n = Number(segment);
  if (Number.isNaN(n) || !Number.isInteger(n)) {
    return false;
  }

  return n >= min && n <= max;
}

export function getNextFireTime(
  pattern: string,
  from: Date,
  timeZone: TOption<string> = undefined,
): Date {
  const fields = parseCronFields(pattern);

  if (timeZone === undefined) {
    return getNextLocalFireTime(fields, from);
  }

  return getNextZonedFireTime(fields, from, timeZone);
}

function parseCronFields(pattern: string): TCronFields {
  const parts = pattern.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("Invalid cron pattern: expected 5 fields");
  }

  const minuteField = parts[0];
  const hourField = parts[1];
  const domField = parts[2];
  const monthField = parts[3];
  const dowField = parts[4];

  if (
    minuteField === undefined ||
    hourField === undefined ||
    domField === undefined ||
    monthField === undefined ||
    dowField === undefined
  ) {
    throw new Error("Invalid cron pattern: expected 5 fields");
  }

  return {
    minuteSet: parseField(minuteField, 0, 59),
    hourSet: parseField(hourField, 0, 23),
    domSet: parseField(domField, 1, 31),
    monthSet: parseField(monthField, 1, 12),
    dowSet: parseField(dowField, 0, 6),
    domIsWildcard: domField === "*",
    dowIsWildcard: dowField === "*",
  };
}

function getNextLocalFireTime(fields: TCronFields, from: Date): Date {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (!fields.monthSet.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }

    if (!doesDayMatch(fields, d.getDate(), d.getDay())) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }

    if (!fields.hourSet.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }

    if (!fields.minuteSet.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }

    return d;
  }

  throw new Error("Could not find next fire time within 4 years");
}

function getNextZonedFireTime(fields: TCronFields, from: Date, timeZone: string): Date {
  const d = createZonedWallDate(from, timeZone);
  d.setUTCSeconds(0, 0);
  // WARN: For now we ignore winter/summer time changes in this synthetic wall-time search.
  d.setUTCMinutes(d.getUTCMinutes() + 1);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (!fields.monthSet.has(d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }

    if (!doesDayMatch(fields, d.getUTCDate(), d.getUTCDay())) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }

    if (!fields.hourSet.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
      continue;
    }

    if (!fields.minuteSet.has(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
      continue;
    }

    const instant = findZonedInstantForWallDate(d, timeZone, from);
    if (instant !== undefined) {
      return instant;
    }

    d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
  }

  throw new Error("Could not find next fire time within 4 years");
}

function doesDayMatch(fields: TCronFields, dayOfMonth: number, dayOfWeek: number): boolean {
  const domMatch = fields.domSet.has(dayOfMonth);
  const dowMatch = fields.dowSet.has(dayOfWeek);

  if (fields.domIsWildcard && fields.dowIsWildcard) {
    return true;
  }

  if (fields.domIsWildcard) {
    return dowMatch;
  }

  if (fields.dowIsWildcard) {
    return domMatch;
  }

  return domMatch || dowMatch;
}

function createZonedWallDate(date: Date, timeZone: string): Date {
  const parts = getZonedDateTimeParts(date, timeZone);

  return new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      date.getMilliseconds(),
    ),
  );
}

function findZonedInstantForWallDate(wallDate: Date, timeZone: string, after: Date): TOption<Date> {
  const guess = getInitialZonedInstantGuess(wallDate, timeZone);
  const start = Math.floor((guess.getTime() - ZONED_INSTANT_SEARCH_MS) / MINUTE_MS) * MINUTE_MS;
  const end = guess.getTime() + ZONED_INSTANT_SEARCH_MS;
  const afterTime = after.getTime();

  for (let candidateMs = start; candidateMs <= end; candidateMs += MINUTE_MS) {
    if (candidateMs <= afterTime) {
      continue;
    }

    const candidate = new Date(candidateMs);
    const parts = getZonedDateTimeParts(candidate, timeZone);
    if (zonedPartsMatchWallDate(parts, wallDate)) {
      return candidate;
    }
  }

  return undefined;
}

function getInitialZonedInstantGuess(wallDate: Date, timeZone: string): Date {
  const wallTime = wallDate.getTime();
  const wallAsInstant = new Date(wallTime);
  const partsAtWallInstant = getZonedDateTimeParts(wallAsInstant, timeZone);
  const zonedWallTime = Date.UTC(
    partsAtWallInstant.year,
    partsAtWallInstant.month - 1,
    partsAtWallInstant.day,
    partsAtWallInstant.hour,
    partsAtWallInstant.minute,
    partsAtWallInstant.second,
    wallDate.getUTCMilliseconds(),
  );
  const offset = zonedWallTime - wallTime;

  return new Date(wallTime - offset);
}

function zonedPartsMatchWallDate(parts: TZonedDateTimeParts, wallDate: Date): boolean {
  return (
    parts.year === wallDate.getUTCFullYear() &&
    parts.month === wallDate.getUTCMonth() + 1 &&
    parts.day === wallDate.getUTCDate() &&
    parts.hour === wallDate.getUTCHours() &&
    parts.minute === wallDate.getUTCMinutes() &&
    parts.second === wallDate.getUTCSeconds()
  );
}

function getZonedDateTimeParts(date: Date, timeZone: string): TZonedDateTimeParts {
  let year: TOption<number>;
  let month: TOption<number>;
  let day: TOption<number>;
  let hour: TOption<number>;
  let minute: TOption<number>;
  let second: TOption<number>;

  for (const part of getZonedFormatter(timeZone).formatToParts(date)) {
    if (part.type === "year") {
      year = Number(part.value);
    } else if (part.type === "month") {
      month = Number(part.value);
    } else if (part.type === "day") {
      day = Number(part.value);
    } else if (part.type === "hour") {
      hour = Number(part.value);
    } else if (part.type === "minute") {
      minute = Number(part.value);
    } else if (part.type === "second") {
      second = Number(part.value);
    }
  }

  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    throw new Error(`Unable to resolve date parts for timezone: ${timeZone}`);
  }

  return { year, month, day, hour, minute, second };
}

function getZonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = ZONED_FORMATTERS.get(timeZone);
  if (existing !== undefined) {
    return existing;
  }

  const formatter = new Intl.DateTimeFormat("en-US-u-nu-latn", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  ZONED_FORMATTERS.set(timeZone, formatter);

  return formatter;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  const segments = field.split(",");

  for (const seg of segments) {
    if (seg === "*") {
      for (let i = min; i <= max; i++) {
        result.add(i);
      }

      continue;
    }

    const stepMatch = seg.match(/^(.+?)\/(\d+)$/);
    if (stepMatch) {
      const [, base, stepStr] = stepMatch;
      const step = Number(stepStr);
      let rangeMin = min;
      let rangeMax = max;

      if (base !== "*" && base) {
        if (base.includes("-")) {
          const [a, b] = base.split("-");
          rangeMin = Number(a);
          rangeMax = Number(b);
        } else {
          rangeMin = Number(base);
        }
      }

      for (let i = rangeMin; i <= rangeMax; i += step) {
        result.add(i);
      }

      continue;
    }

    if (seg.includes("-")) {
      const [a, b] = seg.split("-");
      const aNum = Number(a);
      const bNum = Number(b);

      for (let i = aNum; i <= bNum; i++) {
        result.add(i);
      }

      continue;
    }

    result.add(Number(seg));
  }

  return result;
}
