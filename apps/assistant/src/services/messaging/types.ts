export enum EMessagePlatform {
  Discord = "discord",
  Signal = "signal",
}

export type TMessageTransport = {
  platform: EMessagePlatform;
  sendText(chatId: string, text: string): Promise<void>;
};
