import { mkdirSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { TOption } from "@bellaclaw/shared";

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

// NOTE: signal-cli names a downloaded attachment after its sanitized CDN id plus the extension of
// the original filename, and reports that file name as the attachment id.
export function newAttachmentId(filename: TOption<string>): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let id = "";
  for (const byte of bytes) {
    id += ID_ALPHABET[byte % ID_ALPHABET.length];
  }

  if (filename?.includes(".")) {
    id += `.${filename.slice(filename.lastIndexOf(".") + 1)}`;
  }

  return id.replaceAll(/[^A-Za-z0-9_.-]/g, "_");
}

export function attachmentPath(dir: string, id: string): TOption<string> {
  const path = resolve(dir, id);
  if (!path.startsWith(`${resolve(dir)}${sep}`)) {
    return undefined;
  }

  return path;
}

export async function writeAttachment(dir: string, id: string, bytes: Uint8Array): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await Bun.write(resolve(dir, id), bytes);
}

export function listAttachments(dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

export type TParsedBase64Attachment = {
  contentType: TOption<string>;
  filename: TOption<string>;
  bytes: Uint8Array;
};

// NOTE: mirrors signal-cli-rest-api's AttachmentEntry.extractMetaData: plain base64, or
// `data:<MIME>;base64,<DATA>`, or `data:<MIME>;filename=<NAME>;base64,<DATA>`.
export function parseBase64Attachment(value: string): TOption<TParsedBase64Attachment> {
  let base64 = value;
  let contentType: TOption<string>;
  let filename: TOption<string>;
  const flagIndex = value.lastIndexOf("base64,");
  if (value.includes("data:") && flagIndex !== -1) {
    base64 = value.slice(flagIndex + "base64,".length);
    if (flagIndex > 0) {
      for (const item of value.slice(0, flagIndex - 1).split(";")) {
        if (item.startsWith("data:")) {
          contentType = item.slice("data:".length);
        } else if (item.startsWith("filename=")) {
          filename = item.slice("filename=".length);
        }
      }
    }
  }

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    return undefined;
  }

  return { contentType, filename, bytes: Buffer.from(base64, "base64") };
}
