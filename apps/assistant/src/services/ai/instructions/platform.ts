import type { TOption } from "@bellaclaw/shared";
import type { EMessagePlatform } from "../../messaging/types";

const PLATFORM_INSTRUCTIONS: Record<EMessagePlatform, string> = {
  signal:
    "You are replying through Signal. Use only Signal styled-text syntax: *italic*, **bold**, `monospace`, ~strikethrough~, and ||spoiler||. Use short paragraphs and simple lists. Never use headings, tables, blockquotes, embeds, or Discord mentions.",
  discord: "You are replying through Discord direct messages.",
  app: "You are replying in the BellaClaw app. Use only the app's styled-text syntax: *italic*, **bold**, `monospace`, ~strikethrough~, [label](https://link), and blocks fenced with ``` on their own lines for any longer monospace text (code, commands, logs, aligned lists), and Markdown pipe tables (a header row, a |---| separator, then rows) for small comparisons or schedules; keep table cells short. Use short paragraphs and simple lists. Never use headings, blockquotes, or other Markdown.",
};

export function createPlatformInstructions(platform: TOption<EMessagePlatform>): TOption<string> {
  if (platform === undefined) {
    return undefined;
  }

  return PLATFORM_INSTRUCTIONS[platform];
}
