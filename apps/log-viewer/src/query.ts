import type { TBehaviorLogSearchQuery } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { SLogSearchQuery } from "./types";

export function parseLogSearchQuery(raw: Record<string, string>): TBehaviorLogSearchQuery {
  const parsed = SLogSearchQuery.safeParse(raw);

  if (!parsed.success) {
    return createDefaultQuery();
  }

  let range: TBehaviorLogSearchQuery["range"] = "24h";
  let level: TBehaviorLogSearchQuery["level"];
  let success: TBehaviorLogSearchQuery["success"];
  let until = Date.now();
  let live = false;

  if (parsed.data.range !== undefined) {
    range = parsed.data.range;
  }

  if (parsed.data.level !== undefined && parsed.data.level !== "") {
    level = parsed.data.level;
  }

  if (parsed.data.success !== undefined && parsed.data.success !== "") {
    success = parsed.data.success;
  }

  if (parsed.data.until !== undefined) {
    until = parsed.data.until;
  }

  if (parsed.data.live === "1") {
    live = true;
  }

  return {
    q: normalizeValue(parsed.data.q),
    range,
    level,
    success,
    event: normalizeValue(parsed.data.event),
    component: normalizeValue(parsed.data.component),
    toolName: normalizeValue(parsed.data.toolName),
    turnId: normalizeValue(parsed.data.turnId),
    until,
    beforeCreatedAt: parsed.data.beforeCreatedAt,
    beforeId: parsed.data.beforeId,
    live,
  };
}

function createDefaultQuery(): TBehaviorLogSearchQuery {
  return {
    q: undefined,
    range: "24h",
    level: undefined,
    success: undefined,
    event: undefined,
    component: undefined,
    toolName: undefined,
    turnId: undefined,
    until: Date.now(),
    beforeCreatedAt: undefined,
    beforeId: undefined,
    live: false,
  };
}

function normalizeValue(value: TOption<string>): TOption<string> {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();

  if (normalized.length === 0) {
    return undefined;
  }

  return normalized;
}
