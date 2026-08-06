import type { TOption } from "../../../types";
import { EMessagePlatform } from "../../messaging/types";

export function createPlatformInstructions(platform: TOption<EMessagePlatform>): TOption<string> {
  if (platform === EMessagePlatform.Signal) {
    return "You are replying through Signal. Use only Signal styled-text syntax: *italic*, **bold**, `monospace`, ~strikethrough~, and ||spoiler||. Use short paragraphs and simple lists. Never use headings, tables, blockquotes, embeds, or Discord mentions.";
  }

  if (platform === EMessagePlatform.Discord) {
    return "You are replying through Discord direct messages.";
  }

  return undefined;
}
