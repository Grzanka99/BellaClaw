import type { TOption } from "@bellaclaw/shared";
import { ToolError } from "./define-tool";

type TCronContentFields = {
  group?: string;
  reminderText?: string;
  reminderPromptData?: string;
  reminderFallbackText?: string;
  taskPrompt?: string;
  taskFallbackText?: string;
};

export function absentIfBlank(value?: string): TOption<string> {
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
    throw new ToolError(
      "invalid-fallback-pairing",
      "reminderFallbackText is required when reminderPromptData is set",
    );
  }

  if (
    args.reminderFallbackText !== undefined &&
    args.reminderText === undefined &&
    args.reminderPromptData === undefined
  ) {
    throw new ToolError(
      "invalid-fallback-pairing",
      "reminderFallbackText requires reminderText or reminderPromptData",
    );
  }

  if (args.taskPrompt !== undefined && args.taskFallbackText === undefined) {
    throw new ToolError(
      "invalid-fallback-pairing",
      "taskFallbackText is required when taskPrompt is set",
    );
  }

  if (args.taskFallbackText !== undefined && args.taskPrompt === undefined) {
    throw new ToolError("invalid-fallback-pairing", "taskFallbackText requires taskPrompt");
  }
}

export const LOCAL_FIRE_AT_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2})?$";

function formatLocalDateTime(timestamp: number, timezone: string): string {
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

  return `${values.get("year")}-${values.get("month")}-${values.get("day")}T${values.get("hour")}:${values.get("minute")}:${values.get("second")}`;
}

function getTimezoneOffsetMs(timestamp: number, timezone: string): number {
  return Date.parse(`${formatLocalDateTime(timestamp, timezone)}Z`) - timestamp;
}

/**
 * Models get the UTC offset wrong around DST changes, so fireAt is local wall
 * time and the offset valid at that moment is resolved here.
 */
export function parseLocalFireAt(fireAt: string, timezone: string): Date {
  if (!new RegExp(LOCAL_FIRE_AT_PATTERN).test(fireAt)) {
    throw new ToolError(
      "invalid-fire-at",
      "fireAt must be local time, YYYY-MM-DDTHH:mm[:ss], with no Z or offset",
    );
  }

  const wallTime = Date.parse(`${fireAt}Z`);

  if (Number.isNaN(wallTime)) {
    throw new ToolError("invalid-fire-at", `Invalid fireAt: ${fireAt}`);
  }

  const firstOffset = getTimezoneOffsetMs(wallTime, timezone);
  const secondOffset = getTimezoneOffsetMs(wallTime - firstOffset, timezone);
  const resolved = wallTime - secondOffset;

  // Rejects normalized calendar dates (April 31) and times skipped by a DST change.
  if (!formatLocalDateTime(resolved, timezone).startsWith(fireAt)) {
    throw new ToolError("nonexistent-fire-at", `fireAt ${fireAt} does not exist in ${timezone}`);
  }

  return new Date(resolved);
}
