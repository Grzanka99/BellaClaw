import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { type TUpdateRequest, UPDATER_REQUEST_FILE } from "@bellaclaw/shared";
import { AuthorizationService } from "../authorization";
import type { TCommand } from "./types";

export const updateCommand: TCommand = {
  name: "update",
  description: "Check for a new version now and install it.",
  usage: "!update",
  handler: async (ownerKey, _args, _ctx, address) => {
    // An update restarts the bot for everyone, so only an activated chat may ask for one, even
    // with the activation gate disabled.
    if (!(await AuthorizationService.instance.isActivated(address))) {
      return "Updating requires BELLACLAW_ACTIVATION_TOKEN and an activated chat.";
    }

    // only the container deployment shares this folder with the updater
    const directory = Bun.env.BELLACLAW_UPDATER_DIR;

    if (directory === undefined) {
      return "Self-update is unavailable: the bot is not running next to its updater.";
    }

    // the update's notices go to this chat only
    const request: TUpdateRequest = { chatId: ownerKey };
    const temporary = join(directory, `.${UPDATER_REQUEST_FILE}.${crypto.randomUUID()}`);

    await mkdir(directory, { recursive: true });
    await Bun.write(temporary, JSON.stringify(request));
    await rename(temporary, join(directory, UPDATER_REQUEST_FILE));
    return "Checking for an update.";
  },
};
