import { getSupportedThinkingLevels, type Static, Type } from "@earendil-works/pi-ai";
import { EConfigKey, type TConfigRecord } from "../../../settings/schema";
import { decodeAiModelPreferences } from "../../model-preferences";
import { aiModels, getAiModelConfigs } from "../../providers/registry";
import { EAiProvider } from "../../types";

export const SGetSettingsArgs = Type.Object({}, { additionalProperties: false });

export type TGetSettingsArgs = Static<typeof SGetSettingsArgs>;

export function resolveAiProvider(settings: TConfigRecord): EAiProvider {
  const provider = settings[EConfigKey.AiProvider];

  switch (provider) {
    case EAiProvider.OpenaiCodex:
    case EAiProvider.Openrouter:
    case EAiProvider.Ollama:
    case EAiProvider.OpencodeGo:
      return provider;
    default:
      throw new Error("Configured AI provider is invalid");
  }
}

export function createAiRuntime(settings: TConfigRecord, includeAvailableModels: boolean) {
  const provider = resolveAiProvider(settings);
  const preferences = decodeAiModelPreferences(settings[EConfigKey.AiModelPreferences]);
  const runtime = {
    provider,
    models: getAiModelConfigs(provider, preferences),
  };

  if (includeAvailableModels) {
    return {
      ...runtime,
      availableModels: aiModels.getModels(provider).map((model) => ({
        name: model.name,
        id: model.id,
        supportedEfforts: getSupportedThinkingLevels(model),
      })),
    };
  }

  return runtime;
}
