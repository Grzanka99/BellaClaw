import { z } from "zod";
import type { TOption } from "../../types";
import { getAiModel } from "../ai/providers/registry";
import { EAiProvider, type EModelPurpose } from "../ai/types";
import { EConfigKey, type TConfigRecord } from "../settings/schema";

export type TAiBehaviorFields = {
  provider: EAiProvider;
  model: string;
  purpose: EModelPurpose;
};

const SAiProvider = z.enum(EAiProvider);

export function resolveAiBehaviorFields(
  settings: TConfigRecord,
  purpose: EModelPurpose,
): TOption<TAiBehaviorFields> {
  const parsedProvider = SAiProvider.safeParse(settings[EConfigKey.AiProvider]);

  if (!parsedProvider.success) {
    return undefined;
  }

  const provider = parsedProvider.data;
  return { provider, model: getAiModel(provider, purpose).id, purpose };
}
