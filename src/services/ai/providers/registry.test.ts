import { afterEach, describe, expect, test } from "bun:test";
import { hasApi } from "@earendil-works/pi-ai";
import { EAiProvider, EModelPurpose } from "../types";
import { aiModels, getAiApiKey, getAiModel, getAiModelIds } from "./registry";

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

  test("keeps the existing purpose mappings", () => {
    expect(getAiModelIds(EAiProvider.Openrouter)).toEqual({
      [EModelPurpose.ToolCheap]: "openai/gpt-5.4-nano",
      [EModelPurpose.ToolAccurate]: "google/gemini-3-flash-preview",
      [EModelPurpose.General]: "openrouter/free",
      [EModelPurpose.Chat]: "openai/gpt-5.4-mini",
      [EModelPurpose.ChatAccurate]: "google/gemini-3.1-pro-preview",
    });
    expect(getAiModelIds(EAiProvider.OpencodeGo)).toEqual({
      [EModelPurpose.ToolCheap]: "deepseek-v4-flash",
      [EModelPurpose.ToolAccurate]: "glm-5.2",
      [EModelPurpose.General]: "deepseek-v4-pro",
      [EModelPurpose.Chat]: "glm-5.2",
      [EModelPurpose.ChatAccurate]: "glm-5.2",
    });
    expect(getAiModelIds(EAiProvider.Ollama)).toEqual({
      [EModelPurpose.ToolCheap]: "nemotron-3-super:cloud",
      [EModelPurpose.ToolAccurate]: "minimax-m2.7:cloud",
      [EModelPurpose.General]: "glm-5:cloud",
      [EModelPurpose.Chat]: "minimax-m2.7:cloud",
      [EModelPurpose.ChatAccurate]: "minimax-m2.7:cloud",
    });
  });

  test("reads required API keys from Bun.env and rejects missing keys", () => {
    Bun.env.OPENROUTER_API_KEY = "openrouter-test-key";
    Bun.env.OPENCODE_API_KEY = "opencode-test-key";

    expect(getAiApiKey(EAiProvider.Openrouter)).toBe("openrouter-test-key");
    expect(getAiApiKey(EAiProvider.OpencodeGo)).toBe("opencode-test-key");
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

    const auth = await aiModels.getAuth(getAiModel(EAiProvider.Ollama, EModelPurpose.Chat));
    expect(auth?.auth.apiKey).toBe("ollama");
  });
});
