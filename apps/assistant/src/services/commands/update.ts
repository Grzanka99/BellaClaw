import { COMMAND_CATALOG } from "@bellaclaw/shared";
import { AuthorizationService } from "../authorization";
import type { TCommand } from "./types";

export const updateCommand: TCommand = {
  entry: COMMAND_CATALOG.update,
  handler: async (ownerKey, _args, _ctx, address, runId) => {
    // An update restarts the bot for everyone, so only an activated chat may ask for one, even
    // with the activation gate disabled.
    if (!(await AuthorizationService.instance.isActivated(address))) {
      return {
        text: "Updating requires BELLACLAW_ACTIVATION_TOKEN and an activated chat.",
        state: "failed",
        outcome: "not activated",
      };
    }

    // only the supervisor in the container gives the app this channel
    if (process.send === undefined) {
      return {
        text: "Self-update is unavailable: the bot is not running under its supervisor.",
        state: "failed",
        outcome: "unavailable",
      };
    }

    // the update's notices go to this chat only, as later steps of this run
    process.send({ type: "update", chatId: ownerKey, runId });
    return { text: "Checking for an update.", state: "running", outcome: "checking" };
  },
};
