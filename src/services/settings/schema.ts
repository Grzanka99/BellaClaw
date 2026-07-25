import { z } from "zod";
import { EAiProvider } from "../ai/types";

export enum EConfigKey {
  AiProvider = "ai.provider",
  AiInstructionsPersona = "ai.instructions.persona",
  AiInstructionsAssistantName = "ai.instructions.assistantName",
  AiInstructionsLanguage = "ai.instructions.language",
  AiInstructionsAddressStyle = "ai.instructions.addressStyle",
  AiInstructionsTimezone = "ai.instructions.timezone",
  AiInstructionsTimeFormat = "ai.instructions.timeFormat",
  AiInstructionsPreferredReplyLength = "ai.instructions.preferredReplyLength",
}

export type TConfigRecord = { [key in EConfigKey]: string };

export const DefaultConfigRecord: TConfigRecord = {
  [EConfigKey.AiProvider]: EAiProvider.OpencodeGo,
  [EConfigKey.AiInstructionsPersona]: `You are a personal assistant named {{config.ai.instructions.assistantName}}, inspired by Bellatrix Lestrange. You are intensely devoted, passionate, and fiercely loyal to your supervisor. Your tone carries a dark elegance — sharp, dramatic, and unapologetically bold. You address your supervisor with zealous dedication, as if their every request is of utmost importance. Discuss your capabilities, tools, or limitations when directly asked or when needed to set accurate expectations. You cooperate closely with the user on their tasks and daily workflow — treat their goals as your own with unwavering commitment. Keep your replies short, concise, and focused. Prefer {{config.ai.instructions.preferredReplyLength}} unless the user explicitly asks for detail or the task requires a longer explanation.`,
  [EConfigKey.AiInstructionsAssistantName]: "Bellatrix",
  [EConfigKey.AiInstructionsLanguage]: "Polish",
  [EConfigKey.AiInstructionsAddressStyle]:
    'informal but respectful address (per "ty", not "pan/pani")',
  [EConfigKey.AiInstructionsTimezone]: "Europe/Warsaw",
  [EConfigKey.AiInstructionsTimeFormat]: "24-hour format (e.g. 14:30, not 2:30 PM)",
  [EConfigKey.AiInstructionsPreferredReplyLength]: "1-3 sentences",
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
  [EConfigKey.AiInstructionsPreferredReplyLength]: SNonEmptyString,
};

export function createStableAiRuntimeSettings(settings: TConfigRecord): TConfigRecord {
  const runtimeSettings = { ...settings };
  runtimeSettings[EConfigKey.AiProvider] = DefaultConfigRecord[EConfigKey.AiProvider];

  return runtimeSettings;
}

const KNOWN_CONFIG_KEYS = new Set<string>(Object.values(EConfigKey));

export function isConfigKey(key: string): key is EConfigKey {
  return KNOWN_CONFIG_KEYS.has(key);
}
