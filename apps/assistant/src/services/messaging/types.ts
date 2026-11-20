import type { TOption } from "@bellaclaw/shared";
import { z } from "zod";

// app: the BellaClaw app, a destination with nothing to send: its transcript row is the delivery
export enum EMessagePlatform {
  Discord = "discord",
  Signal = "signal",
  App = "app",
}

// NOTE: a pointer to a file its channel keeps; the bytes are never put on events. It names the
// channel and the address it came from, so no chat key is needed to fetch it
export const SAttachmentRef = z
  .object({
    id: z.string(),
    mimeType: z.string(),
    channel: z.enum(EMessagePlatform),
    sourceAddress: z.string(),
  })
  .strict();

export type TAttachmentRef = z.infer<typeof SAttachmentRef>;

export const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

// where a channel's files are fetched and deleted
export type TAttachmentStore = {
  platform: EMessagePlatform;
  // undefined when the file is larger than maxBytes
  fetchAttachment(ref: TAttachmentRef, maxBytes: number): Promise<TOption<Uint8Array>>;
  deleteAttachment(ref: TAttachmentRef): Promise<void>;
};

export type TMessageTransport = TAttachmentStore & {
  sendText(address: string, text: string): Promise<void>;
};

// NOTE: the declared size is checked first, so an oversized file is refused without downloading it
export async function readAttachment(
  response: Response,
  maxBytes: number,
): Promise<TOption<Uint8Array>> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    return undefined;
  }

  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > maxBytes) {
    return undefined;
  }

  return data;
}
