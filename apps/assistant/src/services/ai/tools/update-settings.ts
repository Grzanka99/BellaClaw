import type { TOption } from "@bellaclaw/shared";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { bool, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { SettingsService, type TConfigUpdate } from "../../settings";
import { ConfigValidators, EConfigKey } from "../../settings/schema";
import {
  decodeAiModelPreferences,
  encodeAiModelPreferences,
  getAiModelPreference,
  setAiModelPreference,
  type TAiModelPreferences,
} from "../model-preferences";
import {
  aiModels,
  getAiModelConfig,
  refreshAiModels,
  supportsAiServiceTier,
} from "../providers/registry";
import { EAiProvider, EModelPurpose } from "../types";
import { defineTool, requireChatId } from "./define-tool";
import { createAiRuntime, resolveAiProvider } from "./get-settings";
import instructions from "./update-settings.xml" with { type: "text" };

const SUpdateSettingsArgs = {
  ...obj({
    timezone: opt(
      str({
        minLength: 1,
        description: "Valid IANA timezone, such as Europe/Warsaw, America/New_York, or UTC",
      }),
    ),
    language: opt(
      str({
        minLength: 1,
        description: "Conversation language for assistant replies, such as Polish or English",
      }),
    ),
    assistantName: opt(str({ minLength: 1, description: "The assistant's display name" })),
    addressStyle: opt(
      str({ minLength: 1, description: "How the assistant should address the user" }),
    ),
    preferredReplyLength: opt(
      str({
        minLength: 1,
        description: "Preferred reply length, such as 1-3 sentences, short, or detailed",
      }),
    ),
    aiProvider: opt(
      oneOf(Object.values(EAiProvider), {
        description: "Active AI provider: openai-codex, openrouter, ollama, or opencode-go",
      }),
    ),
    aiModel: opt(
      str({
        minLength: 1,
        description: "Exact Pi model ID from the active or simultaneously requested provider",
      }),
    ),
    aiModelPurpose: opt(
      oneOf(Object.values(EModelPurpose), {
        description: "Model purpose to change. Defaults to Main when omitted",
      }),
    ),
    aiReasoningEffort: opt(oneOf(["off", "minimal", "low", "medium", "high", "xhigh", "max"])),
    aiServiceTier: opt(
      oneOf(["default", "flex", "priority"], {
        description:
          "OpenAI processing tier: priority is fast mode, flex is cheaper and slower, default clears it",
      }),
    ),
    resetAiModel: opt(
      bool({ description: "Reset the selected purpose to the provider registry default" }),
    ),
    resetAiReasoningEffort: opt(
      bool({ description: "Reset reasoning effort while keeping the selected model" }),
    ),
  }),
  minProperties: 1,
};

type TUpdateSettingsArgs = Static<typeof SUpdateSettingsArgs>;

function validateUpdateSettingsArgs(args: TUpdateSettingsArgs): void {
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
}

export const updateSettings = defineTool({
  name: "update-settings",
  label: "Update settings",
  description:
    "Updates the user's assistant settings, including provider, per-purpose model, reasoning effort, and service tier. Provide at least one field. Only provided fields change. For mixed settings and normal-task messages, apply the settings change and ask the user to resend the task separately.",
  schema: SUpdateSettingsArgs,
  instructions,
  mode: "sequential",
  logSafe: [["settings", "settingKeys"]],
  execute: async (context, parsedArgs) => {
    const chatId = requireChatId(context.chatId);
    validateUpdateSettingsArgs(parsedArgs);

    const updates: TConfigUpdate[] = [];
    const fields: Array<{ field: keyof TUpdateSettingsArgs; key: EConfigKey }> = [
      { field: "timezone", key: EConfigKey.AiInstructionsTimezone },
      { field: "language", key: EConfigKey.AiInstructionsLanguage },
      { field: "assistantName", key: EConfigKey.AiInstructionsAssistantName },
      { field: "addressStyle", key: EConfigKey.AiInstructionsAddressStyle },
      { field: "preferredReplyLength", key: EConfigKey.AiInstructionsPreferredReplyLength },
      { field: "aiProvider", key: EConfigKey.AiProvider },
    ];

    for (const field of fields) {
      const value = parsedArgs[field.field];

      if (value !== undefined) {
        const parsed = ConfigValidators[field.key].safeParse(value);

        if (!parsed.success) {
          throw new Error(`Invalid value for ${field.field}`);
        }

        updates.push({ key: field.key, value: parsed.data });
      }
    }

    const settings = await SettingsService.instance.getAll(chatId);
    const currentProvider = resolveAiProvider(settings);
    let provider = currentProvider;

    if (parsedArgs.aiProvider !== undefined) {
      provider = parsedArgs.aiProvider;
    }

    const hasModelOperation =
      parsedArgs.aiModel !== undefined ||
      parsedArgs.aiReasoningEffort !== undefined ||
      parsedArgs.aiServiceTier !== undefined ||
      parsedArgs.resetAiModel === true ||
      parsedArgs.resetAiReasoningEffort === true;
    if (hasModelOperation || parsedArgs.aiProvider !== undefined) {
      const forceRefresh =
        parsedArgs.aiModel !== undefined &&
        aiModels.getModel(provider, parsedArgs.aiModel) === undefined;
      await refreshAiModels(provider, forceRefresh);
    }
    let purpose: TOption<EModelPurpose>;
    const preferences = decodeAiModelPreferences(settings[EConfigKey.AiModelPreferences]);
    const fallbacks: Array<{ purpose: EModelPurpose; reason: string }> = [];

    if (hasModelOperation) {
      purpose = EModelPurpose.Main;

      if (parsedArgs.aiModelPurpose !== undefined) {
        purpose = parsedArgs.aiModelPurpose;
      }

      if (parsedArgs.resetAiModel === true) {
        setAiModelPreference(preferences, provider, purpose, undefined);
      } else {
        const currentConfig = getAiModelConfig(
          provider,
          purpose,
          getAiModelPreference(preferences, provider, purpose),
        );
        let modelId = currentConfig.model.id;

        if (parsedArgs.aiModel !== undefined) {
          modelId = parsedArgs.aiModel;
        }

        const model = aiModels.getModel(provider, modelId);

        if (model === undefined) {
          throw new Error(`Model "${modelId}" is not available from provider "${provider}"`);
        }

        let effort = currentConfig.effort;

        if (parsedArgs.resetAiReasoningEffort === true) {
          effort = getAiModelConfig(provider, purpose, { model: modelId }).effort;
        } else if (parsedArgs.aiReasoningEffort !== undefined) {
          effort = parsedArgs.aiReasoningEffort;
        }

        if (effort !== undefined && !getSupportedThinkingLevels(model).includes(effort)) {
          fallbacks.push({
            purpose,
            reason: `Effort ${effort} is unsupported by ${modelId}; using the model default`,
          });
          effort = getAiModelConfig(provider, purpose, { model: modelId }).effort;
        }

        let serviceTier = currentConfig.serviceTier;

        if (parsedArgs.aiServiceTier === "default") {
          serviceTier = undefined;
        } else if (parsedArgs.aiServiceTier !== undefined) {
          if (!supportsAiServiceTier(model)) {
            throw new Error(`Service tier is unsupported by ${modelId}`);
          }

          serviceTier = parsedArgs.aiServiceTier;
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

    if (parsedArgs.aiProvider !== undefined) {
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

    if (parsedArgs.aiProvider !== undefined) {
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
          verification = context.verifySettings(nextSettings, [verificationPurpose]);
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
        parsedArgs.aiProvider === undefined ||
        rememberedPreference === undefined
      ) {
        throw new Error(error);
      }

      setAiModelPreference(preferences, provider, verificationPurpose, undefined);
      nextSettings[EConfigKey.AiModelPreferences] = encodeAiModelPreferences(preferences);
      const fallbackError = await context.verifySettings(nextSettings, [verificationPurpose]);

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

    let savedSettings = settings;

    if (updates.length > 0) {
      savedSettings = await SettingsService.instance.setMany(chatId, updates);
    }

    return {
      settings: savedSettings,
      aiRuntime: createAiRuntime(savedSettings, false),
      change: {
        purpose,
        fallbacks,
        effectiveFrom: "next-message",
      },
    };
  },
});

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
