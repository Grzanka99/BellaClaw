import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TOption } from "@bellaclaw/shared";
import { AppLogger, EBehaviorLogLevel, type TBehaviorLogEvent } from ".";
import { maskCanonicalChatId } from "./hmac-key";

let tempDir: TOption<string>;
let originalLogChatIdHmacKey: TOption<string>;

function recordMessage(appLogger: AppLogger, turnId: string) {
  appLogger.record({
    trace: {
      turnId,
      chatId: "discord:chat-1",
      platform: "discord",
    },
    event: "message.received",
    component: "messaging",
    level: EBehaviorLogLevel.Info,
    success: true,
    summary: "message received platform=discord type=text",
    metadata: {},
  });
}

describe("AppLogger chatId HMAC key", () => {
  beforeEach(() => {
    originalLogChatIdHmacKey = Bun.env.LOG_CHATID_HMAC_KEY;
    delete Bun.env.LOG_CHATID_HMAC_KEY;
    tempDir = mkdtempSync(join(tmpdir(), "bellaclaw-logs-"));
  });

  afterEach(() => {
    if (originalLogChatIdHmacKey === undefined) {
      delete Bun.env.LOG_CHATID_HMAC_KEY;
    } else {
      Bun.env.LOG_CHATID_HMAC_KEY = originalLogChatIdHmacKey;
    }

    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  test.each([
    ":memory:",
    "file",
  ])("matches reader masking with a configured key for %s", async (storage) => {
    if (tempDir === undefined) {
      throw new Error("tempDir was not initialized");
    }

    Bun.env.LOG_CHATID_HMAC_KEY = " configured-key ";
    let dbPath: string = storage;
    if (storage === "file") {
      dbPath = join(tempDir, "logs.db");
    }
    const stdout: TBehaviorLogEvent[] = [];
    const appLogger = new AppLogger({
      dbPath,
      stdout(event) {
        stdout.push(event);
      },
    });

    recordMessage(appLogger, "turn-test-1");
    await appLogger.close();

    expect(stdout[0]?.chatId).toBe(maskCanonicalChatId(dbPath, "discord:chat-1"));
    expect(stdout[0]?.chatId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("matches reader masking for an in-memory key", async () => {
    const stdout: TBehaviorLogEvent[] = [];
    const appLogger = new AppLogger({
      dbPath: ":memory:",
      stdout(event) {
        stdout.push(event);
      },
    });

    recordMessage(appLogger, "turn-test-1");
    await appLogger.close();

    expect(stdout[0]?.chatId).toBe(maskCanonicalChatId(":memory:", "discord:chat-1"));
  });

  test("keeps the cached key when its sidecar is removed", async () => {
    if (tempDir === undefined) {
      throw new Error("tempDir was not initialized");
    }

    const dbPath = join(tempDir, "logs.db");
    const stdout: TBehaviorLogEvent[] = [];
    const appLogger = new AppLogger({
      dbPath,
      stdout(event) {
        stdout.push(event);
      },
    });

    recordMessage(appLogger, "turn-test-1");
    await appLogger.flush();
    rmSync(`${dbPath}.chatid-hmac-key`);
    recordMessage(appLogger, "turn-test-2");
    await appLogger.close();

    expect(stdout[0]?.chatId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(stdout[1]?.chatId).toBe(stdout[0]?.chatId);
  });

  test("reuses generated key for file-backed log chat IDs", async () => {
    if (tempDir === undefined) {
      throw new Error("tempDir was not initialized");
    }

    const dbPath = join(tempDir, "logs.db");
    const firstStdout: TBehaviorLogEvent[] = [];
    const firstLogger = new AppLogger({
      dbPath,
      stdout(event) {
        firstStdout.push(event);
      },
    });

    recordMessage(firstLogger, "turn-test-1");
    await firstLogger.flush();
    await firstLogger.close();

    const secondStdout: TBehaviorLogEvent[] = [];
    const secondLogger = new AppLogger({
      dbPath,
      stdout(event) {
        secondStdout.push(event);
      },
    });

    recordMessage(secondLogger, "turn-test-2");
    await secondLogger.flush();
    await secondLogger.close();

    expect(existsSync(`${dbPath}.chatid-hmac-key`)).toBe(true);
    expect(firstStdout[0]?.chatId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(secondStdout[0]?.chatId).toBe(firstStdout[0]?.chatId);
    expect(secondStdout[0]?.chatId).toBe(maskCanonicalChatId(dbPath, "discord:chat-1"));
  });
});
