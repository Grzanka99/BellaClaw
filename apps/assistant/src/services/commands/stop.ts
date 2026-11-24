import { COMMAND_CATALOG } from "@bellaclaw/shared";
import { IdentityService } from "../identity";
import { MessageHandler } from "../message-handler";
import type { TCommand } from "./types";

// NOTE: the commands consumer has lanes of its own, so this runs while the chat's turn holds the
// conversation lane. The turn ends on its own once aborted; this only answers
export const stopCommand: TCommand = {
  entry: COMMAND_CATALOG.stop,
  handler: async (ownerKey) => {
    const conversationKey = await IdentityService.instance.conversationKeyOf(ownerKey);

    if (!MessageHandler.instance.stop(conversationKey)) {
      return { text: "Nothing is running.", state: "done", outcome: "nothing running" };
    }

    return { text: "Stopped.", state: "done", outcome: "stopped" };
  },
};
