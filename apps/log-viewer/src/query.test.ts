import { describe, expect, test } from "bun:test";
import { EBehaviorLogLevel } from "@bellaclaw/behavior-logs";
import { buildLogUrl } from "./query";
import type { TLogSearchQuery } from "./types";

function baseQuery(overrides: Partial<TLogSearchQuery> = {}): TLogSearchQuery {
  return {
    q: undefined,
    range: "24h",
    level: undefined,
    success: undefined,
    event: undefined,
    component: undefined,
    toolName: undefined,
    turnId: undefined,
    until: 1000,
    beforeCreatedAt: undefined,
    beforeId: undefined,
    live: false,
    ...overrides,
  };
}

describe("buildLogUrl", () => {
  test("applies overrides on top of the current query", () => {
    const url = buildLogUrl(baseQuery({ level: EBehaviorLogLevel.Error }), {
      includeUntil: false,
      includeCursor: false,
      live: false,
      overrides: { component: "ai" },
    });

    expect(url).toBe("/?range=24h&level=error&component=ai");
  });

  test("clears a filter when the override is undefined", () => {
    const url = buildLogUrl(baseQuery({ component: "ai" }), {
      includeUntil: false,
      includeCursor: false,
      live: false,
      overrides: { component: undefined },
    });

    expect(url).toBe("/?range=24h");
  });
});
