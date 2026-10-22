import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { hasApi } from "@earendil-works/pi-ai";
import { EAiProvider, EModelPurpose } from "../types";
import { opencodeGoProvider } from "./opencode-go";
import {
  aiModels,
  getAiApiKey,
  getAiModelConfig,
  getAiModelConfigs,
  refreshAiModels,
} from "./registry";

const ORIGINAL_OPENROUTER_API_KEY = Bun.env.OPENROUTER_API_KEY;
const ORIGINAL_OPENCODE_API_KEY = Bun.env.OPENCODE_API_KEY;

afterEach(() => {
  Bun.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER_API_KEY;
  Bun.env.OPENCODE_API_KEY = ORIGINAL_OPENCODE_API_KEY;
});

describe("AI provider registry", () => {
  test("registers every provider and resolves every purpose model", () => {
    expect(
      aiModels
        .getProviders()
        .map((provider) => provider.id)
        .toSorted(),
    ).toEqual(Object.values(EAiProvider).toSorted());

    for (const provider of Object.values(EAiProvider)) {
      const configs = getAiModelConfigs(provider, {});

      for (const purpose of Object.values(EModelPurpose)) {
        expect(getAiModelConfig(provider, purpose).model.id).toBe(configs[purpose].model);
      }
    }

    expect(aiModels.getModel(EAiProvider.Openrouter, "unknown-model")).toBeUndefined();
  });

  test("maps every role purpose to its configured model", () => {
    expect(getAiModelConfigs(EAiProvider.OpenaiCodex, {})).toMatchObject({
      [EModelPurpose.Utility]: { model: "gpt-5.6-luna" },
      [EModelPurpose.Main]: { model: "gpt-5.6-sol" },
      [EModelPurpose.Specialist]: { model: "gpt-5.6-luna" },
      [EModelPurpose.SpecialistAccurate]: { model: "gpt-5.6-luna" },
      [EModelPurpose.ScheduledTask]: { model: "gpt-5.6-luna" },
    });
    expect(getAiModelConfigs(EAiProvider.Openrouter, {})).toMatchObject({
      [EModelPurpose.Utility]: { model: "openai/gpt-5.4-nano" },
      [EModelPurpose.Main]: { model: "google/gemini-3.1-pro-preview" },
      [EModelPurpose.Specialist]: { model: "google/gemini-3-flash-preview" },
      [EModelPurpose.SpecialistAccurate]: { model: "google/gemini-3.1-pro-preview" },
      [EModelPurpose.ScheduledTask]: { model: "google/gemini-3.1-pro-preview" },
    });
    expect(getAiModelConfigs(EAiProvider.OpencodeGo, {})).toMatchObject({
      [EModelPurpose.Utility]: { model: "deepseek-v4-pro" },
      [EModelPurpose.Main]: { model: "grok-4.7" },
      [EModelPurpose.Specialist]: { model: "deepseek-v4-pro" },
      [EModelPurpose.SpecialistAccurate]: { model: "grok-4.7" },
      [EModelPurpose.ScheduledTask]: { model: "deepseek-v4-pro" },
    });
    expect(getAiModelConfigs(EAiProvider.Ollama, {})).toMatchObject({
      [EModelPurpose.Utility]: { model: "nemotron-3-super:cloud" },
      [EModelPurpose.Main]: { model: "minimax-m2.7:cloud" },
      [EModelPurpose.Specialist]: { model: "minimax-m2.7:cloud" },
      [EModelPurpose.SpecialistAccurate]: { model: "minimax-m2.7:cloud" },
      [EModelPurpose.ScheduledTask]: { model: "minimax-m2.7:cloud" },
    });
  });

  test("pairs each model purpose with its reasoning effort", () => {
    expect(getAiModelConfig(EAiProvider.OpenaiCodex, EModelPurpose.Utility).effort).toBe("medium");
    expect(getAiModelConfig(EAiProvider.OpenaiCodex, EModelPurpose.Main).effort).toBe("medium");
    expect(
      getAiModelConfig(EAiProvider.OpenaiCodex, EModelPurpose.Main, {
        model: "gpt-5.6-sol",
      }).effort,
    ).toBe("medium");

    for (const purpose of [
      EModelPurpose.Specialist,
      EModelPurpose.SpecialistAccurate,
      EModelPurpose.ScheduledTask,
    ]) {
      expect(getAiModelConfig(EAiProvider.OpenaiCodex, purpose).effort).toBe("max");
    }

    expect(getAiModelConfig(EAiProvider.Openrouter, EModelPurpose.Utility).effort).toBe("medium");
    expect(getAiModelConfig(EAiProvider.Openrouter, EModelPurpose.Specialist).effort).toBe("high");

    for (const purpose of [
      EModelPurpose.Main,
      EModelPurpose.SpecialistAccurate,
      EModelPurpose.ScheduledTask,
    ]) {
      expect(getAiModelConfig(EAiProvider.Openrouter, purpose).effort).toBe("medium");
    }

    expect(getAiModelConfig(EAiProvider.OpencodeGo, EModelPurpose.Utility).effort).toBeUndefined();
    expect(getAiModelConfig(EAiProvider.OpencodeGo, EModelPurpose.SpecialistAccurate).effort).toBe(
      "medium",
    );

    for (const purpose of [
      EModelPurpose.Main,
      EModelPurpose.Specialist,
      EModelPurpose.ScheduledTask,
    ]) {
      expect(getAiModelConfig(EAiProvider.OpencodeGo, purpose).effort).toBe("high");
    }

    for (const purpose of Object.values(EModelPurpose)) {
      expect(getAiModelConfig(EAiProvider.Ollama, purpose).effort).toBeUndefined();
    }
  });

  test("reads required API keys from Bun.env and rejects missing keys", () => {
    Bun.env.OPENROUTER_API_KEY = "openrouter-test-key";
    Bun.env.OPENCODE_API_KEY = "opencode-test-key";

    expect(getAiApiKey(EAiProvider.Openrouter)).toBe("openrouter-test-key");
    expect(getAiApiKey(EAiProvider.OpencodeGo)).toBe("opencode-test-key");
    expect(getAiApiKey(EAiProvider.OpenaiCodex)).toBeUndefined();
    expect(getAiApiKey(EAiProvider.Ollama)).toBeUndefined();

    Bun.env.OPENROUTER_API_KEY = undefined;
    Bun.env.OPENCODE_API_KEY = "";

    expect(() => getAiApiKey(EAiProvider.Openrouter)).toThrow("OPENROUTER_API_KEY");
    expect(() => getAiApiKey(EAiProvider.OpencodeGo)).toThrow("OPENCODE_API_KEY");
  });

  test("stores static Ollama metadata and keyless compatibility auth", async () => {
    const provider = aiModels.getProvider(EAiProvider.Ollama);

    if (provider === undefined) {
      throw new Error("Ollama provider not registered");
    }

    expect(provider.baseUrl?.endsWith("/v1")).toBe(true);

    for (const model of aiModels.getModels(EAiProvider.Ollama)) {
      if (!hasApi(model, "openai-completions")) {
        throw new Error(`Unexpected Ollama API: ${model.api}`);
      }

      expect(model.api).toBe("openai-completions");
      expect(model.reasoning).toBe(true);
      expect(model.input).toEqual(["text"]);
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxTokens).toBeGreaterThan(0);
      expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(model.compat?.supportsDeveloperRole).toBe(false);
      expect(model.compat?.supportsReasoningEffort).toBe(false);
      expect(model.compat?.maxTokensField).toBe("max_tokens");
    }

    const auth = await aiModels.getAuth(
      getAiModelConfig(EAiProvider.Ollama, EModelPurpose.Main).model,
    );
    expect(auth?.auth.apiKey).toBe("ollama");
  });
});

describe("OpenCode Go catalog refresh", () => {
  let previousProvider = aiModels.getProvider(EAiProvider.OpencodeGo);
  let fetchMock: Mock<(input: Parameters<typeof fetch>[0]) => Promise<Response>>;
  let liveModel = "";

  function catalogResponse(input: Parameters<typeof fetch>[0]) {
    if (String(input).endsWith("/models")) {
      return Response.json({ data: [{ id: liveModel }] });
    }
    return Response.json({
      "opencode-go": {
        models: {
          [liveModel]: {
            name: "Current model",
            tool_call: true,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 1000000, output: 64000 },
            cost: { input: 1, output: 5 },
          },
        },
      },
    });
  }

  // The models collection is shared by every test file, so its stored catalog must not leak.
  async function dropStoredCatalog() {
    aiModels.setProvider({
      ...opencodeGoProvider([]),
      refreshModels: async (context) => {
        await context.publish({ persist: null });
      },
    });
    await aiModels.refresh({ providers: [EAiProvider.OpencodeGo], allowNetwork: false });
  }

  beforeEach(async () => {
    Bun.env.OPENCODE_API_KEY = "catalog-test-key";
    previousProvider = aiModels.getProvider(EAiProvider.OpencodeGo);
    await dropStoredCatalog();
    aiModels.setProvider(opencodeGoProvider(["grok-4.7", "deepseek-v4-pro"]));
    fetchMock = spyOn(globalThis, "fetch");
    fetchMock.mockImplementation(async (input) => catalogResponse(input));
  });

  afterEach(async () => {
    fetchMock.mockRestore();
    await dropStoredCatalog();
    if (previousProvider !== undefined) {
      aiModels.setProvider(previousProvider);
    }
  });

  test("keeps a shared refresh running when its first caller cancels", async () => {
    liveModel = "completions-shared";
    const release = Promise.withResolvers<void>();
    fetchMock.mockImplementation(async (input) => {
      await release.promise;
      return catalogResponse(input);
    });
    const controller = new AbortController();
    const cancelled = refreshAiModels(EAiProvider.OpencodeGo, true, controller.signal);
    const waiting = refreshAiModels(EAiProvider.OpencodeGo, true);
    controller.abort();
    await cancelled;
    release.resolve();
    await waiting;
    expect(aiModels.getModel(EAiProvider.OpencodeGo, liveModel)).toBeDefined();
  });

  test("lets a forced caller cancel while it waits behind another refresh", async () => {
    liveModel = "completions-queued";
    const release = Promise.withResolvers<void>();
    fetchMock.mockImplementation(async (input) => {
      await release.promise;
      return catalogResponse(input);
    });
    const running = refreshAiModels(EAiProvider.OpencodeGo);
    const controller = new AbortController();
    const queued = refreshAiModels(EAiProvider.OpencodeGo, true, controller.signal);
    controller.abort();
    await queued;
    release.resolve();
    await running;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("runs a forced refresh after an in-flight refresh that skipped the network", async () => {
    liveModel = "completions-cached";
    await refreshAiModels(EAiProvider.OpencodeGo, true);
    fetchMock.mockClear();
    liveModel = "completions-forced";
    await Promise.all([
      refreshAiModels(EAiProvider.OpencodeGo),
      refreshAiModels(EAiProvider.OpencodeGo, true),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(aiModels.getModel(EAiProvider.OpencodeGo, liveModel)).toBeDefined();
  });
});
