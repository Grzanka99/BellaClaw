import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import z from "zod";
import type { TOption } from "../../../../types";
import { logger } from "../../../../utils/logger";
import { Memory } from "../../../memory";
import { sortByImportanceAndDates } from "../../../memory/sort";
import { EMemoryImportance, type TMemory } from "../../../memory/types";

export const SSearchMemoryArgs = z.object({
  searchString: z.string().optional(),
  timeRange: z
    .object({
      start: z.coerce.date(),
      end: z.coerce.date(),
    })
    .optional(),
  limit: z.number().int().positive().optional(),
  importance: z.array(z.enum(EMemoryImportance)).optional(),
});

export type TSearchMemoryArgs = z.infer<typeof SSearchMemoryArgs>;

export type TSearchMemory = {
  memories: TMemory[];
};

export async function handleSearchMemory(
  toolCall: ChatMessageToolCall,
  chatId: string,
): Promise<TOption<TSearchMemory>> {
  let argsJson: unknown;
  try {
    argsJson = JSON.parse(toolCall.function.arguments);
  } catch (error) {
    logger.error(`Failed to parse search-memory arguments: ${String(error)}`);
    return undefined;
  }

  const parsed = SSearchMemoryArgs.safeParse(argsJson);

  if (!parsed.success) {
    logger.error("handleSearchMemory: Zod validation failed");
    return undefined;
  }

  const args = parsed.data;

  const result = await Memory.instance.find({
    chatId,
    searchString: args.searchString,
    importance: args.importance,
    limit: args.limit,
    timeRange: args.timeRange,
  });

  if ("operation" in result) {
    return undefined;
  }

  result.sort(sortByImportanceAndDates);

  return { memories: result };
}
