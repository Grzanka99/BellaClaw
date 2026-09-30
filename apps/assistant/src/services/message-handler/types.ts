import type { ERole } from "../ai/types";

export type TIncommingMessage = {
  chatId: string;
  receivedAt: Date;
  message: {
    type: "text"; // NOTE: Later maybe multimodal
    content: string;
  };
  author: {
    type: ERole.User;
    id: string;
    username: string;
  };
};
