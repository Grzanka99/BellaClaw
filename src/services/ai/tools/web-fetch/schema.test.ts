import { describe, expect, test } from "bun:test";
import { SWebFetchArgs } from "./handler";

describe("SWebFetchArgs", () => {
  test("accepts valid args", () => {
    expect(SWebFetchArgs.safeParse({ url: "https://example.com" }).success).toBe(true);
    expect(
      SWebFetchArgs.safeParse({ url: "http://example.com", format: "text", timeout: 45 }).success,
    ).toBe(true);
  });

  test("rejects invalid schema", () => {
    expect(SWebFetchArgs.safeParse({ url: "not a url" }).success).toBe(false);
    expect(SWebFetchArgs.safeParse({ url: "https://example.com", format: "pdf" }).success).toBe(
      false,
    );
    expect(SWebFetchArgs.safeParse({ url: "https://example.com", timeout: 46 }).success).toBe(
      false,
    );
  });

  test("rejects non-http URL schemes", () => {
    expect(SWebFetchArgs.safeParse({ url: "ftp://example.com/file.txt" }).success).toBe(false);
    expect(SWebFetchArgs.safeParse({ url: "file:///tmp/test.txt" }).success).toBe(false);
  });
});
