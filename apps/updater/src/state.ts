import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, type TOption, UPDATER_NOTICES_DIR } from "@bellaclaw/shared";
import { run } from "./command";

// NOTE: the state files live in BELLACLAW_UPDATER_DIR next to the files shared with the assistant,
// so they survive the recreation of every container.

// names of the update scripts already run, one per line
export const APPLIED_UPDATES_FILE = "applied-updates";
// the commit whose update failed: not tried again until main moves or a chat asks
export const FAILED_FILE = "failed-sha";
// written before a database migration and deleted once the new version is ready
export const MIGRATED_FILE = "migrated";
// the new version did not start after its migration; holds the chat id of the update, or nothing
export const UNHEALTHY_FILE = "unhealthy";

export const RUNNER_CONTAINER = "bellaclaw-update-runner";
export const RECREATE_APPS = [
  "podman-compose",
  "up",
  "-d",
  "--force-recreate",
  "--no-deps",
  "bellaclaw",
  "log-viewer",
  "gateway",
];

const log = createLogger("UPDATER");
let noticeCount = 0;

export async function readText(path: string): Promise<string> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return "";
  }

  return (await file.text()).trim();
}

// always logs; a notice file only when a chat is known, since no chat hears a scheduled update
export async function notify(
  stateDir: string,
  chatId: TOption<string>,
  text: string,
): Promise<void> {
  log.info(text);

  if (chatId === undefined) {
    return;
  }

  const dir = join(stateDir, UPDATER_NOTICES_DIR);
  // time first, so the names sort in write order across the updater and the runner
  const name = `${String(Date.now()).padStart(15, "0")}-${String(noticeCount).padStart(6, "0")}`;

  noticeCount += 1;
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, `${name}.tmp`), JSON.stringify({ chatId, text }));
  await rename(join(dir, `${name}.tmp`), join(dir, `${name}.json`));
}

// puts the old commit and image back and starts its containers with restart, before anything new
// ran; marks the commit as failed
export async function restore(
  checkout: string,
  stateDir: string,
  old: string,
  sha: string,
  restart: string[],
): Promise<void> {
  await run(["git", "reset", "--hard", old], checkout);
  await run(["podman", "tag", "bellaclaw:previous", "bellaclaw:local"], checkout);
  await run(restart, checkout);
  await Bun.write(join(stateDir, FAILED_FILE), sha);
}
