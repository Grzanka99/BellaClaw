import type { TEventContext } from "../events";

export const COMMAND_PREFIX = "!";

export type TCommandResult = string | { prompt: string };

export type TCommand = {
  name: string;
  description: string;
  usage: string;
  // chatId: the owner key; ctx: the context of the message.authorized delivery that runs the
  // command; addressKey: the chat key of the address the command came from, which is activated
  handler: (
    chatId: string,
    args: string,
    ctx: TEventContext,
    addressKey: string,
  ) => Promise<TCommandResult>;
};
