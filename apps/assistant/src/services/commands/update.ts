import { AuthorizationService } from "../authorization";
import type { TCommand } from "./types";

export const updateCommand: TCommand = {
  name: "update",
  description: "Check for a new version now and install it.",
  usage: "!update",
  handler: async (_ownerKey, _args, _ctx, conversationKey) => {
    // An update restarts the bot for everyone, so only an activated chat may ask for one, even
    // with the activation gate disabled.
    if (!(await AuthorizationService.instance.listAuthorizedChatIds()).includes(conversationKey)) {
      return "Updating requires BELLACLAW_ACTIVATION_TOKEN and an activated chat.";
    }

    // only the supervisor in the container gives the app this channel
    if (process.send === undefined) {
      return "Self-update is unavailable: the bot is not running under its supervisor.";
    }

    process.send({ type: "update" });
    return "Checking for an update.";
  },
};
