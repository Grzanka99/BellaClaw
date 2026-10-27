import type { TOption } from "@bellaclaw/shared";

type TCronContentFields = {
  group?: string;
  reminderText?: string;
  reminderPromptData?: string;
  reminderFallbackText?: string;
  taskPrompt?: string;
  taskFallbackText?: string;
};

function absentIfBlank(value?: string): TOption<string> {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return value;
}

/**
 * Models routinely send "" or whitespace for optional content fields they mean
 * to omit. Blank values must be treated as absent so they neither trip the
 * one-content-mode checks nor overwrite stored job content.
 */
export function normalizeCronContentFields(args: TCronContentFields): TCronContentFields {
  return {
    group: absentIfBlank(args.group),
    reminderText: absentIfBlank(args.reminderText),
    reminderPromptData: absentIfBlank(args.reminderPromptData),
    reminderFallbackText: absentIfBlank(args.reminderFallbackText),
    taskPrompt: absentIfBlank(args.taskPrompt),
    taskFallbackText: absentIfBlank(args.taskFallbackText),
  };
}

export function countCronContentModes(args: TCronContentFields): number {
  return [args.reminderText, args.reminderPromptData, args.taskPrompt].filter(
    (field) => field !== undefined,
  ).length;
}

export function validateCronFallbackPairing(args: TCronContentFields): void {
  if (args.reminderPromptData !== undefined && args.reminderFallbackText === undefined) {
    throw new Error("reminderFallbackText is required when reminderPromptData is set");
  }

  if (
    args.reminderFallbackText !== undefined &&
    args.reminderText === undefined &&
    args.reminderPromptData === undefined
  ) {
    throw new Error("reminderFallbackText requires reminderText or reminderPromptData");
  }

  if (args.taskPrompt !== undefined && args.taskFallbackText === undefined) {
    throw new Error("taskFallbackText is required when taskPrompt is set");
  }

  if (args.taskFallbackText !== undefined && args.taskPrompt === undefined) {
    throw new Error("taskFallbackText requires taskPrompt");
  }
}

export const LOCAL_FIRE_AT_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2})?$";

function getTimezoneOffsetMs(timestamp: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const represented = Date.parse(
    `${values.get("year")}-${values.get("month")}-${values.get("day")}T${values.get("hour")}:${values.get("minute")}:${values.get("second")}Z`,
  );

  return represented - timestamp;
}

/**
 * Models get the UTC offset wrong around DST changes, so fireAt is local wall
 * time and the offset valid at that moment is resolved here.
 */
export function parseLocalFireAt(fireAt: string, timezone: string): Date {
  const wallTime = Date.parse(`${fireAt}Z`);

  if (Number.isNaN(wallTime)) {
    throw new Error(`Invalid fireAt: ${fireAt}`);
  }

  const firstOffset = getTimezoneOffsetMs(wallTime, timezone);
  const secondOffset = getTimezoneOffsetMs(wallTime - firstOffset, timezone);

  return new Date(wallTime - secondOffset);
}
