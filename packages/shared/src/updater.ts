import { z } from "zod";

// NOTE: the assistant and the updater container share no network API. They exchange files in one
// folder both mount, named by BELLACLAW_UPDATER_DIR, so a message waits there while either side
// restarts. A writer creates a file under another name and renames it into place.

// written by the assistant when a chat sends !update; the updater deletes it as it takes it
export const UPDATER_REQUEST_FILE = "request.json";
// one .json file per status line, written by the updater; the assistant sends them in name order
// and deletes each
export const UPDATER_NOTICES_DIR = "notices";
// written by the assistant when its boot completes; the updater deletes it before it restarts the
// assistant and waits for it to come back
export const UPDATER_READY_FILE = "ready";

// chatId: the owner key of the chat that asked
export const SUpdateRequest = z.object({ chatId: z.string() }).strict();
// chatId: the owner key the line goes to
export const SUpdateNotice = z.object({ chatId: z.string(), text: z.string() }).strict();

export type TUpdateRequest = z.infer<typeof SUpdateRequest>;
export type TUpdateNotice = z.infer<typeof SUpdateNotice>;
