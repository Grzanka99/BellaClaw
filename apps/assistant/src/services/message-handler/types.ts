import type { ERole } from "../ai/types";

export type TIncommingMessage = {
  chatId: string;
  receivedAt: Date;
  message: {
    content: string;
  };
  author: {
    type: ERole.User;
  };
};
