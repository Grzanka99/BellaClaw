import type { TBehaviorLogEvent, TBehaviorMetadata } from "./types";

export const SEARCHABLE_METADATA_KEYS = new Set([
  "author",
  "component",
  "cronPattern",
  "event",
  "handler",
  "importance",
  "intent",
  "mediaKind",
  "messageType",
  "model",
  "operation",
  "platform",
  "provider",
  "purpose",
  "settingKeys",
  "status",
  "stopReason",
  "toolName",
  "timezone",
]);

export function buildSearchableText(event: TBehaviorLogEvent): string {
  const parts: string[] = [
    event.event,
    event.component ?? "",
    event.provider ?? "",
    event.model ?? "",
    event.purpose ?? "",
    event.toolName ?? "",
  ];

  collectSearchableMetadata(event.metadata, parts);

  return parts
    .filter((part) => part.trim().length > 0)
    .join(" ")
    .trim();
}

function collectSearchableMetadata(metadata: TBehaviorMetadata, parts: string[]) {
  for (const [key, value] of Object.entries(metadata)) {
    if (!SEARCHABLE_METADATA_KEYS.has(key)) {
      continue;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value));
      continue;
    }

    if (Array.isArray(value)) {
      collectSearchableArray(value, parts);
    }
  }
}

function collectSearchableArray(values: TBehaviorMetadata[string][], parts: string[]) {
  for (const value of values) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value));
    }
  }
}
