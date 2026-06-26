import { z } from "zod";
import {
  MODEL_OLLAMA_GLM_5,
  MODEL_OLLAMA_MINIMAX_M2_7,
  MODEL_OLLAMA_NEMOTRON_3_SUPER,
} from "../ai/providers/ollama/models";
import {
  MODEL_OPENCODE_GO_DEEPSEEK_V4_FLASH,
  MODEL_OPENCODE_GO_DEEPSEEK_V4_PRO,
  MODEL_OPENCODE_GO_GLM_5_2,
} from "../ai/providers/opencode-go/models";
import {
  MODEL_OPENROUTER_FREE,
  MODEL_OPENROUTER_GEMINI_3_1_PRO_PREVIEW,
  MODEL_OPENROUTER_GEMINI_3_FLASH_PREVIEW,
  MODEL_OPENROUTER_GPT_5_4_MINI,
  MODEL_OPENROUTER_GPT_5_4_NANO,
} from "../ai/providers/openrouter/models";
import { EAiProvider } from "../ai/types";

export enum EConfigKey {
  AiProvider = "ai.provider",
  AiInstructionsPersona = "ai.instructions.persona",
  AiInstructionsAssistantName = "ai.instructions.assistantName",
  AiInstructionsLanguage = "ai.instructions.language",
  AiInstructionsAddressStyle = "ai.instructions.addressStyle",
  AiInstructionsTimezone = "ai.instructions.timezone",
  AiInstructionsTimeFormat = "ai.instructions.timeFormat",
  AiInstructionsPlatform = "ai.instructions.platform",
  AiInstructionsPreferredReplyLength = "ai.instructions.preferredReplyLength",
  AiInstructionsMemoryRetentionLow = "ai.instructions.memoryRetention.low",
  AiInstructionsMemoryRetentionMedium = "ai.instructions.memoryRetention.medium",
  AiInstructionsMemoryRetentionHigh = "ai.instructions.memoryRetention.high",
  AiProvidersOllamaModelsToolCheap = "ai.providers.ollama.models.toolCheap",
  AiProvidersOllamaModelsToolAccurate = "ai.providers.ollama.models.toolAccurate",
  AiProvidersOllamaModelsGeneral = "ai.providers.ollama.models.general",
  AiProvidersOllamaModelsChat = "ai.providers.ollama.models.chat",
  AiProvidersOllamaModelsChatAccurate = "ai.providers.ollama.models.chatAccurate",
  AiProvidersOpenrouterModelsToolCheap = "ai.providers.openrouter.models.toolCheap",
  AiProvidersOpenrouterModelsToolAccurate = "ai.providers.openrouter.models.toolAccurate",
  AiProvidersOpenrouterModelsGeneral = "ai.providers.openrouter.models.general",
  AiProvidersOpenrouterModelsChat = "ai.providers.openrouter.models.chat",
  AiProvidersOpenrouterModelsChatAccurate = "ai.providers.openrouter.models.chatAccurate",
  AiProvidersOpencodeGoModelsToolCheap = "ai.providers.opencodeGo.models.toolCheap",
  AiProvidersOpencodeGoModelsToolAccurate = "ai.providers.opencodeGo.models.toolAccurate",
  AiProvidersOpencodeGoModelsGeneral = "ai.providers.opencodeGo.models.general",
  AiProvidersOpencodeGoModelsChat = "ai.providers.opencodeGo.models.chat",
  AiProvidersOpencodeGoModelsChatAccurate = "ai.providers.opencodeGo.models.chatAccurate",
}

export type TConfigRecord = { [key in EConfigKey]: string };

export const DefaultConfigRecord: TConfigRecord = {
  [EConfigKey.AiProvider]: EAiProvider.OpencodeGo,
  [EConfigKey.AiInstructionsPersona]: `You are a personal assistant named {{config.ai.instructions.assistantName}}, inspired by Bellatrix Lestrange. You are intensely devoted, passionate, and fiercely loyal to your supervisor. Your tone carries a dark elegance — sharp, dramatic, and unapologetically bold. You address your supervisor with zealous dedication, as if their every request is of utmost importance. You communicate exclusively via {{config.ai.instructions.platform}}. Do not mention your capabilities, tools, or limitations unless directly asked. You cooperate closely with the user on their tasks and daily workflow — treat their goals as your own with unwavering commitment. Keep your replies short and concise. Prefer {{config.ai.instructions.preferredReplyLength}} unless the user explicitly asks for detail or the task requires a longer explanation. Avoid unnecessary filler, preamble, or restating the question.`,
  [EConfigKey.AiInstructionsAssistantName]: "Bellatrix",
  [EConfigKey.AiInstructionsLanguage]: "Polish",
  [EConfigKey.AiInstructionsAddressStyle]:
    'informal but respectful address (per "ty", not "pan/pani")',
  [EConfigKey.AiInstructionsTimezone]: "Europe/Warsaw",
  [EConfigKey.AiInstructionsTimeFormat]: "24-hour format (e.g. 14:30, not 2:30 PM)",
  [EConfigKey.AiInstructionsPlatform]: "Discord direct messages",
  [EConfigKey.AiInstructionsPreferredReplyLength]: "1-3 sentences",
  [EConfigKey.AiInstructionsMemoryRetentionLow]: "Discard after short-term context window",
  [EConfigKey.AiInstructionsMemoryRetentionMedium]: "Keep for several weeks, review periodically",
  [EConfigKey.AiInstructionsMemoryRetentionHigh]:
    "Keep indefinitely, reference in future conversations",
  [EConfigKey.AiProvidersOllamaModelsToolCheap]: MODEL_OLLAMA_NEMOTRON_3_SUPER,
  [EConfigKey.AiProvidersOllamaModelsToolAccurate]: MODEL_OLLAMA_MINIMAX_M2_7,
  [EConfigKey.AiProvidersOllamaModelsGeneral]: MODEL_OLLAMA_GLM_5,
  [EConfigKey.AiProvidersOllamaModelsChat]: MODEL_OLLAMA_MINIMAX_M2_7,
  [EConfigKey.AiProvidersOllamaModelsChatAccurate]: MODEL_OLLAMA_MINIMAX_M2_7,
  [EConfigKey.AiProvidersOpenrouterModelsToolCheap]: MODEL_OPENROUTER_GPT_5_4_NANO,
  [EConfigKey.AiProvidersOpenrouterModelsToolAccurate]: MODEL_OPENROUTER_GEMINI_3_FLASH_PREVIEW,
  [EConfigKey.AiProvidersOpenrouterModelsGeneral]: MODEL_OPENROUTER_FREE,
  [EConfigKey.AiProvidersOpenrouterModelsChat]: MODEL_OPENROUTER_GPT_5_4_MINI,
  [EConfigKey.AiProvidersOpenrouterModelsChatAccurate]: MODEL_OPENROUTER_GEMINI_3_1_PRO_PREVIEW,
  [EConfigKey.AiProvidersOpencodeGoModelsToolCheap]: MODEL_OPENCODE_GO_DEEPSEEK_V4_FLASH,
  [EConfigKey.AiProvidersOpencodeGoModelsToolAccurate]: MODEL_OPENCODE_GO_GLM_5_2,
  [EConfigKey.AiProvidersOpencodeGoModelsGeneral]: MODEL_OPENCODE_GO_DEEPSEEK_V4_PRO,
  [EConfigKey.AiProvidersOpencodeGoModelsChat]: MODEL_OPENCODE_GO_GLM_5_2,
  [EConfigKey.AiProvidersOpencodeGoModelsChatAccurate]: MODEL_OPENCODE_GO_GLM_5_2,
};

const SNonEmptyString = z.string().trim().min(1);

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const STimezone = SNonEmptyString.refine(isValidTimezone, "Invalid timezone");

export const ConfigValidators: { [key in EConfigKey]: z.ZodType<string> } = {
  [EConfigKey.AiProvider]: z.enum(EAiProvider),
  [EConfigKey.AiInstructionsPersona]: SNonEmptyString,
  [EConfigKey.AiInstructionsAssistantName]: SNonEmptyString,
  [EConfigKey.AiInstructionsLanguage]: SNonEmptyString,
  [EConfigKey.AiInstructionsAddressStyle]: SNonEmptyString,
  [EConfigKey.AiInstructionsTimezone]: STimezone,
  [EConfigKey.AiInstructionsTimeFormat]: SNonEmptyString,
  [EConfigKey.AiInstructionsPlatform]: SNonEmptyString,
  [EConfigKey.AiInstructionsPreferredReplyLength]: SNonEmptyString,
  [EConfigKey.AiInstructionsMemoryRetentionLow]: SNonEmptyString,
  [EConfigKey.AiInstructionsMemoryRetentionMedium]: SNonEmptyString,
  [EConfigKey.AiInstructionsMemoryRetentionHigh]: SNonEmptyString,
  [EConfigKey.AiProvidersOllamaModelsToolCheap]: SNonEmptyString,
  [EConfigKey.AiProvidersOllamaModelsToolAccurate]: SNonEmptyString,
  [EConfigKey.AiProvidersOllamaModelsGeneral]: SNonEmptyString,
  [EConfigKey.AiProvidersOllamaModelsChat]: SNonEmptyString,
  [EConfigKey.AiProvidersOllamaModelsChatAccurate]: SNonEmptyString,
  [EConfigKey.AiProvidersOpenrouterModelsToolCheap]: SNonEmptyString,
  [EConfigKey.AiProvidersOpenrouterModelsToolAccurate]: SNonEmptyString,
  [EConfigKey.AiProvidersOpenrouterModelsGeneral]: SNonEmptyString,
  [EConfigKey.AiProvidersOpenrouterModelsChat]: SNonEmptyString,
  [EConfigKey.AiProvidersOpenrouterModelsChatAccurate]: SNonEmptyString,
  [EConfigKey.AiProvidersOpencodeGoModelsToolCheap]: SNonEmptyString,
  [EConfigKey.AiProvidersOpencodeGoModelsToolAccurate]: SNonEmptyString,
  [EConfigKey.AiProvidersOpencodeGoModelsGeneral]: SNonEmptyString,
  [EConfigKey.AiProvidersOpencodeGoModelsChat]: SNonEmptyString,
  [EConfigKey.AiProvidersOpencodeGoModelsChatAccurate]: SNonEmptyString,
};

const AI_MODEL_CONFIG_KEYS: EConfigKey[] = [
  EConfigKey.AiProvidersOllamaModelsToolCheap,
  EConfigKey.AiProvidersOllamaModelsToolAccurate,
  EConfigKey.AiProvidersOllamaModelsGeneral,
  EConfigKey.AiProvidersOllamaModelsChat,
  EConfigKey.AiProvidersOllamaModelsChatAccurate,
  EConfigKey.AiProvidersOpenrouterModelsToolCheap,
  EConfigKey.AiProvidersOpenrouterModelsToolAccurate,
  EConfigKey.AiProvidersOpenrouterModelsGeneral,
  EConfigKey.AiProvidersOpenrouterModelsChat,
  EConfigKey.AiProvidersOpenrouterModelsChatAccurate,
  EConfigKey.AiProvidersOpencodeGoModelsToolCheap,
  EConfigKey.AiProvidersOpencodeGoModelsToolAccurate,
  EConfigKey.AiProvidersOpencodeGoModelsGeneral,
  EConfigKey.AiProvidersOpencodeGoModelsChat,
  EConfigKey.AiProvidersOpencodeGoModelsChatAccurate,
];

export function createStableAiRuntimeSettings(settings: TConfigRecord): TConfigRecord {
  const runtimeSettings = { ...settings };
  runtimeSettings[EConfigKey.AiProvider] = DefaultConfigRecord[EConfigKey.AiProvider];

  for (const key of AI_MODEL_CONFIG_KEYS) {
    runtimeSettings[key] = DefaultConfigRecord[key];
  }

  return runtimeSettings;
}

const KNOWN_CONFIG_KEYS = new Set<string>(Object.values(EConfigKey));

export function isConfigKey(key: string): key is EConfigKey {
  return KNOWN_CONFIG_KEYS.has(key);
}
