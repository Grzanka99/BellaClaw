import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { Config } from "../../../config";
import { DefaultConfigRecord, EConfigKey, type TConfigRecord } from "../../settings/schema";

const testTempDir = Bun.env.TMPDIR ?? "tmp";
mkdirSync(testTempDir, { recursive: true });

function getTempXmlPath(prefix: string): string {
  return `${testTempDir}/${prefix}-${Date.now()}.xml`;
}

const mockConfig = {
  ...Config,
  ai: {
    ...Config.ai,
    instructions: {
      ...Config.ai.instructions,
      timezone: "Europe/Warsaw",
      assistantName: "Bellatrix",
      language: "Polish",
      timeFormat: "24-hour format (e.g. 14:30, not 2:30 PM)",
      memoryRetention: {
        low: "Discard after short-term context window",
        medium: "Keep for several weeks, review periodically",
        high: "Keep indefinitely, reference in future conversations",
      },
    },
  },
};

describe("readXmlAndInjectConfig", () => {
  test("injects top-level config values into XML placeholders", async () => {
    const { readXmlAndInjectConfig } = await import("./read-xml-and-inject-config");

    const tempPath = getTempXmlPath("test-inject");
    await Bun.write(tempPath, `Hello {{config.ai.instructions.assistantName}}!`);

    const result = await readXmlAndInjectConfig(tempPath, mockConfig);
    expect(result).toBe("Hello Bellatrix!");

    await Bun.file(tempPath).delete();
  });

  test("injects nested config values like memoryRetention.high", async () => {
    const { readXmlAndInjectConfig } = await import("./read-xml-and-inject-config");

    const tempPath = getTempXmlPath("test-inject-nested");
    await Bun.write(
      tempPath,
      `<retention>{{config.ai.instructions.memoryRetention.high}}</retention>`,
    );

    const result = await readXmlAndInjectConfig(tempPath, mockConfig);
    expect(result).toBe(
      "<retention>Keep indefinitely, reference in future conversations</retention>",
    );

    await Bun.file(tempPath).delete();
  });

  test("injects multiple different placeholders in one file", async () => {
    const { readXmlAndInjectConfig } = await import("./read-xml-and-inject-config");

    const tempPath = getTempXmlPath("test-inject-multi");
    await Bun.write(
      tempPath,
      `Always use the {{config.ai.instructions.timezone}} timezone. Reply in {{config.ai.instructions.language}}. Name: {{config.ai.instructions.assistantName}}.`,
    );

    const result = await readXmlAndInjectConfig(tempPath, mockConfig);
    expect(result).toBe("Always use the Europe/Warsaw timezone. Reply in Polish. Name: Bellatrix.");

    await Bun.file(tempPath).delete();
  });

  test("leaves non-config curly braces untouched", async () => {
    const { readXmlAndInjectConfig } = await import("./read-xml-and-inject-config");

    const tempPath = getTempXmlPath("test-inject-plain");
    await Bun.write(tempPath, `User id: {user.id}, timezone: {{config.ai.instructions.timezone}}`);

    const result = await readXmlAndInjectConfig(tempPath, mockConfig);
    expect(result).toBe("User id: {user.id}, timezone: Europe/Warsaw");

    await Bun.file(tempPath).delete();
  });

  test("throws on missing config path", async () => {
    const { readXmlAndInjectConfig } = await import("./read-xml-and-inject-config");

    const tempPath = getTempXmlPath("test-inject-missing");
    await Bun.write(tempPath, `Value: {{config.ai.instructions.nonexistent}}`);

    await expect(readXmlAndInjectConfig(tempPath, mockConfig)).rejects.toThrow(
      'readXmlAndInjectConfig: "config.ai.instructions.nonexistent" is undefined',
    );

    await Bun.file(tempPath).delete();
  });

  test("throws on config path that hits a non-object value", async () => {
    const { readXmlAndInjectConfig } = await import("./read-xml-and-inject-config");

    const tempPath = getTempXmlPath("test-inject-nonobj");
    await Bun.write(tempPath, `Value: {{config.ai.instructions.timezone.foo}}`);

    await expect(readXmlAndInjectConfig(tempPath, mockConfig)).rejects.toThrow(
      `cannot resolve "config.ai.instructions.timezone.foo"`,
    );

    await Bun.file(tempPath).delete();
  });

  test("resolves nested placeholders where config values contain other placeholders", async () => {
    const { readXmlAndInjectConfig } = await import("./read-xml-and-inject-config");

    const nestedConfig = {
      ...mockConfig,
      ai: {
        ...mockConfig.ai,
        instructions: {
          ...mockConfig.ai.instructions,
          assistantName: "Nyx",
          preferredReplyLength: "1-3 sentences",
          persona: `You are {{config.ai.instructions.assistantName}}. Prefer {{config.ai.instructions.preferredReplyLength}}.`,
        },
      },
    };

    const tempPath = getTempXmlPath("test-inject-nested-refs");
    await Bun.write(tempPath, `<persona>{{config.ai.instructions.persona}}</persona>`);

    const result = await readXmlAndInjectConfig(tempPath, nestedConfig);
    expect(result).toBe("<persona>You are Nyx. Prefer 1-3 sentences.</persona>");

    await Bun.file(tempPath).delete();
  });

  test("injects into actual base-system.xml file and resolves all placeholders", async () => {
    const { readXmlAndInjectConfig } = await import("./read-xml-and-inject-config");

    const result = await readXmlAndInjectConfig(
      "./src/services/ai/instructions/base-system.xml",
      mockConfig,
    );

    expect(result).toContain("Europe/Warsaw");
    expect(result).toContain("Polish");
    expect(result).toContain("Bellatrix");
    expect(result).toContain("Discord direct messages");
    expect(result).not.toContain("{{config.");
  });

  test("resolves placeholders from a flat TConfigRecord keyed by dotted strings", async () => {
    const { readXmlAndInjectConfig } = await import("./read-xml-and-inject-config");

    const record: TConfigRecord = {
      ...DefaultConfigRecord,
      [EConfigKey.AiInstructionsAssistantName]: "Nyx",
      [EConfigKey.AiInstructionsTimezone]: "America/New_York",
      [EConfigKey.AiInstructionsLanguage]: "English",
    };

    const tempPath = getTempXmlPath("test-inject-record");
    await Bun.write(
      tempPath,
      `Name: {{config.ai.instructions.assistantName}}, TZ: {{config.ai.instructions.timezone}}, Lang: {{config.ai.instructions.language}}`,
    );

    const result = await readXmlAndInjectConfig(tempPath, record);
    expect(result).toBe("Name: Nyx, TZ: America/New_York, Lang: English");

    await Bun.file(tempPath).delete();
  });
});
