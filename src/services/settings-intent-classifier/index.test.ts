import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TToolTaskArgs } from "../ai/api";
import { DEFINE_SETTINGS_INTENT_TOOL } from "../ai/tools/define-settings-intent/definition";
import { SettingsService } from "../settings";
import { DefaultConfigRecord, EConfigKey, type TConfigRecord } from "../settings/schema";
import { SettingsIntentClassifier } from "./index";

type TSettingsServiceStatic = { _instance: unknown };

type TSettingsIntentClassifierStatic = {
  _instance: SettingsIntentClassifier | undefined;
};

type TSettingsIntentClassifierInternals = {
  ai: {
    runToolTask: typeof import("../ai/api").AiConnector.prototype.runToolTask;
  };
};

function resetSettingsInstance() {
  const SettingsServiceStatic = SettingsService as unknown as TSettingsServiceStatic;
  SettingsServiceStatic._instance = undefined;
}

function mockSettingsServiceGetAll(impl: () => Promise<unknown>) {
  const SettingsServiceStatic = SettingsService as unknown as TSettingsServiceStatic;
  SettingsServiceStatic._instance = {
    getAll: mock(impl),
  };
}

function resetClassifierInstance() {
  const ClassifierStatic = SettingsIntentClassifier as unknown as TSettingsIntentClassifierStatic;
  ClassifierStatic._instance = undefined;
}

describe("SettingsIntentClassifier", () => {
  const originalBunFile = Bun.file;

  beforeEach(() => {
    resetSettingsInstance();
    resetClassifierInstance();
  });

  afterEach(() => {
    resetSettingsInstance();
    resetClassifierInstance();
    Bun.file = originalBunFile;
  });

  test("returns undefined when SettingsService.getAll throws", async () => {
    mockSettingsServiceGetAll(async () => {
      throw new Error("db connection lost");
    });

    const classifier = SettingsIntentClassifier.instance;
    const result = await classifier.classify("change your timezone to UTC", "discord:user-1");

    expect(result).toBeUndefined();
  });

  test("returns undefined when reading instructions XML throws", async () => {
    mockSettingsServiceGetAll(async () => DefaultConfigRecord);

    Bun.file = mock(() => ({
      text: async () => {
        throw new Error("file not found");
      },
    })) as unknown as typeof Bun.file;

    const classifier = SettingsIntentClassifier.instance;
    const result = await classifier.classify("change your timezone to UTC", "discord:user-1");

    expect(result).toBeUndefined();
  });

  test("returns undefined when runToolTask throws", async () => {
    mockSettingsServiceGetAll(async () => DefaultConfigRecord);

    const classifier = SettingsIntentClassifier.instance;
    const internals = classifier as unknown as TSettingsIntentClassifierInternals;
    internals.ai = {
      runToolTask: mock(async () => {
        throw new Error("provider unavailable");
      }),
    } as never;

    const result = await classifier.classify("change your timezone to UTC", "discord:user-1");

    expect(result).toBeUndefined();
  });

  test("returns undefined when runToolTask returns no successful tool result", async () => {
    mockSettingsServiceGetAll(async () => DefaultConfigRecord);

    const classifier = SettingsIntentClassifier.instance;
    const internals = classifier as unknown as TSettingsIntentClassifierInternals;
    internals.ai = {
      runToolTask: mock(async () => ({
        assistantResponse: "",
        toolCalls: [],
        toolResults: [],
      })),
    } as never;

    const result = await classifier.classify("change your timezone to UTC", "discord:user-1");

    expect(result).toBeUndefined();
  });

  test("returns parsed intent on success", async () => {
    mockSettingsServiceGetAll(async () => DefaultConfigRecord);

    const classifier = SettingsIntentClassifier.instance;
    const internals = classifier as unknown as TSettingsIntentClassifierInternals;
    internals.ai = {
      runToolTask: mock(async () => ({
        assistantResponse: "",
        toolCalls: [],
        toolResults: [
          {
            toolName: DEFINE_SETTINGS_INTENT_TOOL,
            success: true,
            data: { intent: "settings", reason: "change timezone" },
          },
        ],
      })),
    } as never;

    const result = await classifier.classify("change your timezone to UTC", "discord:user-1");

    expect(result).toEqual({ intent: "settings", reason: "change timezone" });
  });

  test("uses stable AI settings while injecting user instructions", async () => {
    const storedSettings: TConfigRecord = {
      ...DefaultConfigRecord,
      [EConfigKey.AiInstructionsLanguage]: "Klingon",
      [EConfigKey.AiProvider]: "bad-provider",
      [EConfigKey.AiProvidersOpencodeGoModelsToolCheap]: "bad-tool-cheap-model",
    };
    const capturedArgs: TToolTaskArgs[] = [];

    mockSettingsServiceGetAll(async () => storedSettings);

    Bun.file = mock(() => ({
      text: async () => "Classify in {{config.ai.instructions.language}}.",
    })) as unknown as typeof Bun.file;

    const classifier = SettingsIntentClassifier.instance;
    const internals = classifier as unknown as TSettingsIntentClassifierInternals;
    internals.ai = {
      runToolTask: mock(async (args: TToolTaskArgs) => {
        capturedArgs.push(args);
        return {
          assistantResponse: "",
          toolCalls: [],
          toolResults: [
            {
              toolName: DEFINE_SETTINGS_INTENT_TOOL,
              success: true,
              data: { intent: "settings", reason: "change language" },
            },
          ],
        };
      }),
    } as never;

    await classifier.classify("speak Klingon", "discord:user-1");

    const args = capturedArgs[0];

    if (args === undefined) {
      throw new Error("Expected captured runToolTask args");
    }

    expect(args.settings[EConfigKey.AiProvider]).toBe(DefaultConfigRecord[EConfigKey.AiProvider]);
    expect(args.settings[EConfigKey.AiProvidersOpencodeGoModelsToolCheap]).toBe(
      DefaultConfigRecord[EConfigKey.AiProvidersOpencodeGoModelsToolCheap],
    );
    expect(args.settings[EConfigKey.AiInstructionsLanguage]).toBe("Klingon");
    expect(args.history[0]?.content).toContain("Classify in Klingon.");
  });
});
