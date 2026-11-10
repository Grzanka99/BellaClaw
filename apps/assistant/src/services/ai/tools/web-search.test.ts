import { describe, expect, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { SWebSearchArgs } from "./web-search";

describe("SWebSearchArgs", () => {
  test("accepts valid args and rejects invalid fields", () => {
    expect(compile(SWebSearchArgs, { formats }).check({ query: "bun test", maxResults: 10 })).toBe(
      true,
    );
    expect(compile(SWebSearchArgs, { formats }).check({ query: "" })).toBe(false);
    expect(compile(SWebSearchArgs, { formats }).check({ query: "bun", maxResults: 11 })).toBe(
      false,
    );
    expect(compile(SWebSearchArgs, { formats }).check({ query: "bun", topic: "images" })).toBe(
      false,
    );
    expect(compile(SWebSearchArgs, { formats }).check({ query: "bun", limit: 1 })).toBe(false);
  });
});
