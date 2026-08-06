import { SLogSearchQuery, type TLogSearchQuery, type TOption } from "./types";

export function parseLogSearchQuery(raw: Record<string, string>): TLogSearchQuery {
  const parsed = SLogSearchQuery.safeParse(raw);

  if (!parsed.success) {
    return createDefaultQuery();
  }

  let range: TLogSearchQuery["range"] = "24h";
  let level: TLogSearchQuery["level"];
  let success: TLogSearchQuery["success"];
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

export function buildLogUrl(
  query: TLogSearchQuery,
  options: {
    includeUntil: boolean;
    includeCursor: boolean;
    live: boolean;
    path?: string;
    overrides?: Partial<TLogSearchQuery>;
  },
): string {
  const merged: TLogSearchQuery = { ...query, ...options.overrides };
  const params = new URLSearchParams();
  addValue(params, "q", merged.q);
  params.set("range", merged.range);
  addValue(params, "level", merged.level);
  addValue(params, "success", merged.success);
  addValue(params, "event", merged.event);
  addValue(params, "component", merged.component);
  addValue(params, "toolName", merged.toolName);
  addValue(params, "turnId", merged.turnId);

  if (options.includeUntil) {
    params.set("until", String(merged.until));
  }

  if (
    options.includeCursor &&
    merged.beforeCreatedAt !== undefined &&
    merged.beforeId !== undefined
  ) {
    params.set("beforeCreatedAt", String(merged.beforeCreatedAt));
    params.set("beforeId", String(merged.beforeId));
  }

  if (options.live) {
    params.set("live", "1");
  }

  let path = "/";

  if (options.path !== undefined) {
    path = options.path;
  }

  return `${path}?${params.toString()}`;
}

function createDefaultQuery(): TLogSearchQuery {
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

function addValue(params: URLSearchParams, key: string, value: TOption<string>) {
  if (value !== undefined) {
    params.set(key, value);
  }
}
