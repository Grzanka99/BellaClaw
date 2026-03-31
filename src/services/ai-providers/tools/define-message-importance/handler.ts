import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import z from "zod";
import type { TOption } from "../../../../types";
import { EMemoryImportance } from "../../../memory/types";

export const SDefineMessageImportance = z.object({
  reasoning: z.string(),
  importance: z.enum(EMemoryImportance),
});

export type TDefineMessageImportance = z.infer<typeof SDefineMessageImportance>;

export function handleDefineMessageImportance(
  toolCall: ChatMessageToolCall,
): TOption<TDefineMessageImportance> {
  const argsJson = JSON.parse(toolCall.function.arguments);
  const parsed = SDefineMessageImportance.safeParse(argsJson);

  if (!parsed.success) {
    return undefined;
  }

  return parsed.data;
}
