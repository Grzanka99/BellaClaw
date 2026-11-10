import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { obj, type Static } from "@earendil-works/pi-schema";
import { EConfigKey, type TConfigRecord } from "../../../settings/schema";
import { decodeAiModelPreferences } from "../../model-preferences";
import { aiModels, getAiModelConfigs, supportsAiServiceTier } from "../../providers/registry";
import { type EAiProvider, SAiProvider } from "../../types";

export const SGetSettingsArgs = obj({});

export type TGetSettingsArgs = Static<typeof SGetSettingsArgs>;

export function resolveAiProvider(settings: TConfigRecord): EAiProvider {
  const provider = SAiProvider.safeParse(settings[EConfigKey.AiProvider]);

  if (!provider.success) {
    throw new Error("Configured AI provider is invalid");
  }

  return provider.data;
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
        supportsServiceTier: supportsAiServiceTier(model),
      })),
    };
  }

  return runtime;
}
