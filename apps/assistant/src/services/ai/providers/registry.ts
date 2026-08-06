import type { TOption } from "@bellaclaw/shared";
import {
  type Api,
  createModels,
  getSupportedThinkingLevels,
  type Model,
  type Provider,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { FileCredentialStore } from "../auth/file-credential-store";
import { EAiProvider, EModelPurpose } from "../types";
import { ollamaProvider } from "./ollama";

type TAiModelPurposeRegistration = {
  model: string;
  effort?: ThinkingLevel;
};

type TAiProviderRegistration = {
  createProvider: () => Provider;
  modelByPurpose: Record<EModelPurpose, TAiModelPurposeRegistration>;
  getApiKey: () => TOption<string>;
};

const AI_PROVIDER_REGISTRY: Record<EAiProvider, TAiProviderRegistration> = {
  [EAiProvider.OpenaiCodex]: {
    createProvider: openaiCodexProvider,
    modelByPurpose: {
      [EModelPurpose.Utility]: { model: "gpt-5.6-luna", effort: "low" },
      [EModelPurpose.Main]: { model: "gpt-5.6-sol", effort: "medium" },
      [EModelPurpose.Specialist]: { model: "gpt-5.6-luna", effort: "max" },
      [EModelPurpose.SpecialistAccurate]: { model: "gpt-5.6-luna", effort: "max" },
      [EModelPurpose.ScheduledTask]: { model: "gpt-5.6-luna", effort: "max" },
    },
    getApiKey: () => undefined,
  },
  [EAiProvider.Openrouter]: {
    createProvider: openrouterProvider,
    modelByPurpose: {
      [EModelPurpose.Utility]: { model: "openai/gpt-5.4-nano", effort: "low" },
      [EModelPurpose.Main]: {
        model: "google/gemini-3.1-pro-preview",
        effort: "medium",
      },
      [EModelPurpose.Specialist]: {
        model: "google/gemini-3-flash-preview",
        effort: "high",
      },
      [EModelPurpose.SpecialistAccurate]: {
        model: "google/gemini-3.1-pro-preview",
        effort: "medium",
      },
      [EModelPurpose.ScheduledTask]: {
        model: "google/gemini-3.1-pro-preview",
        effort: "medium",
      },
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
      [EModelPurpose.Utility]: { model: "nemotron-3-super:cloud" },
      [EModelPurpose.Main]: { model: "minimax-m2.7:cloud" },
      [EModelPurpose.Specialist]: { model: "minimax-m2.7:cloud" },
      [EModelPurpose.SpecialistAccurate]: { model: "minimax-m2.7:cloud" },
      [EModelPurpose.ScheduledTask]: { model: "minimax-m2.7:cloud" },
    },
    getApiKey: () => undefined,
  },
  [EAiProvider.OpencodeGo]: {
    createProvider: opencodeGoProvider,
    modelByPurpose: {
      [EModelPurpose.Utility]: { model: "deepseek-v4-flash" },
      [EModelPurpose.Main]: { model: "grok-4.5", effort: "high" },
      [EModelPurpose.Specialist]: { model: "deepseek-v4-pro", effort: "high" },
      [EModelPurpose.SpecialistAccurate]: {
        model: "grok-4.5",
        effort: "medium",
      },
      [EModelPurpose.ScheduledTask]: { model: "deepseek-v4-pro", effort: "high" },
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

export const aiModels = createModels({ credentials: new FileCredentialStore() });

for (const providerId of Object.values(EAiProvider)) {
  const registration = AI_PROVIDER_REGISTRY[providerId];
  aiModels.setProvider(registration.createProvider());

  for (const purpose of Object.values(EModelPurpose)) {
    const modelId = registration.modelByPurpose[purpose].model;
    const model = aiModels.getModel(providerId, modelId);

    if (model === undefined) {
      throw new Error(
        `AI registry model not found: provider=${providerId}, purpose=${purpose}, model=${modelId}`,
      );
    }

    const effort = registration.modelByPurpose[purpose].effort;

    if (effort !== undefined && !getSupportedThinkingLevels(model).includes(effort)) {
      throw new Error(
        `AI registry effort not supported: provider=${providerId}, purpose=${purpose}, model=${modelId}, effort=${effort}`,
      );
    }
  }
}

export function getAiModel(provider: EAiProvider, purpose: EModelPurpose): Model<Api> {
  return getAiModelConfig(provider, purpose).model;
}

export function getAiModelConfig(provider: EAiProvider, purpose: EModelPurpose) {
  const registration = AI_PROVIDER_REGISTRY[provider].modelByPurpose[purpose];
  const model = aiModels.getModel(provider, registration.model);

  if (model === undefined) {
    throw new Error(
      `AI registry model not found: provider=${provider}, purpose=${purpose}, model=${registration.model}`,
    );
  }

  return { model, effort: registration.effort };
}

export function getAiModelIds(provider: EAiProvider): Readonly<Record<EModelPurpose, string>> {
  const modelByPurpose = AI_PROVIDER_REGISTRY[provider].modelByPurpose;

  return {
    [EModelPurpose.Utility]: modelByPurpose[EModelPurpose.Utility].model,
    [EModelPurpose.Main]: modelByPurpose[EModelPurpose.Main].model,
    [EModelPurpose.Specialist]: modelByPurpose[EModelPurpose.Specialist].model,
    [EModelPurpose.SpecialistAccurate]: modelByPurpose[EModelPurpose.SpecialistAccurate].model,
    [EModelPurpose.ScheduledTask]: modelByPurpose[EModelPurpose.ScheduledTask].model,
  };
}

export function getAiApiKey(provider: EAiProvider): TOption<string> {
  return AI_PROVIDER_REGISTRY[provider].getApiKey();
}
