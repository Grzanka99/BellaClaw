import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import z from "zod";
import type { TOption } from "../../../../types";
import { logger } from "../../../../utils/logger";

export const SWebSearchArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).optional(),
});

export type TWebSearchArgs = z.infer<typeof SWebSearchArgs>;

export type TWebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type TWebSearch = {
  query: string;
  results: TWebSearchResult[];
};

export async function handleWebSearch(
  toolCall: ChatMessageToolCall,
): Promise<TOption<TWebSearchArgs>> {
  let argsJson: unknown;

  try {
    argsJson = JSON.parse(toolCall.function.arguments);
  } catch (error) {
    logger.error(`Failed to parse web-search arguments: ${String(error)}`);
    return undefined;
  }

  const parsed = SWebSearchArgs.safeParse(argsJson);

  if (!parsed.success) {
    logger.error("handleWebSearch: Zod validation failed");
    return undefined;
  }

  return parsed.data;
}
