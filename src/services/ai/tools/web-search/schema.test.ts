import { describe, expect, test } from "bun:test";
import { SWebSearchArgs } from "./handler";

describe("SWebSearchArgs", () => {
  test("accepts valid args", () => {
    expect(SWebSearchArgs.safeParse({ query: "bun test" }).success).toBe(true);
    expect(SWebSearchArgs.safeParse({ query: "bun test", limit: 10 }).success).toBe(true);
  });

  test("rejects invalid args", () => {
    expect(SWebSearchArgs.safeParse({ query: "" }).success).toBe(false);
    expect(SWebSearchArgs.safeParse({ query: "bun", limit: 0 }).success).toBe(false);
    expect(SWebSearchArgs.safeParse({ query: "bun", limit: 11 }).success).toBe(false);
    expect(SWebSearchArgs.safeParse({ query: "bun", limit: 1.5 }).success).toBe(false);
  });
});
