import type { TEventContext } from "../events";

export const COMMAND_PREFIX = "!";

export type TCommandResult = string | { prompt: string };

export type TCommand = {
  name: string;
  description: string;
  usage: string;
  // ctx: the context of the message.authorized delivery that runs the command
  handler: (chatId: string, args: string, ctx: TEventContext) => Promise<TCommandResult>;
};
