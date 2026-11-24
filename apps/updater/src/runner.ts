import { appendFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createLogger,
  SUpdateRequest,
  type TOption,
  type TUpdateRequest,
  UPDATER_READY_FILE,
} from "@bellaclaw/shared";
import { exec, run } from "./command";
import {
  APPLIED_UPDATES_FILE,
  FAILED_FILE,
  MIGRATED_FILE,
  notify,
  RECREATE_APPS,
  readText,
  restore,
  UNHEALTHY_FILE,
  writeUnhealthy,
} from "./state";

// NOTE: the runner is a one-off container started from the new image, with the checkout already on
// the new commit. It switches the containers to the new version, or puts the old one back, and
// exits 0 once it handled the outcome; any other exit makes the updater restore.

// updatesDir: the update scripts of the image; old, sha: the running and the new commit;
// requester: the chat and run that hear of it, undefined for none
export type TRunnerOptions = {
  checkout: string;
  stateDir: string;
  updatesDir: string;
  old: string;
  sha: string;
  requester: TOption<TUpdateRequest>;
  readyTimeoutMs: number;
};

const READY_POLL_MS = 500;
const START_OLD = ["podman", "start", "bellaclaw"];

const log = createLogger("RUNNER");

export async function runRunner(options: TRunnerOptions): Promise<void> {
  const { checkout, stateDir, updatesDir, old, sha, requester } = options;
  const short = sha.slice(0, 7);
  const oldShort = old.slice(0, 7);
  const appliedFile = join(stateDir, APPLIED_UPDATES_FILE);
  const migratedFile = join(stateDir, MIGRATED_FILE);
  const readyFile = join(stateDir, UPDATER_READY_FILE);

  await run(["podman", "stop", "-t", "30", "bellaclaw"], checkout);
  const downSince = Date.now();

  await rm(readyFile, { force: true });

  const applied = (await readText(appliedFile)).split("\n");
  const scripts = (await readdir(updatesDir)).filter((name) => name.endsWith(".ts")).sort();

  for (const name of scripts) {
    if (applied.includes(name)) {
      continue;
    }

    const result = await exec(["bun", join(updatesDir, name)], checkout);

    if (result.exitCode !== 0) {
      await restore(checkout, stateDir, old, sha, START_OLD);
      await notify(
        stateDir,
        requester,
        `The update to ${short} failed in update script ${name}, restarted ${oldShort}: ${result.output.slice(-500)}`,
        "failed",
        "update failed",
      );
      return;
    }

    await appendFile(appliedFile, `${name}\n`);
    await notify(
      stateDir,
      requester,
      `Update script ${name} done.`,
      "running",
      `updating to ${short}`,
    );
  }

  const migrates =
    (
      await exec(
        ["git", "diff", "--quiet", old, sha, "--", "packages/database/migrations"],
        checkout,
      )
    ).exitCode !== 0;

  if (migrates) {
    await Bun.write(migratedFile, "");

    try {
      await run(
        [
          "podman-compose",
          "run",
          "--rm",
          "--no-deps",
          "-w",
          "/app/apps/assistant",
          "bellaclaw",
          "bun",
          "scripts/migrate.ts",
        ],
        checkout,
      );
    } catch (error) {
      await rm(migratedFile, { force: true });
      await restore(checkout, stateDir, old, sha, START_OLD);
      await notify(
        stateDir,
        requester,
        `The update to ${short} failed in its database migration, restarted ${oldShort}: ${String(error)}`,
        "failed",
        "update failed",
      );
      return;
    }
  }

  const composeChanged =
    (await exec(["git", "diff", "--quiet", old, sha, "--", "compose.yaml"], checkout)).exitCode !==
    0;

  // NOTE: a changed compose.yaml can touch any service, so all are recreated, by name: the
  // updater is left out and replaced last, so the old one outlives every step that can fail. Read
  // from the compose.yaml in the checkout, which a rollback changes
  const recreateCommand = async () => {
    if (!composeChanged) {
      return RECREATE_APPS;
    }

    const services = (
      await run(["podman-compose", "--profile", "signal", "config", "--services"], checkout)
    )
      .split("\n")
      .filter((service) => service !== "" && service !== "updater");

    return [
      "podman-compose",
      "--profile",
      "signal",
      "up",
      "-d",
      "--force-recreate",
      "--no-deps",
      ...services,
    ];
  };

  await run(await recreateCommand(), checkout);

  const deadline = Date.now() + options.readyTimeoutMs;
  let ready = await Bun.file(readyFile).exists();

  while (!ready && Date.now() < deadline) {
    await Bun.sleep(READY_POLL_MS);
    ready = await Bun.file(readyFile).exists();
  }

  if (ready) {
    const subject = await run(["git", "log", "-1", "--format=%s", sha], checkout);

    const text = `Updated to ${short}: ${subject}. Down for ${Math.round((Date.now() - downSince) / 1000)} s.`;

    await notify(stateDir, requester, text, "done", `updated to ${short}`);

    // a version waiting for a fix: its run's card ends with this update
    const unhealthy = await readText(join(stateDir, UNHEALTHY_FILE));

    if (unhealthy !== "") {
      const parsed = SUpdateRequest.safeParse(JSON.parse(unhealthy));

      if (parsed.success && parsed.data.runId !== requester?.runId) {
        await notify(stateDir, parsed.data, text, "done", `updated to ${short}`);
      }
    }

    // after the report, so a crash before here still finds the migration marker
    await rm(migratedFile, { force: true });
    await rm(join(stateDir, UNHEALTHY_FILE), { force: true });

    // the update succeeded: a failure from here on must not make the updater restore
    const prune = await exec(
      ["podman", "image", "prune", "-f", "--filter", "label=bellaclaw=1"],
      checkout,
    );

    if (prune.exitCode !== 0) {
      log.warning(`Pruning the old images failed: ${prune.output}`);
    }

    // NOTE: the last action, as it ends the old updater waiting for this runner
    const replace = await exec(
      ["podman-compose", "up", "-d", "--force-recreate", "--no-deps", "updater"],
      checkout,
    );

    if (replace.exitCode !== 0) {
      log.error(`Replacing the updater failed: ${replace.output}`);
    }

    return;
  }

  // NOTE: the old code cannot use the migrated schema, so the new version stays and waits for a
  // fix on main
  if (migrates) {
    await writeUnhealthy(stateDir, requester);
    log.error(`${short} does not start after its database migration. Not rolling back.`);
    await notify(
      stateDir,
      requester,
      `${short} does not start after its database migration and cannot be rolled back. Push a fix to main: it is installed within 10 minutes.`,
      // still running: the updater installs the fix for the same requester
      "running",
      "waiting for a fix",
    );
    return;
  }

  await run(["git", "reset", "--hard", old], checkout);
  await run(["podman", "tag", "bellaclaw:previous", "bellaclaw:local"], checkout);
  // the old compose.yaml is in the checkout again
  await run(await recreateCommand(), checkout);
  await Bun.write(join(stateDir, FAILED_FILE), sha);
  await notify(
    stateDir,
    requester,
    `The update to ${short} failed to start, rolled back to ${oldShort}.`,
    "failed",
    "update failed",
  );
}

if (import.meta.main) {
  const stateDir = Bun.env.BELLACLAW_UPDATER_DIR;
  const [old, sha, chatId, runId] = Bun.argv.slice(2);

  if (!stateDir || !old || !sha) {
    throw new Error("Usage: BELLACLAW_UPDATER_DIR=<dir> runner.ts <old> <sha> [chatId runId]");
  }

  let requester: TOption<TUpdateRequest>;

  if (chatId !== undefined && runId !== undefined) {
    requester = { chatId, runId };
  }

  await runRunner({
    checkout: process.cwd(),
    stateDir,
    updatesDir: join(import.meta.dir, "../updates"),
    old,
    sha,
    requester,
    readyTimeoutMs: 120_000,
  });
}
