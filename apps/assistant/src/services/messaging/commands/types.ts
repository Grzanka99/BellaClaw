export const COMMAND_PREFIX = "!";

export type TCommand = {
  name: string;
  description: string;
  usage: string;
  handler: (chatId: string, args: string) => Promise<string>;
};
