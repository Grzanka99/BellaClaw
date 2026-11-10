import { describe, expect, test } from "bun:test";
import type { Schema } from "@earendil-works/pi-schema";
import { validateToolArguments } from "./define-tool";
import { SScheduleOnceArgs } from "./schedule-once";
import { SSearchMemoryArgs } from "./search-memory";

describe("validateToolArguments", () => {
  test("names the offending path instead of throwing a bare Decode error", () => {
    const cases: Array<{ schema: Schema; args: unknown; path: string; reason: string }> = [
      {
        schema: SScheduleOnceArgs,
        args: { name: "x", fireAt: "tomorrow at 5pm", reminderText: "Reminder" },
        path: "/fireAt",
        reason: "expected to match",
      },
      {
        schema: SScheduleOnceArgs,
        args: {
          name: "x",
          fireAt: "2026-09-01T10:00:00",
          reminderText: "Reminder",
          group: null,
        },
        path: "/group",
        reason: "expected string, got null",
      },
      {
        schema: SSearchMemoryArgs,
        args: { query: "facts", limit: 99 },
        path: "/limit",
        reason: "expected <= 25",
      },
      {
        schema: SSearchMemoryArgs,
        args: {},
        path: "/query",
        reason: "missing",
      },
    ];

    for (const { schema, args, path, reason } of cases) {
      expect(() => validateToolArguments(schema, args)).toThrow(
        `Invalid tool arguments: ${path}: ${reason}`,
      );
    }
  });

  test("returns the decoded arguments for a valid payload", () => {
    expect(validateToolArguments(SSearchMemoryArgs, { query: "tea", limit: 3 })).toEqual({
      query: "tea",
      limit: 3,
    });
  });
});
