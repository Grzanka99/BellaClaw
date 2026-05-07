import type { Snowflake } from "discord.js";
import type { ERole } from "../ai/types";

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
    type: "text"; // NOTE: Later maybe multimodal
    content: string;
  };
  author: {
    type: ERole.User;
    id: Snowflake;
    username: string;
  };
};

export type TOutgoingMessage = {
  chatId: string;
  message: {
    type: "text";
    content: string;
  };
  author: {
    type: ERole.Assistant;
  };
};
