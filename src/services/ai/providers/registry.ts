import { type Api, createModels, type Model, type Provider } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { TOption } from "../../../types";
import { EAiProvider, EModelPurpose } from "../types";
import { ollamaProvider } from "./ollama";

type TAiProviderRegistration = {
  createProvider: () => Provider;
  modelByPurpose: Record<EModelPurpose, string>;
  getApiKey: () => TOption<string>;
};

const AI_PROVIDER_REGISTRY: Record<EAiProvider, TAiProviderRegistration> = {
  [EAiProvider.Openrouter]: {
    createProvider: openrouterProvider,
    modelByPurpose: {
      [EModelPurpose.ToolCheap]: "openai/gpt-5.4-nano",
      [EModelPurpose.ToolAccurate]: "google/gemini-3-flash-preview",
      [EModelPurpose.General]: "openrouter/free",
      [EModelPurpose.Chat]: "openai/gpt-5.4-mini",
      [EModelPurpose.ChatAccurate]: "google/gemini-3.1-pro-preview",
    },
    getApiKey: () => {
      const apiKey = Bun.env.OPENROUTER_API_KEY;

      if (apiKey === undefined || apiKey.trim().length === 0) {
        throw new Error("Missing required environment variable OPENROUTER_API_KEY");
      }

      return apiKey;
    },
  },
  [EAiProvider.Ollama]: {
    createProvider: ollamaProvider,
    modelByPurpose: {
      [EModelPurpose.ToolCheap]: "nemotron-3-super:cloud",
      [EModelPurpose.ToolAccurate]: "minimax-m2.7:cloud",
      [EModelPurpose.General]: "glm-5:cloud",
      [EModelPurpose.Chat]: "minimax-m2.7:cloud",
      [EModelPurpose.ChatAccurate]: "minimax-m2.7:cloud",
    },
    getApiKey: () => undefined,
  },
  [EAiProvider.OpencodeGo]: {
    createProvider: opencodeGoProvider,
    modelByPurpose: {
      [EModelPurpose.ToolCheap]: "deepseek-v4-flash",
      [EModelPurpose.ToolAccurate]: "glm-5.2",
      [EModelPurpose.General]: "deepseek-v4-pro",
      [EModelPurpose.Chat]: "glm-5.2",
      [EModelPurpose.ChatAccurate]: "glm-5.2",
    },
    getApiKey: () => {
      const apiKey = Bun.env.OPENCODE_API_KEY;

      if (apiKey === undefined || apiKey.trim().length === 0) {
        throw new Error("Missing required environment variable OPENCODE_API_KEY");
      }

      return apiKey;
    },
  },
};

export const aiModels = createModels();

for (const providerId of Object.values(EAiProvider)) {
  const registration = AI_PROVIDER_REGISTRY[providerId];
  aiModels.setProvider(registration.createProvider());

  for (const purpose of Object.values(EModelPurpose)) {
    const modelId = registration.modelByPurpose[purpose];
    const model = aiModels.getModel(providerId, modelId);

    if (model === undefined) {
      throw new Error(
        `AI registry model not found: provider=${providerId}, purpose=${purpose}, model=${modelId}`,
      );
    }
  }
}

export function getAiModel(provider: EAiProvider, purpose: EModelPurpose): Model<Api> {
  const modelId = AI_PROVIDER_REGISTRY[provider].modelByPurpose[purpose];
  const model = aiModels.getModel(provider, modelId);

  if (model === undefined) {
    throw new Error(
      `AI registry model not found: provider=${provider}, purpose=${purpose}, model=${modelId}`,
    );
  }

  return model;
}

export function getAiModelIds(provider: EAiProvider): Readonly<Record<EModelPurpose, string>> {
  return { ...AI_PROVIDER_REGISTRY[provider].modelByPurpose };
}

export function getAiApiKey(provider: EAiProvider): TOption<string> {
  return AI_PROVIDER_REGISTRY[provider].getApiKey();
}
