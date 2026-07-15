import { describe, expect, test } from "bun:test";
import { SDefineSettingsIntent } from "./handler";

describe("SDefineSettingsIntent", () => {
  test("SDefineSettingsIntent accepts settings and normal intents", () => {
    expect(SDefineSettingsIntent.safeParse({ intent: "settings", reason: "r" }).success).toBe(true);
    expect(SDefineSettingsIntent.safeParse({ intent: "normal", reason: "r" }).success).toBe(true);
  });

  test("SDefineSettingsIntent rejects unknown intent values", () => {
    expect(SDefineSettingsIntent.safeParse({ intent: "other", reason: "r" }).success).toBe(false);
  });

  test("rejects invalid argument types and missing reasons", () => {
    expect(SDefineSettingsIntent.safeParse("invalid").success).toBe(false);
    expect(SDefineSettingsIntent.safeParse({ intent: "settings" }).success).toBe(false);
  });
});
