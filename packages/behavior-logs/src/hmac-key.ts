import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { TOption } from "@bellaclaw/shared";

export const MEMORY_LOG_CHATID_HMAC_KEY = crypto.randomUUID();

export function readOrCreateChatIdHmacKey(dbPath: string): string {
  const keyPath = `${dbPath}.chatid-hmac-key`;

  if (existsSync(keyPath)) {
    const existingKey = readFileSync(keyPath, "utf8").trim();

    if (existingKey.length > 0) {
      return existingKey;
    }
  }

  const key = crypto.randomUUID();
  writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
  return key;
}

export function maskCanonicalChatId(dbPath: string, chatId: string): TOption<string> {
  const configuredKey = Bun.env.LOG_CHATID_HMAC_KEY?.trim();
  let key: TOption<string>;

  if (configuredKey !== undefined && configuredKey.length > 0) {
    key = configuredKey;
  } else if (dbPath === ":memory:") {
    key = MEMORY_LOG_CHATID_HMAC_KEY;
  } else {
    const keyPath = `${dbPath}.chatid-hmac-key`;

    if (!existsSync(keyPath)) {
      return undefined;
    }

    const persistedKey = readFileSync(keyPath, "utf8").trim();

    if (persistedKey.length === 0) {
      return undefined;
    }

    key = persistedKey;
  }

  const digest = createHmac("sha256", key).update(chatId).digest("hex");
  return `sha256:${digest}`;
}
