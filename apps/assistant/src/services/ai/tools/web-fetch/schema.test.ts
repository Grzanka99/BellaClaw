import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { SWebFetchArgs, validateWebFetchArgs } from "./handler";

describe("SWebFetchArgs", () => {
  test("validates shape and bounds", () => {
    expect(Value.Check(SWebFetchArgs, { url: "https://example.com", timeout: 45 })).toBe(true);
    expect(Value.Check(SWebFetchArgs, { url: "not a url" })).toBe(false);
    expect(Value.Check(SWebFetchArgs, { url: "https://example.com", timeout: 46 })).toBe(false);
    expect(Value.Check(SWebFetchArgs, { url: "https://example.com", format: "pdf" })).toBe(false);
  });

  test("rejects non-http URL protocols in domain validation", () => {
    expect(() => validateWebFetchArgs({ url: "ftp://example.com/file.txt" })).toThrow(
      "url must use the http or https protocol",
    );
  });
});
