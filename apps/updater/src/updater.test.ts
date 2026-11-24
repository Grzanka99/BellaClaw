import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUpdateNotice, TUpdateRequest } from "@bellaclaw/shared";
import { Updater } from "./index";
import { runRunner } from "./runner";

// stand-ins for Podman: they record their arguments, and fail or answer as files in FIXTURE say
const PODMAN = `#!/bin/sh
echo "podman $*" >> "$FIXTURE/calls"
case "$1" in
  build) if [ -e "$FIXTURE/fail-build" ]; then echo "build broke" >&2; exit 1; fi ;;
  run) git -C "$PWD" rev-parse HEAD ;;
  wait) echo 0 ;;
esac
exit 0
`;
const PODMAN_COMPOSE = `#!/bin/sh
echo "podman-compose $*" >> "$FIXTURE/calls"
case " $* " in
  *" scripts/migrate.ts "*) if [ -e "$FIXTURE/fail-migrate" ]; then echo "migration broke" >&2; exit 1; fi ;;
  *" up "*) if [ -e "$FIXTURE/start-ready" ]; then touch "$FIXTURE/state/ready"; fi ;;
esac
exit 0
`;
const CHAT = "signal:+100";
const REQUESTER: TUpdateRequest = { chatId: CHAT, runId: "run-1" };

let directory: string;
let origin: string;
let checkout: string;
let stateDir: string;
let updatesDir: string;
let initial: string;
const savedPath = Bun.env.PATH;

async function sh(cwd: string, ...command: string[]): Promise<string> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")}: ${stderr}`);
  }

  return stdout.trim();
}

async function commit(files: Record<string, string>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await Bun.write(join(origin, path), content);
  }

  await sh(origin, "git", "add", "-A");
  await sh(origin, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", message);
  return sh(origin, "git", "rev-parse", "HEAD");
}

async function notices(): Promise<TUpdateNotice[]> {
  const dir = join(stateDir, "notices");
  let names: string[] = [];

  try {
    names = (await readdir(dir)).sort();
  } catch {
    return [];
  }

  return Promise.all(names.map((name) => Bun.file(join(dir, name)).json()));
}

async function calls(): Promise<string[]> {
  const file = Bun.file(join(directory, "calls"));

  if (!(await file.exists())) {
    return [];
  }

  return (await file.text()).trim().split("\n");
}

function head(): Promise<string> {
  return sh(checkout, "git", "rev-parse", "HEAD");
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "bellaclaw-updater-"));
  origin = join(directory, "origin");
  checkout = join(directory, "checkout");
  stateDir = join(directory, "state");
  updatesDir = join(directory, "updates");
  await mkdir(origin);
  await mkdir(updatesDir);
  await mkdir(stateDir);
  await mkdir(join(directory, "bin"));
  await Bun.write(join(directory, "bin/podman"), PODMAN);
  await Bun.write(join(directory, "bin/podman-compose"), PODMAN_COMPOSE);
  await chmod(join(directory, "bin/podman"), 0o755);
  await chmod(join(directory, "bin/podman-compose"), 0o755);
  Bun.env.PATH = `${join(directory, "bin")}:${savedPath}`;
  Bun.env.FIXTURE = directory;

  await sh(origin, "git", "init", "-b", "main");
  initial = await commit(
    {
      Containerfile: "FROM scratch\n",
      "compose.yaml": "services: {}\n",
      "packages/database/migrations/0000.sql": "",
    },
    "first",
  );
  await sh(directory, "git", "clone", origin, checkout);
});

afterEach(async () => {
  Bun.env.PATH = savedPath;
  await rm(directory, { recursive: true, force: true });
});

describe("updater", () => {
  test("builds a new commit asked for in a chat and starts the runner", async () => {
    const sha = await commit({ "a.txt": "a" }, "add a");
    const updater = new Updater(checkout, stateDir, 60_000);

    await Bun.write(join(stateDir, "request.json"), JSON.stringify(REQUESTER));
    await updater.takeRequest();

    expect(await head()).toBe(sha);
    expect(await Bun.file(join(stateDir, "request.json")).exists()).toBe(false);
    expect(await calls()).toContain("podman build --pull -t bellaclaw:local -f Containerfile .");
    expect(await calls()).toContain(
      `podman-compose --profile update run -d --no-deps --name bellaclaw-update-runner update-runner bun --no-env-file /app/apps/updater/src/runner.ts ${initial} ${sha} ${CHAT} run-1`,
    );

    const sent = await notices();

    expect(sent.map((notice) => notice.chatId)).toEqual([CHAT, CHAT]);
    expect(sent[0]?.text).toBe(
      `Updating ${initial.slice(0, 7)} → ${sha.slice(0, 7)} (1 commit):\n• add a`,
    );
    expect(sent[1]?.text).toMatch(/^Built the image in \d+ s\.$/);
    // both are progress steps of the !update run that asked
    expect(sent.map((notice) => notice.command)).toEqual([
      {
        runId: "run-1",
        name: "update",
        state: "running",
        outcome: `updating to ${sha.slice(0, 7)}`,
      },
      {
        runId: "run-1",
        name: "update",
        state: "running",
        outcome: `updating to ${sha.slice(0, 7)}`,
      },
    ]);
  });

  test("says when it is already up to date", async () => {
    await new Updater(checkout, stateDir, 60_000).update(true, REQUESTER);

    expect(await notices()).toEqual([
      {
        chatId: CHAT,
        text: `Already on ${initial.slice(0, 7)}.`,
        command: {
          runId: "run-1",
          name: "update",
          state: "done",
          outcome: `already on ${initial.slice(0, 7)}`,
        },
      },
    ]);
  });

  test("holds the update when the checkout has edited files", async () => {
    const sha = await commit({ "a.txt": "a" }, "add a");

    await Bun.write(join(checkout, "compose.yaml"), "services: { local: {} }\n");
    await new Updater(checkout, stateDir, 60_000).update(true, REQUESTER);

    expect(await head()).toBe(initial);
    expect((await notices())[0]?.text).toContain("compose.yaml");
    expect((await notices())[0]?.command).toMatchObject({ state: "failed", outcome: "held" });
    expect(await Bun.file(join(stateDir, "failed-sha")).text()).toBe(sha);
    expect(await calls()).toEqual([]);
  });

  test("stays on the old commit when the build fails", async () => {
    const sha = await commit({ "a.txt": "a" }, "add a");

    await Bun.write(join(directory, "fail-build"), "");
    await new Updater(checkout, stateDir, 60_000).update(true, REQUESTER);

    expect(await head()).toBe(initial);
    expect((await notices()).at(-1)?.command).toMatchObject({
      state: "failed",
      outcome: "update failed",
    });
    expect((await notices()).at(-1)?.text).toStartWith(
      `The update to ${sha.slice(0, 7)} failed, still on ${initial.slice(0, 7)}:`,
    );
    expect((await notices()).at(-1)?.text).toContain("build broke");
    expect(await calls()).toContain("podman tag bellaclaw:previous bellaclaw:local");
  });

  test("a scheduled update writes no notice", async () => {
    const sha = await commit({ "a.txt": "a" }, "add a");

    await new Updater(checkout, stateDir, 60_000).update(false, undefined);

    expect(await head()).toBe(sha);
    expect(await notices()).toEqual([]);
  });

  test("answers a second request while a CI wait is pending, and keeps the waiting one", async () => {
    const updater = new Updater(checkout, stateDir, 60_000);
    const waiting = setTimeout(() => undefined, 60_000);

    // ciState reads GitHub, so the pending wait is put in place by hand
    Object.assign(updater, { ciRetry: waiting });

    try {
      await updater.update(true, { chatId: "signal:+200", runId: "run-2" });

      expect(await notices()).toEqual([
        {
          chatId: "signal:+200",
          text: "An update is already running.",
          command: { runId: "run-2", name: "update", state: "failed", outcome: "already running" },
        },
      ]);
      expect(Object.entries(updater)).toContainEqual(["ciRetry", waiting]);
    } finally {
      clearTimeout(waiting);
    }
  });

  test("installs the fix of an unhealthy version for the request that started it", async () => {
    const sha = await commit({ "a.txt": "a" }, "fix");

    await Bun.write(join(stateDir, "unhealthy"), JSON.stringify(REQUESTER));
    await new Updater(checkout, stateDir, 60_000).checkUnhealthy();

    expect(await head()).toBe(sha);
    expect(
      (await notices()).map((notice) => [
        notice.chatId,
        notice.command.runId,
        notice.command.state,
      ]),
    ).toEqual([
      [CHAT, "run-1", "running"],
      [CHAT, "run-1", "running"],
    ]);
  });
});

describe("runner", () => {
  async function update(files: Record<string, string>): Promise<string> {
    const sha = await commit(files, "next");

    await sh(checkout, "git", "pull", "--ff-only");
    return sha;
  }

  function runner(sha: string, readyTimeoutMs = 5_000): Promise<void> {
    return runRunner({
      checkout,
      stateDir,
      updatesDir,
      old: initial,
      sha,
      requester: REQUESTER,
      readyTimeoutMs,
    });
  }

  test("runs pending update scripts once in name order", async () => {
    const sha = await update({ "a.txt": "a" });
    const script = (name: string) =>
      `import { appendFileSync } from "node:fs";\nappendFileSync(Bun.env.FIXTURE + "/ran", "${name}\\n");\n`;

    await Bun.write(join(updatesDir, "0002-b.ts"), script("0002"));
    await Bun.write(join(updatesDir, "0001-a.ts"), script("0001"));
    await Bun.write(join(directory, "start-ready"), "");
    await runner(sha);
    await runner(sha);

    expect(await Bun.file(join(directory, "ran")).text()).toBe("0001\n0002\n");
    expect(await Bun.file(join(stateDir, "applied-updates")).text()).toBe("0001-a.ts\n0002-b.ts\n");
  });

  test("restores the old version when an update script fails", async () => {
    const sha = await update({ "a.txt": "a" });

    await Bun.write(join(updatesDir, "0001-bad.ts"), 'console.error("boom");\nprocess.exit(1);\n');
    await runner(sha);

    expect(await head()).toBe(initial);
    expect(await calls()).toContain("podman start bellaclaw");
    expect(await Bun.file(join(stateDir, "failed-sha")).text()).toBe(sha);
    expect((await notices()).at(-1)?.text).toBe(
      `The update to ${sha.slice(0, 7)} failed in update script 0001-bad.ts, restarted ${initial.slice(0, 7)}: boom`,
    );
    expect((await notices()).at(-1)?.command).toMatchObject({
      state: "failed",
      outcome: "update failed",
    });
  });

  test("restores the old version when the migration fails", async () => {
    const sha = await update({ "packages/database/migrations/0001.sql": "" });

    await Bun.write(join(directory, "fail-migrate"), "");
    await runner(sha);

    expect(await head()).toBe(initial);
    expect(await calls()).toContain("podman start bellaclaw");
    expect(await Bun.file(join(stateDir, "migrated")).exists()).toBe(false);
    expect((await notices()).at(-1)?.text).toContain("failed in its database migration");
    expect((await notices()).at(-1)?.command).toMatchObject({
      state: "failed",
      outcome: "update failed",
    });
  });

  test("rolls back a version that does not start", async () => {
    const sha = await update({ "a.txt": "a" });

    await runner(sha, 100);

    expect(await head()).toBe(initial);
    expect(await Bun.file(join(stateDir, "failed-sha")).text()).toBe(sha);
    expect((await notices()).at(-1)?.text).toBe(
      `The update to ${sha.slice(0, 7)} failed to start, rolled back to ${initial.slice(0, 7)}.`,
    );
    expect((await notices()).at(-1)?.command).toMatchObject({
      state: "failed",
      outcome: "update failed",
    });
  });

  test("reports a started version and replaces the updater last", async () => {
    const sha = await update({ "a.txt": "a" });

    await Bun.write(join(directory, "start-ready"), "");
    await runner(sha);

    expect(await head()).toBe(sha);
    expect((await notices()).at(-1)?.text).toMatch(
      new RegExp(`^Updated to ${sha.slice(0, 7)}: next\\. Down for \\d+ s\\.$`),
    );
    expect((await notices()).at(-1)?.command).toEqual({
      runId: "run-1",
      name: "update",
      state: "done",
      outcome: `updated to ${sha.slice(0, 7)}`,
    });
    expect((await calls()).at(-1)).toBe("podman-compose up -d --force-recreate --no-deps updater");
  });
});
