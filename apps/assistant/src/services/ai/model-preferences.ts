import type { TOption } from "@bellaclaw/shared";
import { z } from "zod";
import { EAiProvider, EModelPurpose } from "./types";

const SThinkingLevel = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const SAiModelPreference = z
  .object({
    model: z.string().trim().min(1),
    effort: SThinkingLevel.optional(),
  })
  .strict();

const SAiModelPreferences = z.partialRecord(
  z.enum(EAiProvider),
  z.partialRecord(z.enum(EModelPurpose), SAiModelPreference),
);

export type TAiModelPreference = z.infer<typeof SAiModelPreference>;
export type TAiModelPreferences = z.infer<typeof SAiModelPreferences>;

function parseAiModelPreferences(value: string): TOption<TAiModelPreferences> {
  let decoded: unknown;

  try {
    decoded = JSON.parse(value);
  } catch {
    return undefined;
  }

  const parsed = SAiModelPreferences.safeParse(decoded);

  if (!parsed.success) {
    return undefined;
  }

  return parsed.data;
}

export function decodeAiModelPreferences(value: string): TAiModelPreferences {
  const preferences = parseAiModelPreferences(value);

  if (preferences === undefined) {
    return {};
  }

  return preferences;
}

export function isAiModelPreferencesValue(value: string): boolean {
  return parseAiModelPreferences(value) !== undefined;
}

export function encodeAiModelPreferences(preferences: TAiModelPreferences): string {
  return JSON.stringify(preferences);
}

export function getAiModelPreference(
  preferences: TAiModelPreferences,
  provider: EAiProvider,
  purpose: EModelPurpose,
): TOption<TAiModelPreference> {
  return preferences[provider]?.[purpose];
}

export function setAiModelPreference(
  preferences: TAiModelPreferences,
  provider: EAiProvider,
  purpose: EModelPurpose,
  preference: TOption<TAiModelPreference>,
): void {
  const providerPreferences = preferences[provider] ?? {};

  if (preference === undefined) {
    delete providerPreferences[purpose];
  } else {
    providerPreferences[purpose] = preference;
  }

  if (Object.keys(providerPreferences).length === 0) {
    delete preferences[provider];
  } else {
    preferences[provider] = providerPreferences;
  }
}
