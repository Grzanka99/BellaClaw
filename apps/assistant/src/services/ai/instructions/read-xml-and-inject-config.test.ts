import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultConfigRecord, EConfigKey } from "../../settings/schema";
import { readXmlAndInjectConfig } from "./read-xml-and-inject-config";

const directory = await mkdtemp(join(tmpdir(), "bellaclaw-instructions-"));
afterAll(() => rm(directory, { recursive: true, force: true }));

describe("readXmlAndInjectConfig", () => {
  test("substitutes settings and nested references while preserving other braces", async () => {
    const path = join(directory, "settings.xml");
    await Bun.write(
      path,
      "{{config.ai.instructions.persona}} TZ: {{config.ai.instructions.timezone}} {user.id}",
    );
    const settings = {
      ...DefaultConfigRecord,
      [EConfigKey.AiInstructionsAssistantName]: "Nyx",
      [EConfigKey.AiInstructionsTimezone]: "America/New_York",
      [EConfigKey.AiInstructionsPersona]: "You are {{config.ai.instructions.assistantName}}.",
    };

    expect(await readXmlAndInjectConfig(path, settings)).toBe(
      "You are Nyx. TZ: America/New_York {user.id}",
    );
  });

  test("rejects unknown settings", async () => {
    const path = join(directory, "unknown.xml");
    await Bun.write(path, "{{config.ai.instructions.nonexistent}}");

    await expect(readXmlAndInjectConfig(path, DefaultConfigRecord)).rejects.toThrow(
      "unknown config key",
    );
  });

  test("assembles the real base prompt without unresolved placeholders", async () => {
    const result = await readXmlAndInjectConfig(
      "./src/services/ai/instructions/base-system.xml",
      DefaultConfigRecord,
    );

    expect(result).toContain(DefaultConfigRecord[EConfigKey.AiInstructionsAssistantName]);
    expect(result).not.toContain("{{config.");
    expect(result).not.toContain("{{commands}}");
    expect(result).toContain("!calendar_add-write CALENDAR_ID");
  });
});
