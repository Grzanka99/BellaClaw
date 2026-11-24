import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createLogger,
  SUpdateRequest,
  type TOption,
  UPDATER_NOTICES_DIR,
  UPDATER_REQUEST_FILE,
} from "@bellaclaw/shared";
import { z } from "zod";
import { run } from "./command";
import {
  FAILED_FILE,
  MIGRATED_FILE,
  notify,
  RECREATE_APPS,
  RUNNER_CONTAINER,
  readText,
  restore,
  UNHEALTHY_FILE,
} from "./state";

// NOTE: the updater always runs the code of the image it was started from. It builds the new
// image and hands the switch to a runner container started from it, and stays on the old code until
// the runner replaces it, so it can put things back when the runner crashes.

enum ECiState {
  Passed = "passed",
  Pending = "pending",
  Failed = "failed",
}

const UPDATE_HOUR = 4;
const REQUEST_INTERVAL_MS = 2_000;
const UNHEALTHY_INTERVAL_MS = 10 * 60_000;
const CI_RETRY_MS = 10 * 60_000;
const CI_REQUEST_TIMEOUT_MS = 30_000;
const MAX_LISTED_COMMITS = 10;
const CI_PASSED_CONCLUSIONS = ["success", "skipped", "neutral"];

const SCheckRuns = z.object({
  check_runs: z.array(z.object({ conclusion: z.string().nullable() })),
});

async function ciState(repo: string, sha: string): Promise<ECiState> {
  const slug = repo.match(/github\.com\/(.+?)(\.git)?$/)?.[1];

  // the origin is not on GitHub, so there is no CI to read
  if (slug === undefined) {
    return ECiState.Passed;
  }

  let body: unknown;

  try {
    const response = await fetch(
      `https://api.github.com/repos/${slug}/commits/${sha}/check-runs?per_page=100`,
      { signal: AbortSignal.timeout(CI_REQUEST_TIMEOUT_MS) },
    );

    // a repository GitHub does not show without a login has no CI to read
    if (response.status === 404) {
      return ECiState.Passed;
    }

    // NOTE: a rate limit, an outage or an unreadable answer is asked again later, so a commit
    // whose CI failed is not installed because GitHub did not answer
    if (!response.ok) {
      return ECiState.Pending;
    }

    body = await response.json();
  } catch {
    return ECiState.Pending;
  }

  const parsed = SCheckRuns.safeParse(body);

  if (!parsed.success) {
    return ECiState.Pending;
  }

  let state = ECiState.Passed;

  for (const checkRun of parsed.data.check_runs) {
    // a run has no conclusion until it completes
    if (checkRun.conclusion === null) {
      return ECiState.Pending;
    }

    if (!CI_PASSED_CONCLUSIONS.includes(checkRun.conclusion)) {
      state = ECiState.Failed;
    }
  }

  return state;
}

// checkout: the repository checkout, which always holds the running commit; stateDir:
// BELLACLAW_UPDATER_DIR
export class Updater {
  private logger = createLogger("UPDATER");
  private updating = false;
  private ciRetry: TOption<Timer>;

  constructor(
    private checkout: string,
    private stateDir: string,
    private ciRetryMs: number,
  ) {}

  // manual: asked for in a chat; chatId: the chat that hears of it, undefined for none
  public async update(manual: boolean, chatId: TOption<string>): Promise<void> {
    if (this.updating) {
      if (manual) {
        await notify(this.stateDir, chatId, "An update is already running.");
      }

      return;
    }

    this.updating = true;

    try {
      await this.runUpdate(manual, chatId);
    } catch (error) {
      await notify(this.stateDir, chatId, `The update check failed: ${String(error)}`);
    } finally {
      this.updating = false;
    }
  }

  // takes the request a chat left in the folder, if any, and runs its update
  public async takeRequest(): Promise<void> {
    const path = join(this.stateDir, UPDATER_REQUEST_FILE);
    const file = Bun.file(path);

    if (!(await file.exists())) {
      return;
    }

    const text = await file.text();
    let body: unknown;

    await rm(path, { force: true });

    try {
      body = JSON.parse(text);
    } catch {
      this.logger.warning(`Ignored an update request that is not JSON: ${text}`);
      return;
    }

    const parsed = SUpdateRequest.safeParse(body);

    if (!parsed.success) {
      this.logger.warning(`Ignored an invalid update request: ${text}`);
      return;
    }

    await this.update(true, parsed.data.chatId);
  }

  // a version that does not start after its migration waits for a fix on main
  public async checkUnhealthy(): Promise<void> {
    const file = Bun.file(join(this.stateDir, UNHEALTHY_FILE));

    if (!(await file.exists())) {
      return;
    }

    let chatId: TOption<string>;
    const text = (await file.text()).trim();

    if (text !== "") {
      chatId = text;
    }

    await this.update(false, chatId);
  }

  private async runUpdate(manual: boolean, chatId: TOption<string>): Promise<void> {
    const checkout = this.checkout;
    const failedFile = join(this.stateDir, FAILED_FILE);

    if (manual) {
      await rm(failedFile, { force: true });
    }

    // an SSH remote needs a key the container does not have
    const repo = (await run(["git", "remote", "get-url", "origin"], checkout)).replace(
      /^git@github\.com:/,
      "https://github.com/",
    );
    const sha = (await run(["git", "ls-remote", repo, "refs/heads/main"], checkout)).split(/\s/)[0];

    if (!sha) {
      throw new Error("the origin remote has no main branch");
    }

    const old = await run(["git", "rev-parse", "HEAD"], checkout);
    const short = sha.slice(0, 7);
    const oldShort = old.slice(0, 7);

    if (sha === old) {
      if (manual) {
        await notify(this.stateDir, chatId, `Already on ${short}.`);
      }

      return;
    }

    if (sha === (await readText(failedFile))) {
      return;
    }

    const ci = await ciState(repo, sha);

    if (ci === ECiState.Pending) {
      if (manual) {
        await notify(
          this.stateDir,
          chatId,
          `CI has no result yet for ${short}. Updating when it is green.`,
        );
      }

      // one timer, however many checks found CI pending
      clearTimeout(this.ciRetry);
      this.ciRetry = setTimeout(() => void this.update(false, chatId), this.ciRetryMs);
      return;
    }

    if (ci === ECiState.Failed) {
      await Bun.write(failedFile, sha);
      await notify(this.stateDir, chatId, `Skipped the update to ${short}: its CI failed.`);
      return;
    }

    const edited = (await run(["git", "status", "--porcelain", "--untracked-files=no"], checkout))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.slice(3));

    if (edited.length > 0) {
      await Bun.write(failedFile, sha);
      await notify(
        this.stateDir,
        chatId,
        `The update to ${short} is held: files are edited in the server checkout: ${edited.join(", ")}`,
      );
      return;
    }

    let tagged = false;

    try {
      await run(["git", "fetch", repo, "main"], checkout);
      await run(["git", "merge", "--ff-only", sha], checkout);

      if ((await run(["git", "rev-parse", "HEAD"], checkout)) !== sha) {
        throw new Error(`the checkout is not on ${short} after the merge`);
      }

      const subjects = (
        await run(["git", "log", "--reverse", "--format=%s", `${old}..${sha}`], checkout)
      )
        .split("\n")
        .filter((line) => line !== "");
      const lines = subjects.slice(0, MAX_LISTED_COMMITS).map((subject) => `• ${subject}`);
      let commits = `${subjects.length} commits`;

      if (subjects.length > MAX_LISTED_COMMITS) {
        lines.push(`… and ${subjects.length - MAX_LISTED_COMMITS} more`);
      }

      if (subjects.length === 1) {
        commits = "1 commit";
      }

      await notify(
        this.stateDir,
        chatId,
        [`Updating ${oldShort} → ${short} (${commits}):`, ...lines].join("\n"),
      );

      const buildStart = Date.now();

      await run(["podman", "tag", "bellaclaw:local", "bellaclaw:previous"], checkout);
      tagged = true;
      await run(
        ["podman", "build", "--pull", "-t", "bellaclaw:local", "-f", "Containerfile", "."],
        checkout,
      );

      const imageSha = [
        "podman",
        "run",
        "--rm",
        "bellaclaw:local",
        "git",
        "-C",
        "/app",
        "rev-parse",
        "HEAD",
      ];

      // a cached layer can hold the old sources
      if ((await run(imageSha, checkout)) !== sha) {
        await run(
          [
            "podman",
            "build",
            "--pull",
            "--no-cache",
            "-t",
            "bellaclaw:local",
            "-f",
            "Containerfile",
            ".",
          ],
          checkout,
        );

        if ((await run(imageSha, checkout)) !== sha) {
          throw new Error(`the built image is not on ${short}`);
        }
      }

      await notify(
        this.stateDir,
        chatId,
        `Built the image in ${Math.round((Date.now() - buildStart) / 1000)} s.`,
      );
    } catch (error) {
      await run(["git", "reset", "--hard", old], checkout);

      if (tagged) {
        await run(["podman", "tag", "bellaclaw:previous", "bellaclaw:local"], checkout);
      }

      await Bun.write(failedFile, sha);
      await notify(
        this.stateDir,
        chatId,
        `The update to ${short} failed, still on ${oldShort}: ${String(error)}`,
      );
      return;
    }

    const runnerArgs = [old, sha];

    if (chatId !== undefined) {
      runnerArgs.push(chatId);
    }

    let exitCode = "";

    try {
      await run(["podman", "rm", "-f", "--ignore", RUNNER_CONTAINER], checkout);
      await run(
        [
          "podman-compose",
          "--profile",
          "update",
          "run",
          "-d",
          "--no-deps",
          "--name",
          RUNNER_CONTAINER,
          "update-runner",
          "bun",
          // the checkout's .env would otherwise override what Compose reads from the file
          "--no-env-file",
          "/app/apps/updater/src/runner.ts",
          ...runnerArgs,
        ],
        checkout,
      );
      // NOTE: the runner usually replaces this container before it exits
      exitCode = await run(["podman", "wait", RUNNER_CONTAINER], checkout);
    } catch (error) {
      this.logger.error(`The update runner failed: ${String(error)}`);
    }

    if (exitCode === "0") {
      return;
    }

    // the old code cannot use the migrated schema
    if (await Bun.file(join(this.stateDir, MIGRATED_FILE)).exists()) {
      await run(RECREATE_APPS, checkout);
      await Bun.write(join(this.stateDir, UNHEALTHY_FILE), chatId ?? "");
      await notify(
        this.stateDir,
        chatId,
        `The update to ${short} crashed after its database migration. Started ${short} without a rollback.`,
      );
      return;
    }

    // recreated, since the runner may have stopped or replaced any of them
    await restore(checkout, this.stateDir, old, sha, RECREATE_APPS);
    await notify(this.stateDir, chatId, `The update to ${short} crashed, restored ${oldShort}.`);
  }
}

function scheduleDailyUpdate(updater: Updater): void {
  const next = new Date();

  next.setHours(UPDATE_HOUR, 0, 0, 0);
  if (next.getTime() <= Date.now()) {
    next.setDate(next.getDate() + 1);
  }

  setTimeout(() => {
    void updater.update(false, undefined);
    scheduleDailyUpdate(updater);
  }, next.getTime() - Date.now());
}

if (import.meta.main) {
  const stateDir = Bun.env.BELLACLAW_UPDATER_DIR;

  if (!stateDir) {
    throw new Error("BELLACLAW_UPDATER_DIR is not set");
  }

  await mkdir(join(stateDir, UPDATER_NOTICES_DIR), { recursive: true });

  const updater = new Updater(process.cwd(), stateDir, CI_RETRY_MS);

  setInterval(() => void updater.takeRequest(), REQUEST_INTERVAL_MS);
  setInterval(() => void updater.checkUnhealthy(), UNHEALTHY_INTERVAL_MS);

  if (Bun.env.BELLACLAW_AUTO_UPDATE === "true") {
    scheduleDailyUpdate(updater);
  }

  // NOTE: this is its container's main process, which ignores a signal that has no handler: Podman
  // would wait out its stop timeout on every restart and update
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => process.exit(0));
  }
}
