import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import z from "zod";

const SArguments = z.object({
  reasoning: z.string(),
  importance: z.string().transform((el) => {
    console.log(el);
    return el;
  }),
});

export function handleDefineMessageImportance(toolCall: ChatMessageToolCall) {
  const argsJson = JSON.parse(toolCall.function.arguments);
  const parsed = SArguments.safeParse(argsJson);

  if (!parsed.success) {
    console.log(parsed.error);
    return undefined;
  }

  return parsed.data;
}
