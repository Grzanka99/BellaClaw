import { describe, expect, test } from "bun:test";
import { SDefineSettingsIntent } from "./handler";

describe("define-settings-intent reason validation", () => {
  test("rejects empty reason strings", () => {
    expect(SDefineSettingsIntent.safeParse({ intent: "settings", reason: "" }).success).toBe(false);
  });
});
