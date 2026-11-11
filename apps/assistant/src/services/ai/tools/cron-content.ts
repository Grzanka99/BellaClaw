import type { TOption } from "@bellaclaw/shared";
import { CronSchedulerError, type TCronJob, type TJobContent } from "../../cron/types";
import { ToolError } from "./define-tool";

type TCronContentFields = {
  reminderText?: string;
  reminderPromptData?: string;
  reminderFallbackText?: string;
  taskPrompt?: string;
  taskFallbackText?: string;
  automations?: string[];
};

export function absentIfBlank(value?: string): TOption<string> {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return value;
}

/**
 * Trims names and drops blanks and duplicates. An omitted list stays omitted
 * because an explicit empty list means "no automations" on updates.
 */
export function parseAutomationNames(names?: string[]): TOption<string[]> {
  if (names === undefined) {
    return undefined;
  }

  const parsed = new Set<string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed.length > 0) {
      parsed.add(trimmed);
    }
  }

  return [...parsed];
}

/**
 * Converts the model-facing content fields to job content.
 * Models routinely send "" or whitespace for optional content fields they mean
 * to omit, so blank values are treated as absent. A new job (`required`) with
 * automations and no content mode only sends the automations' text outputs.
 * Returns undefined when no content mode is given and `required` is false.
 */
export function parseCronContent(args: TCronContentFields, required: true): TJobContent;
export function parseCronContent(args: TCronContentFields, required: false): TOption<TJobContent>;
export function parseCronContent(
  args: TCronContentFields,
  required: boolean,
): TOption<TJobContent> {
  const reminderText = absentIfBlank(args.reminderText);
  const reminderPromptData = absentIfBlank(args.reminderPromptData);
  const reminderFallbackText = absentIfBlank(args.reminderFallbackText);
  const taskPrompt = absentIfBlank(args.taskPrompt);
  const taskFallbackText = absentIfBlank(args.taskFallbackText);
  const automationCount = parseAutomationNames(args.automations)?.length ?? 0;
  const contentModeCount = [reminderText, reminderPromptData, taskPrompt].filter(
    (field) => field !== undefined,
  ).length;

  if (contentModeCount === 0 && automationCount === 0 && required) {
    throw new ToolError(
      "missing-content",
      "Provide reminderText, reminderPromptData, or taskPrompt, or attach automations",
    );
  }

  if (contentModeCount > 1) {
    throw new ToolError(
      "conflicting-content-modes",
      "Provide only one of reminderText, reminderPromptData, or taskPrompt",
    );
  }

  if (reminderPromptData !== undefined && reminderFallbackText === undefined) {
    throw new ToolError(
      "invalid-fallback-pairing",
      "reminderFallbackText is required when reminderPromptData is set",
    );
  }

  if (
    reminderFallbackText !== undefined &&
    reminderText === undefined &&
    reminderPromptData === undefined
  ) {
    throw new ToolError(
      "invalid-fallback-pairing",
      "reminderFallbackText requires reminderText or reminderPromptData",
    );
  }

  if (taskPrompt !== undefined && taskFallbackText === undefined) {
    throw new ToolError(
      "invalid-fallback-pairing",
      "taskFallbackText is required when taskPrompt is set",
    );
  }

  if (taskFallbackText !== undefined && taskPrompt === undefined) {
    throw new ToolError("invalid-fallback-pairing", "taskFallbackText requires taskPrompt");
  }

  if (automationCount > 0 && (reminderText !== undefined || reminderPromptData !== undefined)) {
    throw new ToolError(
      "automations-without-task",
      "automations can only be combined with taskPrompt, not with reminders",
    );
  }

  if (reminderText !== undefined) {
    return { kind: "text", text: reminderText };
  }

  if (reminderPromptData !== undefined && reminderFallbackText !== undefined) {
    return { kind: "generated", promptData: reminderPromptData, fallback: reminderFallbackText };
  }

  if (taskPrompt !== undefined && taskFallbackText !== undefined) {
    return { kind: "task", prompt: taskPrompt, fallback: taskFallbackText };
  }

  if (automationCount > 0 && required) {
    return { kind: "automations" };
  }

  return undefined;
}

/**
 * Runs a scheduler call and returns the job in the flat shape the model has
 * always seen; scheduler failures become tool errors with their stable code.
 */
export async function runCronJobOperation(operation: () => Promise<TCronJob>) {
  try {
    return toCronJobResult(await operation());
  } catch (error) {
    if (error instanceof CronSchedulerError) {
      throw new ToolError(error.code, `${error.operation} failed: ${error.message}`);
    }

    throw error;
  }
}

export function toCronJobResult(job: TCronJob) {
  let reminderText: TOption<string>;
  let reminderPromptData: TOption<string>;
  let reminderFallbackText: TOption<string>;
  let taskPrompt: TOption<string>;
  let taskFallbackText: TOption<string>;

  if (job.content.kind === "text") {
    reminderText = job.content.text;
    reminderFallbackText = job.content.text;
  } else if (job.content.kind === "generated") {
    reminderPromptData = job.content.promptData;
    reminderFallbackText = job.content.fallback;
  } else if (job.content.kind === "task") {
    taskPrompt = job.content.prompt;
    taskFallbackText = job.content.fallback;
  }

  return {
    id: job.id,
    name: job.name,
    scope: job.scope,
    type: job.type,
    pattern: job.pattern ?? undefined,
    nextRunAt: job.nextRunAt,
    lastRunAt: job.lastRunAt ?? undefined,
    createdAt: job.createdAt,
    status: job.status,
    finishedAt: job.finishedAt ?? undefined,
    finishedReason: job.finishedReason ?? undefined,
    timezone: job.timezone ?? undefined,
    reminderText,
    reminderPromptData,
    reminderFallbackText,
    taskPrompt,
    taskFallbackText,
  };
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
