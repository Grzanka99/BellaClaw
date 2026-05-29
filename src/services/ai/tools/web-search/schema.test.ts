import { describe, expect, test } from "bun:test";
import { SWebSearchArgs } from "./handler";

describe("SWebSearchArgs", () => {
  test("accepts valid args", () => {
    expect(SWebSearchArgs.safeParse({ query: "bun test" }).success).toBe(true);
    expect(
      SWebSearchArgs.safeParse({
        query: "bun test",
        maxResults: 10,
        topic: "news",
        timeRange: "week",
      }).success,
    ).toBe(true);
  });

  test("rejects invalid args", () => {
    expect(SWebSearchArgs.safeParse({ query: "" }).success).toBe(false);
    expect(SWebSearchArgs.safeParse({ query: "bun", maxResults: 0 }).success).toBe(false);
    expect(SWebSearchArgs.safeParse({ query: "bun", maxResults: 11 }).success).toBe(false);
    expect(SWebSearchArgs.safeParse({ query: "bun", maxResults: 1.5 }).success).toBe(false);
    expect(SWebSearchArgs.safeParse({ query: "bun", topic: "images" }).success).toBe(false);
    expect(SWebSearchArgs.safeParse({ query: "bun", timeRange: "hour" }).success).toBe(false);
    expect(SWebSearchArgs.safeParse({ query: "bun", limit: 1 }).success).toBe(false);
  });
});
