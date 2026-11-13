import type { TOption } from "@bellaclaw/shared";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { SettingsService, type TConfigUpdate } from "../../../settings";
import { EConfigKey, type TConfigRecord } from "../../../settings/schema";
import {
  decodeAiModelPreferences,
  encodeAiModelPreferences,
  getAiModelPreference,
  setAiModelPreference,
  type TAiModelPreferences,
} from "../../model-preferences";
import {
  aiModels,
  getAiModelConfig,
  refreshAiModels,
  supportsAiServiceTier,
} from "../../providers/registry";
import { type EAiProvider, EModelPurpose } from "../../types";
import { resolveAiProvider } from "../get-settings";

// the AI arguments of the update-settings tool
export type TAiSettingsArgs = {
  aiProvider?: EAiProvider;
  aiModel?: string;
  aiModelPurpose?: EModelPurpose;
  aiReasoningEffort?: ModelThinkingLevel;
  aiServiceTier?: "default" | "flex" | "priority";
  resetAiModel?: boolean;
  resetAiReasoningEffort?: boolean;
};

export function validateAiSettingsArgs(args: TAiSettingsArgs): boolean {
  const hasModelOperation =
    args.aiModel !== undefined ||
    args.aiReasoningEffort !== undefined ||
    args.aiServiceTier !== undefined ||
    args.resetAiModel === true ||
    args.resetAiReasoningEffort === true;

  if (args.aiModelPurpose !== undefined && !hasModelOperation) {
    throw new Error("aiModelPurpose requires a model or reasoning-effort change");
  }

  if (
    args.resetAiModel === true &&
    (args.aiModel !== undefined ||
      args.aiReasoningEffort !== undefined ||
      args.aiServiceTier !== undefined ||
      args.resetAiReasoningEffort === true)
  ) {
    throw new Error("resetAiModel cannot be combined with another model change");
  }

  if (args.resetAiReasoningEffort === true && args.aiReasoningEffort !== undefined) {
    throw new Error("Choose aiReasoningEffort or resetAiReasoningEffort, not both");
  }

  return hasModelOperation;
}

// Resolves, checks and verifies an AI settings change. The config updates that save it are
// appended to updates, next to the other updates of the same command.
export async function prepareAiSettingsUpdate(
  chatId: string,
  args: TAiSettingsArgs,
  hasModelOperation: boolean,
  updates: TConfigUpdate[],
  verifySettings: (settings: TConfigRecord, purposes: EModelPurpose[]) => Promise<TOption<string>>,
) {
  const settings = await SettingsService.instance.getAll(chatId);
  const currentProvider = resolveAiProvider(settings);
  let provider = currentProvider;

  if (args.aiProvider !== undefined) {
    provider = args.aiProvider;
    updates.push({ key: EConfigKey.AiProvider, value: provider });
  }

  if (hasModelOperation || args.aiProvider !== undefined) {
    const forceRefresh =
      args.aiModel !== undefined && aiModels.getModel(provider, args.aiModel) === undefined;
    await refreshAiModels(provider, forceRefresh);
  }
  let purpose: TOption<EModelPurpose>;
  const preferences = decodeAiModelPreferences(settings[EConfigKey.AiModelPreferences]);
  const fallbacks: Array<{ purpose: EModelPurpose; reason: string }> = [];

  if (hasModelOperation) {
    purpose = EModelPurpose.Main;

    if (args.aiModelPurpose !== undefined) {
      purpose = args.aiModelPurpose;
    }

    if (args.resetAiModel === true) {
      setAiModelPreference(preferences, provider, purpose, undefined);
    } else {
      const currentConfig = getAiModelConfig(
        provider,
        purpose,
        getAiModelPreference(preferences, provider, purpose),
      );
      let modelId = currentConfig.model.id;

      if (args.aiModel !== undefined) {
        modelId = args.aiModel;
      }

      const model = aiModels.getModel(provider, modelId);

      if (model === undefined) {
        throw new Error(`Model "${modelId}" is not available from provider "${provider}"`);
      }

      let effort = currentConfig.effort;

      if (args.resetAiReasoningEffort === true) {
        effort = getAiModelConfig(provider, purpose, { model: modelId }).effort;
      } else if (args.aiReasoningEffort !== undefined) {
        effort = args.aiReasoningEffort;
      }

      if (effort !== undefined && !getSupportedThinkingLevels(model).includes(effort)) {
        fallbacks.push({
          purpose,
          reason: `Effort ${effort} is unsupported by ${modelId}; using the model default`,
        });
        effort = getAiModelConfig(provider, purpose, { model: modelId }).effort;
      }

      let serviceTier = currentConfig.serviceTier;

      if (args.aiServiceTier === "default") {
        serviceTier = undefined;
      } else if (args.aiServiceTier !== undefined) {
        if (!supportsAiServiceTier(model)) {
          throw new Error(`Service tier is unsupported by ${modelId}`);
        }

        serviceTier = args.aiServiceTier;
      }

      if (serviceTier !== undefined && !supportsAiServiceTier(model)) {
        fallbacks.push({
          purpose,
          reason: `Service tier ${serviceTier} is unsupported by ${modelId}; using the default tier`,
        });
        serviceTier = undefined;
      }

      const defaultConfig = getAiModelConfig(provider, purpose);

      if (
        modelId === defaultConfig.model.id &&
        effort === defaultConfig.effort &&
        serviceTier === undefined
      ) {
        setAiModelPreference(preferences, provider, purpose, undefined);
      } else {
        setAiModelPreference(preferences, provider, purpose, {
          model: modelId,
          effort,
          serviceTier,
        });
      }
    }
  }

  if (args.aiProvider !== undefined) {
    fallbacks.push(...normalizeProviderPreferences(provider, preferences));
  }

  if (updates.length === 0 && !hasModelOperation) {
    throw new Error("Provide at least one field to update");
  }

  const nextSettings = { ...settings };

  for (const update of updates) {
    nextSettings[update.key] = update.value;
  }

  nextSettings[EConfigKey.AiModelPreferences] = encodeAiModelPreferences(preferences);
  const purposes: EModelPurpose[] = [];

  if (args.aiProvider !== undefined) {
    purposes.push(...Object.values(EModelPurpose));
  } else if (purpose !== undefined) {
    purposes.push(purpose);
  }

  const verifications = new Map<string, Promise<TOption<string>>>();
  const results = await Promise.all(
    purposes.map(async (verificationPurpose) => {
      const { model, effort, serviceTier } = getAiModelConfig(
        provider,
        verificationPurpose,
        getAiModelPreference(preferences, provider, verificationPurpose),
      );
      const key = JSON.stringify([model.id, effort, serviceTier]);
      let verification = verifications.get(key);

      if (verification === undefined) {
        verification = verifySettings(nextSettings, [verificationPurpose]);
        verifications.set(key, verification);
      }

      return { purpose: verificationPurpose, error: await verification };
    }),
  );

  for (const { purpose: verificationPurpose, error } of results) {
    if (error === undefined) {
      continue;
    }

    const isExplicitModelChange = hasModelOperation && verificationPurpose === purpose;
    const rememberedPreference = getAiModelPreference(preferences, provider, verificationPurpose);

    if (
      isExplicitModelChange ||
      args.aiProvider === undefined ||
      rememberedPreference === undefined
    ) {
      throw new Error(error);
    }

    setAiModelPreference(preferences, provider, verificationPurpose, undefined);
    nextSettings[EConfigKey.AiModelPreferences] = encodeAiModelPreferences(preferences);
    const fallbackError = await verifySettings(nextSettings, [verificationPurpose]);

    if (fallbackError !== undefined) {
      throw new Error(fallbackError);
    }

    fallbacks.push({
      purpose: verificationPurpose,
      reason: `Remembered model failed verification; using the provider default`,
    });
  }

  const encodedPreferences = encodeAiModelPreferences(preferences);

  if (encodedPreferences !== settings[EConfigKey.AiModelPreferences]) {
    updates.push({ key: EConfigKey.AiModelPreferences, value: encodedPreferences });
  }

  return { settings, purpose, fallbacks };
}

function normalizeProviderPreferences(provider: EAiProvider, preferences: TAiModelPreferences) {
  const fallbacks: Array<{ purpose: EModelPurpose; reason: string }> = [];

  for (const purpose of Object.values(EModelPurpose)) {
    const preference = getAiModelPreference(preferences, provider, purpose);

    if (preference === undefined) {
      continue;
    }

    const model = aiModels.getModel(provider, preference.model);

    if (model === undefined) {
      setAiModelPreference(preferences, provider, purpose, undefined);
      fallbacks.push({ purpose, reason: `Remembered model ${preference.model} is unavailable` });
      continue;
    }

    if (
      preference.effort !== undefined &&
      !getSupportedThinkingLevels(model).includes(preference.effort)
    ) {
      setAiModelPreference(preferences, provider, purpose, {
        model: preference.model,
        serviceTier: preference.serviceTier,
      });
      fallbacks.push({
        purpose,
        reason: `Remembered effort ${preference.effort} is unsupported by ${preference.model}`,
      });
    }
  }

  return fallbacks;
}
