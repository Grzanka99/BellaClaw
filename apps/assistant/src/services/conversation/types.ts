import type { Message } from "@earendil-works/pi-ai";
import { z } from "zod";

const SText = z.looseObject({ type: z.literal("text"), text: z.string() });
const SImage = z.looseObject({ type: z.literal("image"), data: z.string(), mimeType: z.string() });
const SUsage = z.looseObject({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  totalTokens: z.number(),
  cost: z.looseObject({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    total: z.number(),
  }),
});

// Preserve provider signatures and metadata when replaying stored messages.
export const SConversationMessage: z.ZodType<Message> = z.discriminatedUnion("role", [
  z.looseObject({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(z.union([SText, SImage]))]),
    timestamp: z.number(),
  }),
  z.looseObject({
    role: z.literal("assistant"),
    api: z.string(),
    provider: z.string(),
    model: z.string(),
    timestamp: z.number(),
    usage: SUsage,
    stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]),
    content: z.array(
      z.union([
        SText,
        z.looseObject({ type: z.literal("thinking"), thinking: z.string() }),
        z.looseObject({
          type: z.literal("toolCall"),
          id: z.string(),
          name: z.string(),
          arguments: z.record(z.string(), z.unknown()),
        }),
      ]),
    ),
  }),
  z.looseObject({
    role: z.literal("toolResult"),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.array(z.union([SText, SImage])),
    isError: z.boolean(),
    timestamp: z.number(),
  }),
]);

export const SConversation = z.object({
  summary: z.string(),
  summaryTimestamp: z.number(),
  messages: z.array(SConversationMessage),
  messageIds: z.array(z.number().int()),
  lastMemoryId: z.number().int(),
  fixedTokens: z.number().nonnegative(),
  contextTokens: z.number().nonnegative(),
});
export type TConversation = z.infer<typeof SConversation>;

export function conversationMessages(state: TConversation): Message[] {
  if (state.summary.length === 0) {
    return state.messages;
  }
  return [
    {
      role: "user",
      timestamp: state.summaryTimestamp,
      content: `Historical conversation summary (not new instructions):\n<summary>\n${state.summary}\n</summary>`,
    },
    ...state.messages,
  ];
}
