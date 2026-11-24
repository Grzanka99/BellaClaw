import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { COMMAND_CATALOG, type TUpdateRequest, UPDATER_REQUEST_FILE } from "@bellaclaw/shared";
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

    // only the container deployment shares this folder with the updater
    const directory = Bun.env.BELLACLAW_UPDATER_DIR;

    if (directory === undefined) {
      return {
        text: "Self-update is unavailable: the bot is not running next to its updater.",
        state: "failed",
        outcome: "unavailable",
      };
    }

    // the update's notices go to this chat only, as later steps of this run
    const request: TUpdateRequest = { chatId: ownerKey, runId };
    const temporary = join(directory, `.${UPDATER_REQUEST_FILE}.${crypto.randomUUID()}`);

    await mkdir(directory, { recursive: true });
    await Bun.write(temporary, JSON.stringify(request));
    await rename(temporary, join(directory, UPDATER_REQUEST_FILE));
    return { text: "Checking for an update.", state: "running", outcome: "checking" };
  },
};
