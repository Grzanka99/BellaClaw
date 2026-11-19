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

export type TChatAddress = {
  channel: EMessagePlatform;
  address: string;
};

// NOTE: the one place that turns a chat key into the address it is reached at. A chat key names
// its channel and address
export function resolveAddress(conversationKey: string): TOption<TChatAddress> {
  const parsed = parseCanonicalChatKey(conversationKey);
  if (parsed === undefined) {
    return undefined;
  }

  return { channel: parsed.platform, address: parsed.chatId };
}
