import type { TOption } from "@bellaclaw/shared";
import { EMessagePlatform } from "./types";

export type TCanonicalChatKey = {
  platform: EMessagePlatform;
  chatId: string;
};

export function createCanonicalChatKey(platform: EMessagePlatform, chatId: string) {
  return `${platform}:${chatId}`;
}

export function parseCanonicalChatKey(value: string): TOption<TCanonicalChatKey> {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0) {
    return undefined;
  }

  const platformValue = value.slice(0, separatorIndex);
  const chatId = value.slice(separatorIndex + 1);
  if (chatId.length === 0) {
    return undefined;
  }

  if (platformValue === EMessagePlatform.Discord) {
    return {
      platform: EMessagePlatform.Discord,
      chatId,
    };
  }

  if (platformValue === EMessagePlatform.Signal) {
    return {
      platform: EMessagePlatform.Signal,
      chatId,
    };
  }

  return undefined;
}
