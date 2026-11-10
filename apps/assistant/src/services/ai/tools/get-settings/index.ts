import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { obj } from "@earendil-works/pi-schema";
import { SettingsService } from "../../../settings";
import { EConfigKey, type TConfigRecord } from "../../../settings/schema";
import { decodeAiModelPreferences } from "../../model-preferences";
import {
  aiModels,
  getAiModelConfigs,
  refreshAiModels,
  supportsAiServiceTier,
} from "../../providers/registry";
import { type EAiProvider, SAiProvider } from "../../types";
import { defineTool, requireChatId } from "../define-tool";
import instructions from "./instructions.xml" with { type: "text" };

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

export const getSettings = defineTool({
  name: "get-settings",
  label: "Get settings",
  description:
    "Reads the user's effective assistant settings, per-purpose model selections, and the active provider's Pi model catalog. Takes no arguments; the owner is determined automatically from the chat.",
  schema: obj({}),
  instructions,
  mode: "parallel",
  logSafe: [["settings", "settingKeys"]],
  execute: async (context) => {
    const settings = await SettingsService.instance.getAll(requireChatId(context.chatId));
    await refreshAiModels(resolveAiProvider(settings), true);

    return { settings, aiRuntime: createAiRuntime(settings, true) };
  },
});
