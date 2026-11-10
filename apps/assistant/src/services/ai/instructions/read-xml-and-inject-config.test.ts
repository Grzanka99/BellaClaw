import { describe, expect, test } from "bun:test";
import { DefaultConfigRecord, EConfigKey } from "../../settings/schema";
import baseInstructions from "./base-system.xml" with { type: "text" };
import { readXmlAndInjectConfig } from "./read-xml-and-inject-config";

describe("readXmlAndInjectConfig", () => {
  test("substitutes settings and nested references while preserving other braces", () => {
    const settings = {
      ...DefaultConfigRecord,
      [EConfigKey.AiInstructionsAssistantName]: "Nyx",
      [EConfigKey.AiInstructionsTimezone]: "America/New_York",
      [EConfigKey.AiInstructionsPersona]: "You are {{config.ai.instructions.assistantName}}.",
    };

    expect(
      readXmlAndInjectConfig(
        "{{config.ai.instructions.persona}} TZ: {{config.ai.instructions.timezone}} {user.id}",
        settings,
      ),
    ).toBe("You are Nyx. TZ: America/New_York {user.id}");
  });

  test("rejects unknown settings", () => {
    expect(() =>
      readXmlAndInjectConfig("{{config.ai.instructions.nonexistent}}", DefaultConfigRecord),
    ).toThrow("unknown config key");
  });

  test("assembles the real base prompt without unresolved placeholders", () => {
    const result = readXmlAndInjectConfig(baseInstructions, DefaultConfigRecord);

    expect(result).toContain(DefaultConfigRecord[EConfigKey.AiInstructionsAssistantName]);
    expect(result).not.toContain("{{config.");
    expect(result).not.toContain("{{commands}}");
    expect(result).toContain("!calendar_add-write CALENDAR_ID");
  });
});
