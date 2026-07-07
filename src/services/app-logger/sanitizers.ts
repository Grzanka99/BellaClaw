import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import type { TOption } from "../../types";
import type { TNormalizedToolResult } from "../ai/runtime";
import type { TBehaviorMetadata } from "./types";

type TSanitizedLogDetails = {
  summary: string;
  metadata: TBehaviorMetadata;
};

const ERROR_MAX_CHARS = 300;
const CRON_TOOL_NAMES = new Set([
  "list-cron-jobs",
  "schedule-once",
  "schedule-recurring",
  "unschedule-cron-job",
  "update-cron-job",
]);

export function sanitizeErrorMessage(error: TOption<string>): TOption<string> {
  if (error === undefined) {
    return undefined;
  }

  const normalized = error.replace(/\s+/g, " ").trim();

  if (normalized.length <= ERROR_MAX_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, ERROR_MAX_CHARS)}...`;
}

export function sanitizeToolCallArguments(toolCall: ChatMessageToolCall): TSanitizedLogDetails {
  const toolName = toolCall.function.name;
  const args = parseToolArguments(toolCall.function.arguments);

  if (!isRecord(args)) {
    return {
      summary: `${toolName} args invalidJson argumentsChars=${toolCall.function.arguments.length}`,
      metadata: {
        argumentsValid: false,
        argumentsChars: toolCall.function.arguments.length,
      },
    };
  }

  if (CRON_TOOL_NAMES.has(toolName)) {
    return sanitizeCronToolArguments(toolName, args);
  }

  switch (toolName) {
    case "search-memory": {
      return sanitizeSearchMemoryArguments(args);
    }
    case "web-search": {
      return sanitizeWebSearchArguments(args);
    }
    case "web-fetch": {
      return sanitizeWebFetchArguments(args);
    }
    case "define-message-importance": {
      return sanitizeDefineMessageImportanceArguments(args);
    }
    case "define-settings-intent": {
      return sanitizeDefineSettingsIntentArguments(args);
    }
    case "get-settings": {
      return { summary: "get-settings args", metadata: { argumentsValid: true } };
    }
    case "update-settings": {
      return sanitizeUpdateSettingsArguments(args);
    }
    default: {
      return {
        summary: `${toolName} args keys=${Object.keys(args).join(",")}`,
        metadata: {
          argumentsValid: true,
          argumentKeys: Object.keys(args),
        },
      };
    }
  }
}

export function sanitizeToolResult(result: TNormalizedToolResult): TSanitizedLogDetails {
  if (!result.success) {
    return {
      summary: `${result.toolName} failed`,
      metadata: {
        status: "failed",
      },
    };
  }

  const data = result.data;

  if (CRON_TOOL_NAMES.has(result.toolName)) {
    return sanitizeCronToolResult(result.toolName, data);
  }

  switch (result.toolName) {
    case "search-memory": {
      return sanitizeSearchMemoryResult(data);
    }
    case "web-search": {
      return sanitizeWebSearchResult(data);
    }
    case "web-fetch": {
      return sanitizeWebFetchResult(data);
    }
    case "define-message-importance": {
      return sanitizeDefineMessageImportanceResult(data);
    }
    case "define-settings-intent": {
      return sanitizeDefineSettingsIntentResult(data);
    }
    case "get-settings": {
      return sanitizeSettingsResult("get-settings", data);
    }
    case "update-settings": {
      return sanitizeSettingsResult("update-settings", data);
    }
    default: {
      return sanitizeGenericToolResult(result.toolName, data);
    }
  }
}

export function sanitizeToolResultError(result: TNormalizedToolResult): TOption<string> {
  if (result.error === undefined) {
    return undefined;
  }

  if (CRON_TOOL_NAMES.has(result.toolName)) {
    return `${result.toolName} failed`;
  }

  return sanitizeErrorMessage(result.error);
}

function parseToolArguments(argumentsText: string): unknown {
  try {
    return JSON.parse(argumentsText);
  } catch {
    return undefined;
  }
}

function sanitizeCronToolArguments(
  toolName: string,
  args: Record<string, unknown>,
): TSanitizedLogDetails {
  const metadata: TBehaviorMetadata = {
    argumentsValid: true,
  };
  const parts = [`${toolName} args`];
  const name = readString(args, "name");
  const pattern = readString(args, "pattern");
  const fireAt = readString(args, "fireAt");
  const group = readString(args, "group");
  const overwrite = readBoolean(args, "overwrite");
  const reminderText = readString(args, "reminderText");
  const reminderPromptData = readString(args, "reminderPromptData");
  const reminderFallbackText = readString(args, "reminderFallbackText");

  if (name !== undefined) {
    metadata.jobNameChars = name.length;
    parts.push(`nameChars=${name.length}`);
  }

  if (pattern !== undefined) {
    metadata.cronPattern = pattern;
    parts.push(`pattern=${pattern}`);
  }

  if (fireAt !== undefined) {
    metadata.fireAt = fireAt;
    parts.push(`fireAt=${fireAt}`);
  }

  if (group !== undefined) {
    metadata.group = group;
  }

  if (overwrite !== undefined) {
    metadata.overwrite = overwrite;
  }

  addLength(metadata, "reminderTextChars", reminderText);
  addLength(metadata, "reminderPromptDataChars", reminderPromptData);
  addLength(metadata, "reminderFallbackTextChars", reminderFallbackText);

  return { summary: parts.join(" "), metadata };
}

function sanitizeSearchMemoryArguments(args: Record<string, unknown>): TSanitizedLogDetails {
  const searchString = readString(args, "searchString");
  const importance = readStringArray(args, "importance");
  const limit = readNumber(args, "limit");
  const metadata: TBehaviorMetadata = {
    argumentsValid: true,
  };

  addLength(metadata, "searchStringChars", searchString);

  if (importance.length > 0) {
    metadata.importance = importance;
  }

  if (limit !== undefined) {
    metadata.limit = limit;
  }

  return {
    summary: `search-memory args searchChars=${searchString?.length ?? 0}`,
    metadata,
  };
}

function sanitizeWebSearchArguments(args: Record<string, unknown>): TSanitizedLogDetails {
  const query = readString(args, "query");
  const maxResults = readNumber(args, "maxResults");
  const topic = readString(args, "topic");
  const timeRange = readString(args, "timeRange");
  const metadata: TBehaviorMetadata = {
    argumentsValid: true,
  };

  addLength(metadata, "queryChars", query);

  if (maxResults !== undefined) {
    metadata.maxResults = maxResults;
  }

  if (topic !== undefined) {
    metadata.topic = topic;
  }

  if (timeRange !== undefined) {
    metadata.timeRange = timeRange;
  }

  return {
    summary: `web-search args queryChars=${query?.length ?? 0}`,
    metadata,
  };
}

function sanitizeWebFetchArguments(args: Record<string, unknown>): TSanitizedLogDetails {
  const url = readString(args, "url");
  const format = readString(args, "format");
  const timeout = readNumber(args, "timeout");
  const metadata: TBehaviorMetadata = {
    argumentsValid: true,
  };
  const host = extractUrlHost(url);

  if (host !== undefined) {
    metadata.urlHost = host;
  }

  if (format !== undefined) {
    metadata.format = format;
  }

  if (timeout !== undefined) {
    metadata.timeout = timeout;
  }

  return {
    summary: `web-fetch args host=${host ?? "unknown"}`,
    metadata,
  };
}

function sanitizeDefineMessageImportanceArguments(
  args: Record<string, unknown>,
): TSanitizedLogDetails {
  const importance = readString(args, "importance");
  const reasoning = readString(args, "reasoning");
  const metadata: TBehaviorMetadata = {
    argumentsValid: true,
  };

  if (importance !== undefined) {
    metadata.importance = importance;
  }

  addLength(metadata, "reasoningChars", reasoning);

  return {
    summary: `define-message-importance args importance=${importance ?? "unknown"}`,
    metadata,
  };
}

function sanitizeDefineSettingsIntentArguments(
  args: Record<string, unknown>,
): TSanitizedLogDetails {
  const intent = readString(args, "intent");
  const reason = readString(args, "reason");
  const metadata: TBehaviorMetadata = {
    argumentsValid: true,
  };

  if (intent !== undefined) {
    metadata.intent = intent;
  }

  addLength(metadata, "reasonChars", reason);

  return {
    summary: `define-settings-intent args intent=${intent ?? "unknown"}`,
    metadata,
  };
}

function sanitizeUpdateSettingsArguments(args: Record<string, unknown>): TSanitizedLogDetails {
  const settingKeys = Object.keys(args);
  const metadata: TBehaviorMetadata = {
    argumentsValid: true,
    settingKeys,
  };

  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      metadata[`${key}Chars`] = value.length;
    }
  }

  return {
    summary: `update-settings args keys=${settingKeys.join(",")}`,
    metadata,
  };
}

function sanitizeCronToolResult(toolName: string, data: unknown): TSanitizedLogDetails {
  if (Array.isArray(data)) {
    const jobNameChars: number[] = [];

    for (const item of data) {
      if (!isRecord(item)) {
        continue;
      }

      const name = readString(item, "name");

      if (name !== undefined) {
        jobNameChars.push(name.length);
      }
    }

    return {
      summary: `${toolName} listed ${data.length} jobs`,
      metadata: {
        status: "completed",
        cronJobCount: data.length,
        jobNameChars,
      },
    };
  }

  if (!isRecord(data)) {
    return sanitizeGenericToolResult(toolName, data);
  }

  const metadata = buildCronJobMetadata(data);
  const name = readString(data, "name");
  const type = readString(data, "type");
  const pattern = readString(data, "pattern");
  const nextRunAt = readDateLike(data, "nextRunAt");
  const parts = [`${toolName} completed`];

  if (name !== undefined) {
    parts.push(`jobNameChars=${name.length}`);
  }

  if (type !== undefined) {
    parts.push(`type=${type}`);
  }

  if (pattern !== undefined) {
    parts.push(`pattern=${pattern}`);
  }

  if (nextRunAt !== undefined) {
    parts.push(`next=${nextRunAt}`);
  }

  return { summary: parts.join(" "), metadata };
}

function buildCronJobMetadata(job: Record<string, unknown>): TBehaviorMetadata {
  const metadata: TBehaviorMetadata = {
    status: "completed",
  };
  const name = readString(job, "name");
  const type = readString(job, "type");
  const pattern = readString(job, "pattern");
  const nextRunAt = readDateLike(job, "nextRunAt");
  const timezone = readString(job, "timezone");
  const status = readString(job, "status");
  const reminderText = readString(job, "reminderText");
  const reminderPromptData = readString(job, "reminderPromptData");
  const reminderFallbackText = readString(job, "reminderFallbackText");

  if (name !== undefined) {
    metadata.jobNameChars = name.length;
  }

  if (type !== undefined) {
    metadata.cronJobType = type;
  }

  if (pattern !== undefined) {
    metadata.cronPattern = pattern;
  }

  if (nextRunAt !== undefined) {
    metadata.nextRunAt = nextRunAt;
  }

  if (timezone !== undefined) {
    metadata.timezone = timezone;
  }

  if (status !== undefined) {
    metadata.status = status;
  }

  addLength(metadata, "reminderTextChars", reminderText);
  addLength(metadata, "reminderPromptDataChars", reminderPromptData);
  addLength(metadata, "reminderFallbackTextChars", reminderFallbackText);

  return metadata;
}

function sanitizeSearchMemoryResult(data: unknown): TSanitizedLogDetails {
  let resultCount = 0;

  if (isRecord(data)) {
    const memories = data.memories;

    if (Array.isArray(memories)) {
      resultCount = memories.length;
    }
  }

  return {
    summary: `search-memory returned ${resultCount} memories`,
    metadata: {
      status: "completed",
      resultCount,
    },
  };
}

function sanitizeWebSearchResult(data: unknown): TSanitizedLogDetails {
  const hosts: string[] = [];
  let resultCount = 0;
  let queryChars = 0;

  if (isRecord(data)) {
    const query = readString(data, "query");

    if (query !== undefined) {
      queryChars = query.length;
    }

    const results = data.results;

    if (Array.isArray(results)) {
      resultCount = results.length;

      for (const result of results) {
        if (!isRecord(result)) {
          continue;
        }

        const host = extractUrlHost(readString(result, "url"));

        if (host !== undefined) {
          hosts.push(host);
        }
      }
    }
  }

  return {
    summary: `web-search returned ${resultCount} results`,
    metadata: {
      status: "completed",
      queryChars,
      resultCount,
      resultHosts: hosts,
    },
  };
}

function sanitizeWebFetchResult(data: unknown): TSanitizedLogDetails {
  if (!isRecord(data)) {
    return sanitizeGenericToolResult("web-fetch", data);
  }

  const url = readString(data, "url");
  const host = extractUrlHost(url);
  const contentType = readString(data, "contentType");
  const format = readString(data, "format");
  const content = readString(data, "content");
  const truncated = readBoolean(data, "truncated");
  const metadata: TBehaviorMetadata = {
    status: "completed",
  };

  if (host !== undefined) {
    metadata.urlHost = host;
  }

  if (contentType !== undefined) {
    metadata.contentType = contentType;
  }

  if (format !== undefined) {
    metadata.format = format;
  }

  if (truncated !== undefined) {
    metadata.truncated = truncated;
  }

  addLength(metadata, "contentChars", content);

  return {
    summary: `web-fetch completed host=${host ?? "unknown"}`,
    metadata,
  };
}

function sanitizeDefineMessageImportanceResult(data: unknown): TSanitizedLogDetails {
  const metadata: TBehaviorMetadata = {
    status: "completed",
  };
  let importance = "unknown";

  if (isRecord(data)) {
    const parsedImportance = readString(data, "importance");
    const reasoning = readString(data, "reasoning");

    if (parsedImportance !== undefined) {
      importance = parsedImportance;
      metadata.importance = parsedImportance;
    }

    addLength(metadata, "reasoningChars", reasoning);
  }

  return {
    summary: `define-message-importance completed importance=${importance}`,
    metadata,
  };
}

function sanitizeDefineSettingsIntentResult(data: unknown): TSanitizedLogDetails {
  const metadata: TBehaviorMetadata = {
    status: "completed",
  };
  let intent = "unknown";

  if (isRecord(data)) {
    const parsedIntent = readString(data, "intent");
    const reason = readString(data, "reason");

    if (parsedIntent !== undefined) {
      intent = parsedIntent;
      metadata.intent = parsedIntent;
    }

    addLength(metadata, "reasonChars", reason);
  }

  return {
    summary: `define-settings-intent completed intent=${intent}`,
    metadata,
  };
}

function sanitizeSettingsResult(toolName: string, data: unknown): TSanitizedLogDetails {
  let settingKeys: string[] = [];

  if (isRecord(data) && isRecord(data.settings)) {
    settingKeys = Object.keys(data.settings);
  }

  return {
    summary: `${toolName} returned ${settingKeys.length} settings`,
    metadata: {
      status: "completed",
      settingKeys,
      settingCount: settingKeys.length,
    },
  };
}

function sanitizeGenericToolResult(toolName: string, data: unknown): TSanitizedLogDetails {
  const metadata: TBehaviorMetadata = {
    status: "completed",
    dataKind: describeDataKind(data),
  };

  if (isRecord(data)) {
    metadata.dataKeys = Object.keys(data);
  }

  if (Array.isArray(data)) {
    metadata.resultCount = data.length;
  }

  return {
    summary: `${toolName} completed dataKind=${describeDataKind(data)}`,
    metadata,
  };
}

function readString(record: Record<string, unknown>, key: string): TOption<string> {
  const value = record[key];

  if (typeof value === "string") {
    return value;
  }

  return undefined;
}

function readNumber(record: Record<string, unknown>, key: string): TOption<number> {
  const value = record[key];

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): TOption<boolean> {
  const value = record[key];

  if (typeof value === "boolean") {
    return value;
  }

  return undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  const strings: string[] = [];

  if (!Array.isArray(value)) {
    return strings;
  }

  for (const item of value) {
    if (typeof item === "string") {
      strings.push(item);
    }
  }

  return strings;
}

function readDateLike(record: Record<string, unknown>, key: string): TOption<string> {
  const value = record[key];

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    return value;
  }

  return undefined;
}

function addLength(metadata: TBehaviorMetadata, key: string, value: TOption<string>) {
  if (value === undefined) {
    return;
  }

  metadata[key] = value.length;
}

function extractUrlHost(value: TOption<string>): TOption<string> {
  if (value === undefined) {
    return undefined;
  }

  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeDataKind(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }

  if (value === null) {
    return "null";
  }

  return typeof value;
}
