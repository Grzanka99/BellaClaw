import { readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createLogger, type TOption } from "@bellaclaw/shared";
import type { Subprocess } from "bun";
import { z } from "zod";

// NOTE: the supervisor is the container's main process and always runs from the image, never
// from a release, so a bad commit cannot break the updater. It runs the app as a child, and
// replaces the child's code with a release in RELEASES_DIR when main has a new commit.

enum ECiState {
  Passed = "passed",
  Pending = "pending",
  Failed = "failed",
}

const IMAGE_DIR = resolve(import.meta.dir, "../../..");
const CURRENT_LINK = "current";
const FAILED_FILE = "failed-sha";
const IMAGE_FILE = "image-sha";
// a change to one of these takes effect only in a rebuilt image
const IMAGE_FILES = ["Containerfile", "compose.yaml", "apps/assistant/scripts/supervisor.ts"];
const UPDATE_HOUR = 4;
const CI_RETRY_MS = 10 * 60_000;
const READY_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 30_000;
const FOLLOW_INTERVAL_MS = 30_000;
const CI_PASSED_CONCLUSIONS = ["success", "skipped", "neutral"];

const SRole = z.enum(["assistant", "log-viewer"]);
const SChildMessage = z.object({ type: z.enum(["ready", "update"]) });
const SCheckRuns = z.object({
  check_runs: z.array(z.object({ conclusion: z.string().nullable() })),
});

const log = createLogger("SUPERVISOR");
const role = SRole.safeParse(Bun.argv[2]);
const releasesDir = Bun.env.BELLACLAW_RELEASES_DIR;

if (!role.success || !releasesDir) {
  throw new Error("Usage: BELLACLAW_RELEASES_DIR=<dir> supervisor.ts assistant|log-viewer");
}

const root: string = releasesDir;
const appPath = join("apps", role.data);
let child: TOption<Subprocess>;
let childReady = false;
let probing = false;
let updating = false;
const pendingNotices: string[] = [];

async function run(command: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const message = `${command.join(" ")} failed: ${(stderr.trim() || stdout.trim()).slice(-500)}`;

    // the message goes to chat, and a remote URL can carry a token
    throw new Error(message.replace(/\/\/[^/@\s]+@/g, "//"));
  }

  return stdout.trim();
}

async function readText(path: string): Promise<string> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return "";
  }

  return (await file.text()).trim();
}

// the directory the app runs from: the current release, or the image before the first update
async function currentDir(): Promise<string> {
  try {
    return join(root, await readlink(join(root, CURRENT_LINK)));
  } catch {
    return IMAGE_DIR;
  }
}

async function setCurrent(sha: string): Promise<void> {
  const link = join(root, CURRENT_LINK);

  // renamed into place, so the log viewer never sees the link missing
  await symlink(sha, `${link}.new`);
  await rename(`${link}.new`, link);
}

function notify(text: string): void {
  log.info(text);

  if (child !== undefined && childReady) {
    child.send({ type: "notice", text });
    return;
  }

  pendingNotices.push(text);
}

// resolves true once the app reports ready, false if it exits or takes too long
function startApp(dir: string): Promise<boolean> {
  const { promise, resolve: settle } = Promise.withResolvers<boolean>();
  const timeout = setTimeout(() => settle(false), READY_TIMEOUT_MS);

  childReady = false;

  const proc = Bun.spawn(["bun", "src/index.ts"], {
    cwd: join(dir, appPath),
    stdio: ["inherit", "inherit", "inherit"],
    ipc: (message) => {
      const parsed = SChildMessage.safeParse(message);

      if (!parsed.success || child !== proc) {
        return;
      }

      if (parsed.data.type === "update") {
        void update(true);
        return;
      }

      childReady = true;
      for (const text of pendingNotices.splice(0)) {
        proc.send({ type: "notice", text });
      }
      settle(true);
    },
  });

  child = proc;
  void proc.exited.then((exitCode) => {
    clearTimeout(timeout);
    settle(false);

    // the app died on its own: exit too, so the container's restart policy takes over
    if (child === proc && !probing) {
      process.exit(exitCode);
    }
  });

  return promise;
}

async function stopApp(): Promise<void> {
  const proc = child;

  if (proc === undefined) {
    return;
  }

  child = undefined;
  proc.kill("SIGTERM");
  const timeout = setTimeout(() => proc.kill("SIGKILL"), STOP_TIMEOUT_MS);
  await proc.exited;
  clearTimeout(timeout);
}

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
    );

    if (!response.ok) {
      return ECiState.Passed;
    }

    body = await response.json();
  } catch {
    return ECiState.Passed;
  }

  const parsed = SCheckRuns.safeParse(body);

  if (!parsed.success) {
    return ECiState.Passed;
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

async function listMigrations(dir: string): Promise<string> {
  return (await readdir(join(dir, "apps/assistant/migrations"))).sort().join("\n");
}

async function runUpdate(manual: boolean): Promise<void> {
  const failedFile = join(root, FAILED_FILE);
  const runningDir = await currentDir();
  let runningSha = basename(runningDir);

  if (runningDir === IMAGE_DIR) {
    runningSha = await readText(join(root, IMAGE_FILE));
  }

  // releases left behind by earlier updates
  for (const entry of await readdir(root)) {
    if (![CURRENT_LINK, FAILED_FILE, IMAGE_FILE, basename(runningDir)].includes(entry)) {
      await rm(join(root, entry), { recursive: true, force: true });
    }
  }

  if (manual) {
    await rm(failedFile, { force: true });
  }

  // an SSH remote needs a key the container does not have
  const repo = (await run(["git", "remote", "get-url", "origin"], IMAGE_DIR)).replace(
    /^git@github\.com:/,
    "https://github.com/",
  );
  const sha = (await run(["git", "ls-remote", repo, "refs/heads/main"], IMAGE_DIR)).split(/\s/)[0];

  if (!sha) {
    throw new Error("the origin remote has no main branch");
  }

  const short = sha.slice(0, 7);
  const runningShort = runningSha.slice(0, 7);

  if (sha === runningSha) {
    if (manual) {
      notify(`Already on ${short}.`);
    }

    return;
  }

  if (sha === (await readText(failedFile))) {
    return;
  }

  const ci = await ciState(repo, sha);

  if (ci === ECiState.Pending) {
    if (manual) {
      notify(`CI is still running for ${short}. Updating when it is green.`);
    }

    setTimeout(() => void update(false), CI_RETRY_MS);
    return;
  }

  if (ci === ECiState.Failed) {
    await Bun.write(failedFile, sha);
    notify(`Skipped the update to ${short}: its CI failed.`);
    return;
  }

  if (manual) {
    notify(`Updating to ${short}.`);
  }

  const dir = join(root, sha);
  let subject: string;
  let migrates: boolean;

  try {
    await run(["git", "clone", "--depth", "1", "--branch", "main", repo, dir], root);

    if ((await run(["git", "rev-parse", "HEAD"], dir)) !== sha) {
      throw new Error("main moved during the update");
    }

    for (const file of IMAGE_FILES) {
      if ((await readText(join(dir, file))) !== (await readText(join(IMAGE_DIR, file)))) {
        await Bun.write(failedFile, sha);
        notify(
          `The update to ${short} needs a new image. On the server run: git pull && bun run server:update`,
        );
        return;
      }
    }

    // credentials are mounted into the image directory only
    await symlink(join(IMAGE_DIR, ".secrets"), join(dir, ".secrets"));
    await run(["bun", "install", "--frozen-lockfile"], dir);
    subject = await run(["git", "log", "-1", "--format=%s"], dir);
    migrates = (await listMigrations(dir)) !== (await listMigrations(runningDir));
  } catch (error) {
    await Bun.write(failedFile, sha);
    notify(`The update to ${short} failed, still on ${runningShort}: ${String(error)}`);
    return;
  }

  await stopApp();

  try {
    await run(["bun", "scripts/migrate.ts"], join(dir, "apps/assistant"));
  } catch (error) {
    await Bun.write(failedFile, sha);
    void startApp(runningDir);
    notify(
      `The update to ${short} failed in its database migration, restarted ${runningShort}: ${String(error)}`,
    );
    return;
  }

  await setCurrent(sha);
  probing = true;
  const started = await startApp(dir);
  probing = false;

  if (started) {
    notify(`Updated to ${short}: ${subject}`);
    return;
  }

  await Bun.write(failedFile, sha);

  // NOTE: the old code must not run against the migrated schema, and no app is up to send a
  // notice. Exiting leaves the new release to the container's restart policy.
  if (migrates) {
    log.error(`${short} failed to start after its database migration. Not rolling back.`);
    process.exit(1);
  }

  await stopApp();

  if (runningDir === IMAGE_DIR) {
    await rm(join(root, CURRENT_LINK), { force: true });
  } else {
    await setCurrent(runningSha);
  }

  void startApp(runningDir);
  notify(`The update to ${short} failed to start, rolled back to ${runningShort}.`);
}

async function update(manual: boolean): Promise<void> {
  if (updating) {
    if (manual) {
      notify("An update is already running.");
    }

    return;
  }

  updating = true;

  try {
    await runUpdate(manual);
  } catch (error) {
    notify(`The update check failed: ${String(error)}`);
  } finally {
    updating = false;
  }
}

function scheduleDailyUpdate(): void {
  const next = new Date();

  next.setHours(UPDATE_HOUR, 0, 0, 0);
  if (next.getTime() <= Date.now()) {
    next.setDate(next.getDate() + 1);
  }

  setTimeout(() => {
    void update(false);
    scheduleDailyUpdate();
  }, next.getTime() - Date.now());
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void stopApp().then(() => process.exit(0));
  });
}

if (role.data === "assistant") {
  const imageSha = await run(["git", "rev-parse", "HEAD"], IMAGE_DIR);

  // a rebuilt image is newer than any release it finds in the volume
  if ((await readText(join(root, IMAGE_FILE))) !== imageSha) {
    for (const entry of await readdir(root)) {
      await rm(join(root, entry), { recursive: true, force: true });
    }

    await Bun.write(join(root, IMAGE_FILE), imageSha);
  }

  void startApp(await currentDir());

  if (Bun.env.BELLACLAW_AUTO_UPDATE === "true") {
    scheduleDailyUpdate();
  }
} else {
  // the log viewer only follows the release the assistant's supervisor selects
  let dir = await currentDir();

  void startApp(dir);
  setInterval(async () => {
    const latest = await currentDir();

    if (latest === dir) {
      return;
    }

    dir = latest;
    await stopApp();
    void startApp(dir);
  }, FOLLOW_INTERVAL_MS);
}
