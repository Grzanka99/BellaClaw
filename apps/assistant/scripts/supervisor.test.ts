import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

// a stand-in app: records the supervisor's notices, and asks for one update on its first start
const APP = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const out = Bun.env.FIXTURE_OUT;
process.on("message", (message) => appendFileSync(out + "/notices", JSON.stringify(message) + "\\n"));
process.send({ type: "ready" });
if (!existsSync(out + "/asked")) {
  writeFileSync(out + "/asked", "");
  process.send({ type: "update" });
}
setInterval(() => undefined, 1000);
`;

describe("supervisor", () => {
  let directory: string;
  let origin: string;
  let image: string;
  let releases: string;
  let supervisor: Subprocess;

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

  async function commit(files: Record<string, string>): Promise<string> {
    for (const [path, content] of Object.entries(files)) {
      await Bun.write(join(origin, path), content);
    }

    await sh(origin, "git", "add", "-A");
    await sh(origin, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "next");
    return sh(origin, "git", "rev-parse", "HEAD");
  }

  // the first notice that is not the "Updating to" announcement
  async function outcome(): Promise<string> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const file = Bun.file(join(directory, "notices"));
      let lines: string[] = [];

      if (await file.exists()) {
        lines = (await file.text()).trim().split("\n");
      }

      const last = lines.at(-1);

      if (last !== undefined && !last.includes("Updating to")) {
        return last;
      }

      await Bun.sleep(100);
    }

    throw new Error("the supervisor sent no outcome");
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "bellaclaw-supervisor-"));
    origin = join(directory, "origin");
    image = join(directory, "image");
    releases = join(directory, "releases");
    await mkdir(origin);
    await mkdir(releases);
    await sh(origin, "git", "init", "-b", "main");
    await commit({
      "package.json": JSON.stringify({ name: "fixture" }),
      Containerfile: "FROM scratch\n",
      "compose.yaml": "services: {}\n",
      "apps/assistant/scripts/migrate.ts": "",
      "apps/assistant/migrations/0000.sql": "",
      "apps/assistant/src/index.ts": APP,
      "apps/assistant/scripts/supervisor.ts": await Bun.file(
        join(import.meta.dir, "supervisor.ts"),
      ).text(),
    });
    await sh(directory, "git", "clone", origin, image);
    // the supervisor's own imports resolve from the image, as they do in the container
    await symlink(join(REPO_ROOT, "node_modules"), join(image, "node_modules"));
  });

  afterEach(async () => {
    supervisor.kill("SIGTERM");
    await supervisor.exited;
    await rm(directory, { recursive: true, force: true });
  });

  function start(): void {
    supervisor = Bun.spawn(["bun", "apps/assistant/scripts/supervisor.ts", "assistant"], {
      cwd: image,
      env: { ...Bun.env, BELLACLAW_RELEASES_DIR: releases, FIXTURE_OUT: directory },
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  test("installs a new commit and reports it", async () => {
    const sha = await commit({ "apps/assistant/src/index.ts": `${APP}// v2\n` });

    start();

    expect(await outcome()).toContain(`Updated to ${sha.slice(0, 7)}: next`);
    expect(await readlink(join(releases, "current"))).toBe(sha);
    expect(await readlink(join(releases, sha, ".secrets"))).toBe(join(image, ".secrets"));
  });

  test("rolls back a commit that does not start", async () => {
    const sha = await commit({ "apps/assistant/src/index.ts": "process.exit(1);\n" });

    start();

    expect(await outcome()).toContain(`The update to ${sha.slice(0, 7)} failed to start, rolled`);
    expect(await Bun.file(join(releases, "current")).exists()).toBe(false);
  });

  test("keeps the old version when the migration fails", async () => {
    const sha = await commit({ "apps/assistant/scripts/migrate.ts": "process.exit(1);\n" });

    start();

    expect(await outcome()).toContain(`The update to ${sha.slice(0, 7)} failed in its database`);
    expect(await Bun.file(join(releases, "current")).exists()).toBe(false);
  });

  test("holds a commit that needs a new image", async () => {
    const sha = await commit({ Containerfile: "FROM scratch\nRUN true\n" });

    start();

    expect(await outcome()).toContain(`The update to ${sha.slice(0, 7)} needs a new image`);
    expect(await Bun.file(join(releases, "current")).exists()).toBe(false);
  });
});
