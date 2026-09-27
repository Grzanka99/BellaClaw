export const COMMAND_PREFIX = "!";

export type TCommandResult = string | { prompt: string };

export type TCommand = {
  name: string;
  description: string;
  usage: string;
  handler: (chatId: string, args: string) => Promise<TCommandResult>;
};
