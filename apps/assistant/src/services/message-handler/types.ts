import type { ERole } from "../ai/types";

export type TIncommingMessage = {
  chatId: string;
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
