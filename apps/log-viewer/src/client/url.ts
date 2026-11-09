import type { TBehaviorLogSearchQuery } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";

export function buildLogUrl(
  query: TBehaviorLogSearchQuery,
  options: {
    includeUntil: boolean;
    includeCursor: boolean;
    live: boolean;
    path?: string;
    overrides?: Partial<TBehaviorLogSearchQuery>;
  },
): string {
  const merged: TBehaviorLogSearchQuery = { ...query, ...options.overrides };
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

function addValue(params: URLSearchParams, key: string, value: TOption<string>) {
  if (value !== undefined) {
    params.set(key, value);
  }
}
