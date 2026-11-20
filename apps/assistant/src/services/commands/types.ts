import type { TEventContext } from "../events";
import type { TChatAddress } from "../identity";

export const COMMAND_PREFIX = "!";

// confidential: a reply carrying a secret or a one-time link, or answering a command that carries
// one; it is sent and neither it nor the command is stored
export type TCommandResult = string | { prompt: string } | { confidential: string };

export type TCommand = {
  name: string;
  description: string;
  usage: string;
  // chatId: the owner key; ctx: the context of the message.authorized delivery that runs the
  // command; address: the address the command came from, which activation is checked for
  handler: (
    chatId: string,
    args: string,
    ctx: TEventContext,
    address: TChatAddress,
  ) => Promise<TCommandResult>;
};
