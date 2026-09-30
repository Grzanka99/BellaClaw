export enum EMessagePlatform {
  Discord = "discord",
  Signal = "signal",
}

export type TPlatformMessage = {
  platform: EMessagePlatform;
  chatId: string;
  message: {
    content: string;
  };
};

export type TMessageTransport = {
  platform: EMessagePlatform;
  sendText(chatId: string, text: string): Promise<void>;
};
