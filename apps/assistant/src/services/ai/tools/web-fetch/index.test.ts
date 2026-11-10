import { describe, expect, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { SWebFetchArgs, validateWebFetchArgs } from ".";

describe("SWebFetchArgs", () => {
  test("validates shape and bounds", () => {
    expect(
      compile(SWebFetchArgs, { formats }).check({ url: "https://example.com", timeout: 45 }),
    ).toBe(true);
    expect(compile(SWebFetchArgs, { formats }).check({ url: "not a url" })).toBe(false);
    expect(
      compile(SWebFetchArgs, { formats }).check({ url: "https://example.com", timeout: 46 }),
    ).toBe(false);
    expect(
      compile(SWebFetchArgs, { formats }).check({ url: "https://example.com", format: "pdf" }),
    ).toBe(false);
  });

  test("rejects non-http URL protocols in domain validation", () => {
    expect(() => validateWebFetchArgs({ url: "ftp://example.com/file.txt" })).toThrow(
      "url must use the http or https protocol",
    );
  });
});
