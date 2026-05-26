import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import z from "zod";
import type { TOption } from "../../../../types";
import { logger } from "../../../../utils/logger";

export const SWebFetchArgs = z.object({
  url: z
    .string()
    .url()
    .refine((url) => url.startsWith("http://") || url.startsWith("https://")),
  format: z.enum(["markdown", "text", "html"]).optional(),
  timeout: z.number().int().min(1).max(120).optional(),
});

export type TWebFetchArgs = z.infer<typeof SWebFetchArgs>;

export type TWebFetch = {
  url: string;
  contentType: string;
  format: "markdown" | "text" | "html";
  content: string;
  truncated: boolean;
};

export async function handleWebFetch(
  toolCall: ChatMessageToolCall,
): Promise<TOption<TWebFetchArgs>> {
  let argsJson: unknown;

  try {
    argsJson = JSON.parse(toolCall.function.arguments);
  } catch (error) {
    logger.error(`Failed to parse web-fetch arguments: ${String(error)}`);
    return undefined;
  }

  const parsed = SWebFetchArgs.safeParse(argsJson);

  if (!parsed.success) {
    logger.error("handleWebFetch: Zod validation failed");
    return undefined;
  }

  return parsed.data;
}
