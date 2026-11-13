import { z } from "zod";

export enum EMessagePlatform {
  Discord = "discord",
  Signal = "signal",
}

// NOTE: a pointer to a file the chat platform keeps; the bytes are never stored or put on events
export const SAttachmentRef = z.object({ id: z.string(), mimeType: z.string() }).strict();

export type TAttachmentRef = z.infer<typeof SAttachmentRef>;

export const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export type TMessageTransport = {
  platform: EMessagePlatform;
  sendText(chatId: string, text: string): Promise<void>;
  fetchAttachment(chatId: string, ref: TAttachmentRef): Promise<Uint8Array>;
  deleteAttachment(chatId: string, ref: TAttachmentRef): Promise<void>;
};
