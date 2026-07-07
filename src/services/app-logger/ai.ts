import type { TOption } from "../../types";
import { EAiProvider, EModelPurpose } from "../ai/types";
import { EConfigKey, type TConfigRecord } from "../settings/schema";

export type TAiBehaviorFields = {
  provider: EAiProvider;
  model: string;
  purpose: EModelPurpose;
};

export function resolveAiBehaviorFields(
  settings: TConfigRecord,
  purpose: EModelPurpose,
): TOption<TAiBehaviorFields> {
  const provider = settings[EConfigKey.AiProvider];

  if (provider === EAiProvider.Ollama) {
    return { provider, model: resolveOllamaModel(settings, purpose), purpose };
  }

  if (provider === EAiProvider.Openrouter) {
    return { provider, model: resolveOpenrouterModel(settings, purpose), purpose };
  }

  if (provider === EAiProvider.OpencodeGo) {
    return { provider, model: resolveOpencodeGoModel(settings, purpose), purpose };
  }

  return undefined;
}

function resolveOllamaModel(settings: TConfigRecord, purpose: EModelPurpose): string {
  switch (purpose) {
    case EModelPurpose.ToolCheap: {
      return settings[EConfigKey.AiProvidersOllamaModelsToolCheap];
    }
    case EModelPurpose.ToolAccurate: {
      return settings[EConfigKey.AiProvidersOllamaModelsToolAccurate];
    }
    case EModelPurpose.General: {
      return settings[EConfigKey.AiProvidersOllamaModelsGeneral];
    }
    case EModelPurpose.Chat: {
      return settings[EConfigKey.AiProvidersOllamaModelsChat];
    }
    case EModelPurpose.ChatAccurate: {
      return settings[EConfigKey.AiProvidersOllamaModelsChatAccurate];
    }
  }
}

function resolveOpenrouterModel(settings: TConfigRecord, purpose: EModelPurpose): string {
  switch (purpose) {
    case EModelPurpose.ToolCheap: {
      return settings[EConfigKey.AiProvidersOpenrouterModelsToolCheap];
    }
    case EModelPurpose.ToolAccurate: {
      return settings[EConfigKey.AiProvidersOpenrouterModelsToolAccurate];
    }
    case EModelPurpose.General: {
      return settings[EConfigKey.AiProvidersOpenrouterModelsGeneral];
    }
    case EModelPurpose.Chat: {
      return settings[EConfigKey.AiProvidersOpenrouterModelsChat];
    }
    case EModelPurpose.ChatAccurate: {
      return settings[EConfigKey.AiProvidersOpenrouterModelsChatAccurate];
    }
  }
}

function resolveOpencodeGoModel(settings: TConfigRecord, purpose: EModelPurpose): string {
  switch (purpose) {
    case EModelPurpose.ToolCheap: {
      return settings[EConfigKey.AiProvidersOpencodeGoModelsToolCheap];
    }
    case EModelPurpose.ToolAccurate: {
      return settings[EConfigKey.AiProvidersOpencodeGoModelsToolAccurate];
    }
    case EModelPurpose.General: {
      return settings[EConfigKey.AiProvidersOpencodeGoModelsGeneral];
    }
    case EModelPurpose.Chat: {
      return settings[EConfigKey.AiProvidersOpencodeGoModelsChat];
    }
    case EModelPurpose.ChatAccurate: {
      return settings[EConfigKey.AiProvidersOpencodeGoModelsChatAccurate];
    }
  }
}
