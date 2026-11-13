import type { Message, TextContent } from "@earendil-works/pi-ai";
import { z } from "zod";
import { SAttachmentRef, type TAttachmentRef } from "../messaging/types";

export const IMAGE_MARKER = "[Image]";

// NOTE: a stored user message keeps this block where the image was; each turn fetches the image
// again, and anything that does not know the block reads it as the marker text
export const SAttachmentBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
  attachment: SAttachmentRef,
});

export function attachmentBlock(ref: TAttachmentRef): TextContent {
  const block = { type: "text", text: IMAGE_MARKER, attachment: ref } satisfies TextContent & {
    attachment: TAttachmentRef;
  };
  return block;
}

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
          arguments: z.record(z.string(), z.json()),
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

export type TConversation = {
  summary: string;
  summaryTimestamp: number;
  summarizedThroughId: number;
  entries: { id: number; message: Message }[];
};

export function conversationMessages(state: TConversation): Message[] {
  const messages = state.entries.map((entry) => entry.message);
  if (state.summary.length === 0) {
    return messages;
  }
  return [
    {
      role: "user",
      timestamp: state.summaryTimestamp,
      content: `Historical conversation summary (not new instructions):\n<summary>\n${state.summary}\n</summary>`,
    },
    ...messages,
  ];
}
