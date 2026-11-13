import type { TCommand } from "./types";

export const updateCommand: TCommand = {
  name: "update",
  description: "Check for a new version now and install it.",
  usage: "!update",
  handler: async () => {
    // only the supervisor in the container gives the app this channel
    if (process.send === undefined) {
      return "Self-update is unavailable: the bot is not running under its supervisor.";
    }

    process.send({ type: "update" });
    return "Checking for an update.";
  },
};
