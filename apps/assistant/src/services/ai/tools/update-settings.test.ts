import { afterEach, describe, expect, type Mock, mock, spyOn, test } from "bun:test";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { SettingsService, type TConfigUpdate } from "../../settings";
import { DefaultConfigRecord, EConfigKey, type TConfigRecord } from "../../settings/schema";
import { decodeAiModelPreferences, getAiModelPreference } from "../model-preferences";
import { opencodeGoProvider as dynamicOpencodeGoProvider } from "../providers/opencode-go";
import { aiModels } from "../providers/registry";
import { EAiProvider, EModelPurpose } from "../types";
import { getSettings } from "./get-settings";
import { updateSettings } from "./update-settings";

const context = {
  chatId: "discord:1",
  settings: DefaultConfigRecord,
  trace: { turnId: "test", chatId: undefined, platform: undefined },
  verifySettings: mock(async () => undefined),
};

function installSettingsMock(initial: TConfigRecord) {
  const current = { ...initial };
  const getAll = mock(async () => ({ ...current }));
  const setMany = mock(async (_ownerKey: string, updates: TConfigUpdate[]) => {
    for (const update of updates) {
      current[update.key] = update.value;
    }

    return { ...current };
  });
  (SettingsService as unknown as { _instance: unknown })._instance = { getAll, setMany };

  return { getAll, setMany };
}

afterEach(() => {
  (SettingsService as unknown as { _instance: unknown })._instance = undefined;
});

describe("update-settings", () => {
  test("does not persist a provider when its first model verification fails", async () => {
    const verifySettings = mock(async () => "verification failed");
    const settingsMock = installSettingsMock(DefaultConfigRecord);
    const tool = updateSettings.createAgentTool({ ...context, verifySettings });

    await expect(
      tool.execute("call", {
        aiProvider: EAiProvider.Openrouter,
        aiModel: "openai/gpt-5.4-mini",
      }),
    ).rejects.toThrow("verification failed");
    expect(verifySettings).toHaveBeenCalledWith(
      expect.objectContaining({
        [EConfigKey.AiProvider]: EAiProvider.Openrouter,
      }),
      [EModelPurpose.Utility],
    );
    expect(settingsMock.setMany).not.toHaveBeenCalled();
  });

  test.each(["claude-haiku-5-5", "gpt-6-luna"])("lists and selects Go model %s", async (model) => {
    const previousProvider = aiModels.getProvider(EAiProvider.OpencodeGo);
    aiModels.setProvider(opencodeGoProvider());
    const settingsMock = installSettingsMock({
      ...DefaultConfigRecord,
      [EConfigKey.AiProvider]: EAiProvider.OpencodeGo,
    });
    const verifySettings = mock(async () => undefined);
    const read = getSettings.createAgentTool({ ...context, verifySettings });
    const update = updateSettings.createAgentTool({ ...context, verifySettings });

    try {
      const settings = await read.execute("read", {});
      expect(settings?.details).toMatchObject({
        aiRuntime: {
          availableModels: expect.arrayContaining([expect.objectContaining({ id: model })]),
        },
      });
      const result = await update.execute("select", { aiModel: model });
      expect(result?.details).toMatchObject({
        aiRuntime: { models: { [EModelPurpose.Main]: { model } } },
      });
      expect(verifySettings).toHaveBeenCalledTimes(1);
      expect(settingsMock.setMany).toHaveBeenCalledTimes(1);
    } finally {
      if (previousProvider !== undefined) {
        aiModels.setProvider(previousProvider);
      }
    }
  });

  test("fetches current Go models for direct selection and explicit listing", async () => {
    const previousProvider = aiModels.getProvider(EAiProvider.OpencodeGo);
    aiModels.setProvider({
      ...dynamicOpencodeGoProvider([]),
      auth: {
        apiKey: {
          name: "Test key",
          resolve: async () => ({ auth: { apiKey: "catalog-test-key" } }),
        },
      },
    });
    const settingsMock = installSettingsMock({
      ...DefaultConfigRecord,
      [EConfigKey.AiProvider]: EAiProvider.OpencodeGo,
    });
    const verifySettings = mock(async () => undefined);
    const read = getSettings.createAgentTool({ ...context, verifySettings });
    const update = updateSettings.createAgentTool({ ...context, verifySettings });
    let currentModel = "completions-current";
    const fetchMock: Mock<(input: Parameters<typeof fetch>[0]) => Promise<Response>> = spyOn(
      globalThis,
      "fetch",
    );
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/models")) {
        return Response.json({
          data: [{ id: "grok-4.7" }, { id: "deepseek-v4-pro" }, { id: currentModel }],
        });
      }
      return Response.json({
        "opencode-go": {
          models: {
            [currentModel]: {
              name: "Current model",
              tool_call: true,
              reasoning: false,
              modalities: { input: ["text"], output: ["text"] },
              limit: { context: 1000000, output: 64000 },
              cost: { input: 1, output: 5 },
            },
          },
        },
      });
    });
    try {
      const selected = await update.execute("select", { aiModel: currentModel });
      expect(selected?.details).toMatchObject({
        aiRuntime: { models: { [EModelPurpose.Main]: { model: currentModel } } },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      currentModel = "completions-listed";
      const listed = await read.execute("list", {});
      expect(listed?.details).toMatchObject({
        aiRuntime: {
          availableModels: expect.arrayContaining([expect.objectContaining({ id: currentModel })]),
        },
      });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      currentModel = "completions-selected";
      const refreshed = await update.execute("select", { aiModel: currentModel });
      expect(refreshed?.details).toMatchObject({
        aiRuntime: { models: { [EModelPurpose.Main]: { model: currentModel } } },
      });
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(settingsMock.setMany).toHaveBeenCalledTimes(2);
      expect(verifySettings).toHaveBeenCalledTimes(2);
      await Promise.all([read.execute("list-a", {}), read.execute("list-b", {})]);
      expect(fetchMock).toHaveBeenCalledTimes(8);
    } finally {
      fetchMock.mockRestore();
      if (previousProvider !== undefined) {
        aiModels.setProvider(previousProvider);
      }
    }
  });

  test("preserves and resets effort without returning the model catalog", async () => {
    const settingsMock = installSettingsMock({
      ...DefaultConfigRecord,
      [EConfigKey.AiProvider]: EAiProvider.OpenaiCodex,
      [EConfigKey.AiModelPreferences]: JSON.stringify({
        [EAiProvider.OpenaiCodex]: {
          [EModelPurpose.Specialist]: { model: "gpt-5.6-sol", effort: "high" },
        },
      }),
    });
    const verifySettings = mock(
      async (_candidate: TConfigRecord, _purposes: EModelPurpose[]) => undefined,
    );
    const tool = updateSettings.createAgentTool({ ...context, verifySettings });

    const result = await tool.execute("call", {
      aiModel: "gpt-5.6-terra",
      aiModelPurpose: EModelPurpose.Specialist,
    });
    expect(result?.details).toMatchObject({
      aiRuntime: {
        models: {
          [EModelPurpose.Specialist]: { model: "gpt-5.6-terra", effort: "high" },
        },
      },
    });
    const resetResult = await tool.execute("call", {
      aiModelPurpose: EModelPurpose.Specialist,
      resetAiReasoningEffort: true,
    });
    expect(resetResult?.details).toMatchObject({
      aiRuntime: {
        models: {
          [EModelPurpose.Specialist]: { model: "gpt-5.6-terra", effort: "default" },
        },
      },
    });
    expect(JSON.stringify(resetResult?.details)).not.toContain("availableModels");
    expect(verifySettings).toHaveBeenCalledTimes(2);
    expect(settingsMock.setMany).toHaveBeenCalledTimes(2);
  });

  test("selects a service tier and rejects it for unsupported models", async () => {
    const settingsMock = installSettingsMock({
      ...DefaultConfigRecord,
      [EConfigKey.AiProvider]: EAiProvider.OpenaiCodex,
    });
    const verifySettings = mock(async () => undefined);
    const tool = updateSettings.createAgentTool({ ...context, verifySettings });

    const fast = await tool.execute("call", {
      aiModel: "gpt-6.1-terra",
      aiReasoningEffort: "high",
      aiServiceTier: "priority",
      aiModelPurpose: EModelPurpose.ScheduledTask,
    });
    expect(fast?.details).toMatchObject({
      aiRuntime: {
        models: {
          [EModelPurpose.ScheduledTask]: {
            model: "gpt-6.1-terra",
            effort: "high",
            serviceTier: "priority",
          },
        },
      },
    });
    await expect(
      tool.execute("call", {
        aiProvider: EAiProvider.Openrouter,
        aiModel: "openai/gpt-5.4-mini",
        aiServiceTier: "priority",
      }),
    ).rejects.toThrow("Service tier is unsupported by openai/gpt-5.4-mini");
    expect(settingsMock.setMany).toHaveBeenCalledTimes(1);
  });

  test("checks distinct model/effort pairs concurrently before saving a provider", async () => {
    const settingsMock = installSettingsMock(DefaultConfigRecord);
    const verifySettings = mock(async (_settings: TConfigRecord, _purposes: EModelPurpose[]) => {
      await Promise.resolve();
      expect(verifySettings).toHaveBeenCalledTimes(3);
      expect(settingsMock.setMany).not.toHaveBeenCalled();
      return undefined;
    });
    const tool = updateSettings.createAgentTool({ ...context, verifySettings });

    await tool.execute("call", { aiProvider: EAiProvider.Openrouter });

    expect(verifySettings.mock.calls.map(([, purposes]) => purposes)).toEqual([
      [EModelPurpose.Utility],
      [EModelPurpose.Main],
      [EModelPurpose.Specialist],
    ]);
    expect(settingsMock.setMany).toHaveBeenCalledTimes(1);
  });

  test("retries shared failed preferences separately and clears them sequentially", async () => {
    const settingsMock = installSettingsMock({
      ...DefaultConfigRecord,
      [EConfigKey.AiModelPreferences]: JSON.stringify({
        [EAiProvider.OpenaiCodex]: {
          [EModelPurpose.Main]: { model: "gpt-5.6-terra", effort: "high" },
          [EModelPurpose.Specialist]: { model: "gpt-5.6-terra", effort: "high" },
        },
      }),
    });
    const retries: EModelPurpose[] = [];
    const remainingPreferences: string[][] = [];
    const verifySettings = mock(async (settings: TConfigRecord, purposes: EModelPurpose[]) => {
      const serialized = settings[EConfigKey.AiModelPreferences];
      const preferences = decodeAiModelPreferences(serialized);
      const purpose = purposes[0] as EModelPurpose;
      await Promise.resolve();
      expect(settings[EConfigKey.AiModelPreferences]).toBe(serialized);
      expect(settingsMock.setMany).not.toHaveBeenCalled();

      if (getAiModelPreference(preferences, EAiProvider.OpenaiCodex, purpose) !== undefined) {
        return "remembered model unavailable";
      }
      if (purpose === EModelPurpose.Main || purpose === EModelPurpose.Specialist) {
        retries.push(purpose);
        remainingPreferences.push(Object.keys(preferences[EAiProvider.OpenaiCodex] ?? {}));
      }
      return undefined;
    });
    const tool = updateSettings.createAgentTool({ ...context, verifySettings });

    const result = await tool.execute("call", { aiProvider: EAiProvider.OpenaiCodex });

    expect(verifySettings).toHaveBeenCalledTimes(4);
    expect(retries).toEqual([EModelPurpose.Main, EModelPurpose.Specialist]);
    expect(remainingPreferences).toEqual([[EModelPurpose.Specialist], []]);
    expect(result?.details).toMatchObject({
      settings: { [EConfigKey.AiModelPreferences]: "{}" },
      change: { fallbacks: retries.map((purpose) => ({ purpose, reason: expect.any(String) })) },
    });
    expect(settingsMock.setMany).toHaveBeenCalledTimes(1);
  });
});
