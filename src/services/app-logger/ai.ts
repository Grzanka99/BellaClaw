import type { TOption } from "../../types";
import { EAiProvider, EModelPurpose } from "../ai/types";
import { EConfigKey, type TConfigRecord } from "../settings/schema";

export type TAiBehaviorFields = {
  provider: EAiProvider;
  model: string;
  purpose: EModelPurpose;
};

type TModelProvider = EAiProvider.Ollama | EAiProvider.Openrouter | EAiProvider.OpencodeGo;

const MODEL_KEYS_BY_PROVIDER: Record<TModelProvider, Record<EModelPurpose, EConfigKey>> = {
  [EAiProvider.Ollama]: {
    [EModelPurpose.ToolCheap]: EConfigKey.AiProvidersOllamaModelsToolCheap,
    [EModelPurpose.ToolAccurate]: EConfigKey.AiProvidersOllamaModelsToolAccurate,
    [EModelPurpose.General]: EConfigKey.AiProvidersOllamaModelsGeneral,
    [EModelPurpose.Chat]: EConfigKey.AiProvidersOllamaModelsChat,
    [EModelPurpose.ChatAccurate]: EConfigKey.AiProvidersOllamaModelsChatAccurate,
  },
  [EAiProvider.Openrouter]: {
    [EModelPurpose.ToolCheap]: EConfigKey.AiProvidersOpenrouterModelsToolCheap,
    [EModelPurpose.ToolAccurate]: EConfigKey.AiProvidersOpenrouterModelsToolAccurate,
    [EModelPurpose.General]: EConfigKey.AiProvidersOpenrouterModelsGeneral,
    [EModelPurpose.Chat]: EConfigKey.AiProvidersOpenrouterModelsChat,
    [EModelPurpose.ChatAccurate]: EConfigKey.AiProvidersOpenrouterModelsChatAccurate,
  },
  [EAiProvider.OpencodeGo]: {
    [EModelPurpose.ToolCheap]: EConfigKey.AiProvidersOpencodeGoModelsToolCheap,
    [EModelPurpose.ToolAccurate]: EConfigKey.AiProvidersOpencodeGoModelsToolAccurate,
    [EModelPurpose.General]: EConfigKey.AiProvidersOpencodeGoModelsGeneral,
    [EModelPurpose.Chat]: EConfigKey.AiProvidersOpencodeGoModelsChat,
    [EModelPurpose.ChatAccurate]: EConfigKey.AiProvidersOpencodeGoModelsChatAccurate,
  },
};

export function resolveAiBehaviorFields(
  settings: TConfigRecord,
  purpose: EModelPurpose,
): TOption<TAiBehaviorFields> {
  const provider = settings[EConfigKey.AiProvider];

  if (provider === EAiProvider.Ollama) {
    return { provider, model: resolveModel(settings, provider, purpose), purpose };
  }

  if (provider === EAiProvider.Openrouter) {
    return { provider, model: resolveModel(settings, provider, purpose), purpose };
  }

  if (provider === EAiProvider.OpencodeGo) {
    return { provider, model: resolveModel(settings, provider, purpose), purpose };
  }

  return undefined;
}

function resolveModel(
  settings: TConfigRecord,
  provider: TModelProvider,
  purpose: EModelPurpose,
): string {
  return settings[MODEL_KEYS_BY_PROVIDER[provider][purpose]];
}
