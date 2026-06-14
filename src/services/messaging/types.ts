export enum EMessagePlatform {
  Discord = "discord",
  Signal = "signal",
}

export type TPlatformMessage = {
  platform: EMessagePlatform;
  chatId: string;
  author: {
    id: string;
    username: string;
  };
  message: {
    type: "text";
    content: string;
  };
};

export type TMessageTransport = {
  platform: EMessagePlatform;
  sendText(chatId: string, text: string): Promise<void>;
};
