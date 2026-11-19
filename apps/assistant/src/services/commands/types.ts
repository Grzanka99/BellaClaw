import type { TEventContext } from "../events";

export const COMMAND_PREFIX = "!";

export type TCommandResult = string | { prompt: string };

export type TCommand = {
  name: string;
  description: string;
  usage: string;
  // chatId: the owner key; ctx: the context of the message.authorized delivery that runs the
  // command; conversationKey: the chat the command came from
  handler: (
    chatId: string,
    args: string,
    ctx: TEventContext,
    conversationKey: string,
  ) => Promise<TCommandResult>;
};
