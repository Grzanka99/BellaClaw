import { describe, expect, test } from "bun:test";
import { handleDefineSettingsIntent, SDefineSettingsIntent } from "./handler";

describe("handleDefineSettingsIntent", () => {
  test("parses valid settings intent", () => {
    const result = handleDefineSettingsIntent({
      intent: "settings",
      reason: "change timezone",
    });

    expect(result).toEqual({ intent: "settings", reason: "change timezone" });
  });

  test("parses valid normal intent", () => {
    const result = handleDefineSettingsIntent({ intent: "normal", reason: "casual greeting" });

    expect(result).toEqual({ intent: "normal", reason: "casual greeting" });
  });

  test("returns undefined for invalid argument type", () => {
    const result = handleDefineSettingsIntent("invalid");

    expect(result).toBeUndefined();
  });

  test("returns undefined for invalid intent enum value", () => {
    const result = handleDefineSettingsIntent({ intent: "unknown", reason: "test" });

    expect(result).toBeUndefined();
  });

  test("returns undefined when reason is missing", () => {
    const result = handleDefineSettingsIntent({ intent: "settings" });

    expect(result).toBeUndefined();
  });

  test("SDefineSettingsIntent accepts settings and normal intents", () => {
    expect(SDefineSettingsIntent.safeParse({ intent: "settings", reason: "r" }).success).toBe(true);
    expect(SDefineSettingsIntent.safeParse({ intent: "normal", reason: "r" }).success).toBe(true);
  });

  test("SDefineSettingsIntent rejects unknown intent values", () => {
    expect(SDefineSettingsIntent.safeParse({ intent: "other", reason: "r" }).success).toBe(false);
  });
});
