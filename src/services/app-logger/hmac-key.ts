import { existsSync, readFileSync, writeFileSync } from "node:fs";

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
