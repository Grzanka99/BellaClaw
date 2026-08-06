import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLogger } from "../src";

const tempDirectories: string[] = [];

function createTemporaryDbPath() {
  const directory = mkdtempSync(join(tmpdir(), "bellaclaw-logs-turn-"));
  tempDirectories.push(directory);
  return join(directory, "behavior.db");
}

async function runLogsTurn(turnId: string, dbPath: string) {
  const process = Bun.spawn(["bun", "run", "scripts/logs-turn.ts", turnId], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...Bun.env,
      BELLACLAW_LOG_DB_PATH: dbPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(process.stdout).text();
  const stderr = await new Response(process.stderr).text();
  const exitCode = await process.exited;

  return { exitCode, stdout, stderr };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("logs:turn", () => {
  test("fails for a missing database without creating its files", async () => {
    const dbPath = createTemporaryDbPath();

    const result = await runLogsTurn("missing-turn", dbPath);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(dbPath);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}.chatid-hmac-key`)).toBe(false);
  });

  test("prints events for a known turn", async () => {
    const dbPath = createTemporaryDbPath();
    const appLogger = new AppLogger({ dbPath, stdout() {} });
    appLogger.record({
      trace: { turnId: "known-turn", chatId: undefined, platform: undefined },
      event: "assistant_loop.completed",
      component: "ai-runtime",
      success: true,
      summary: "completed",
    });
    await appLogger.flush();
    await appLogger.close();

    const result = await runLogsTurn("known-turn", dbPath);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(dbPath);
    expect(result.stdout).toContain("assistant_loop.completed");
  });

  test("reports no events only after querying an existing database", async () => {
    const dbPath = createTemporaryDbPath();
    const appLogger = new AppLogger({ dbPath, stdout() {} });
    appLogger.record({
      trace: { turnId: "other-turn", chatId: undefined, platform: undefined },
      event: "assistant_loop.completed",
      component: "ai-runtime",
      success: true,
      summary: "completed",
    });
    await appLogger.flush();
    await appLogger.close();

    const result = await runLogsTurn("absent-turn", dbPath);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No behavior events found for turnId: absent-turn");
  });
});
