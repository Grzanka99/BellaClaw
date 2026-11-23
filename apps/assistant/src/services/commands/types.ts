import type { TCommandEntry, TCommandRow, TCommandState } from "@bellaclaw/shared";
import type { TEventContext } from "../events";
import type { TChatAddress } from "../identity";

export const COMMAND_PREFIX = "!";

// text: what every channel gets; state, outcome and rows: the run's card in the app
export type TCommandReply = {
  text: string;
  state: TCommandState;
  outcome: string;
  rows?: TCommandRow[];
};

// prompt: a model turn instead of a reply.
// confidential: a reply carrying a secret or a one-time link, or answering a command that carries
// one; its text is sent and never stored, and the run is stored as `!name` with its outcome
export type TCommandResult =
  | TCommandReply
  | { prompt: string }
  | { confidential: string; state: TCommandState; outcome: string };

export type TCommand = {
  entry: TCommandEntry;
  // chatId: the owner key; ctx: the context of the message.authorized delivery that runs the
  // command; address: the address the command came from, which activation is checked for;
  // runId: the id of that message.authorized event
  handler: (
    chatId: string,
    args: string,
    ctx: TEventContext,
    address: TChatAddress,
    runId: string,
  ) => Promise<TCommandResult>;
};
