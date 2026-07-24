import { afterEach, describe, expect, test } from "bun:test";
import { hasApi } from "@earendil-works/pi-ai";
import { EAiProvider, EModelPurpose } from "../types";
import { aiModels, getAiApiKey, getAiModel, getAiModelConfig, getAiModelIds } from "./registry";

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
      const ids = getAiModelIds(provider);

      for (const purpose of Object.values(EModelPurpose)) {
        expect(getAiModel(provider, purpose).id).toBe(ids[purpose]);
      }
    }

    expect(aiModels.getModel(EAiProvider.Openrouter, "unknown-model")).toBeUndefined();
  });

  test("maps every role purpose to its configured model", () => {
    expect(getAiModelIds(EAiProvider.OpenaiCodex)).toEqual({
      [EModelPurpose.Utility]: "gpt-5.6-luna",
      [EModelPurpose.Main]: "gpt-5.6-sol",
      [EModelPurpose.Specialist]: "gpt-5.6-luna",
      [EModelPurpose.SpecialistAccurate]: "gpt-5.6-luna",
      [EModelPurpose.ScheduledTask]: "gpt-5.6-luna",
    });
    expect(getAiModelIds(EAiProvider.Openrouter)).toEqual({
      [EModelPurpose.Utility]: "openai/gpt-5.4-nano",
      [EModelPurpose.Main]: "google/gemini-3.1-pro-preview",
      [EModelPurpose.Specialist]: "google/gemini-3-flash-preview",
      [EModelPurpose.SpecialistAccurate]: "google/gemini-3.1-pro-preview",
      [EModelPurpose.ScheduledTask]: "google/gemini-3.1-pro-preview",
    });
    expect(getAiModelIds(EAiProvider.OpencodeGo)).toEqual({
      [EModelPurpose.Utility]: "deepseek-v4-flash",
      [EModelPurpose.Main]: "grok-4.5",
      [EModelPurpose.Specialist]: "deepseek-v4-pro",
      [EModelPurpose.SpecialistAccurate]: "grok-4.5",
      [EModelPurpose.ScheduledTask]: "deepseek-v4-pro",
    });
    expect(getAiModelIds(EAiProvider.Ollama)).toEqual({
      [EModelPurpose.Utility]: "nemotron-3-super:cloud",
      [EModelPurpose.Main]: "minimax-m2.7:cloud",
      [EModelPurpose.Specialist]: "minimax-m2.7:cloud",
      [EModelPurpose.SpecialistAccurate]: "minimax-m2.7:cloud",
      [EModelPurpose.ScheduledTask]: "minimax-m2.7:cloud",
    });
  });

  test("pairs each model purpose with its reasoning effort", () => {
    expect(getAiModelConfig(EAiProvider.OpenaiCodex, EModelPurpose.Utility).effort).toBe("low");
    expect(getAiModelConfig(EAiProvider.OpenaiCodex, EModelPurpose.Main).effort).toBe("medium");

    for (const purpose of [
      EModelPurpose.Specialist,
      EModelPurpose.SpecialistAccurate,
      EModelPurpose.ScheduledTask,
    ]) {
      expect(getAiModelConfig(EAiProvider.OpenaiCodex, purpose).effort).toBe("max");
    }

    expect(getAiModelConfig(EAiProvider.Openrouter, EModelPurpose.Utility).effort).toBe("low");
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

    const auth = await aiModels.getAuth(getAiModel(EAiProvider.Ollama, EModelPurpose.Main));
    expect(auth?.auth.apiKey).toBe("ollama");
  });
});
