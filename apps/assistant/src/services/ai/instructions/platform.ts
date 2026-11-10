import type { TOption } from "@bellaclaw/shared";
import type { EMessagePlatform } from "../../messaging/types";

const PLATFORM_INSTRUCTIONS: Record<EMessagePlatform, string> = {
  signal:
    "You are replying through Signal. Use only Signal styled-text syntax: *italic*, **bold**, `monospace`, ~strikethrough~, and ||spoiler||. Use short paragraphs and simple lists. Never use headings, tables, blockquotes, embeds, or Discord mentions.",
  discord: "You are replying through Discord direct messages.",
};

export function createPlatformInstructions(platform: TOption<EMessagePlatform>): TOption<string> {
  if (platform === undefined) {
    return undefined;
  }

  return PLATFORM_INSTRUCTIONS[platform];
}
