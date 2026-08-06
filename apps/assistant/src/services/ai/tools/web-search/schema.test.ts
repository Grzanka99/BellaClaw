import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { SWebSearchArgs } from "./handler";

describe("SWebSearchArgs", () => {
  test("accepts valid args and rejects invalid fields", () => {
    expect(Value.Check(SWebSearchArgs, { query: "bun test", maxResults: 10 })).toBe(true);
    expect(Value.Check(SWebSearchArgs, { query: "" })).toBe(false);
    expect(Value.Check(SWebSearchArgs, { query: "bun", maxResults: 11 })).toBe(false);
    expect(Value.Check(SWebSearchArgs, { query: "bun", topic: "images" })).toBe(false);
    expect(Value.Check(SWebSearchArgs, { query: "bun", limit: 1 })).toBe(false);
  });
});
