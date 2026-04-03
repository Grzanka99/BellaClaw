import type { Snowflake } from "discord.js";
import type { ERole } from "../ai-providers/types";

export type TMessageAuthor =
  | {
      type: ERole.User;
      id: Snowflake;
      username: string;
    }
  | { type: ERole.Assistant };

export type TIncommingMessage = {
  chatId: string;
  message: {
    type: 'text', // NOTE: Later maybe multimodal
    content: string
  };
  author: TMessageAuthor;
};

export type TOutcommingMessage = TIncommingMessage
