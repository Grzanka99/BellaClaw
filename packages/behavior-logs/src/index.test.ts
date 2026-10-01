import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLogger, EBehaviorLogLevel, LogReader, type TBehaviorTraceContext } from ".";

const temporaryDirectories: string[] = [];
afterEach(() => {
  mock.restore();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createTrace(): TBehaviorTraceContext {
  return {
    turnId: "turn-test-1",
    chatId: "discord:chat-1",
    platform: "discord",
  };
}

describe("AppLogger", () => {
  test("writes JSON stdout events and persists them by turnId", async () => {
    const stdout: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), "bellaclaw-app-logger-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "behavior.db");
    const stdoutSpy = spyOn(console, "log").mockImplementation((line: unknown) => {
      stdout.push(String(line));
    });
    const appLogger = new AppLogger({ dbPath });

    appLogger.record({
      trace: createTrace(),
      event: "message.received",
      component: "messaging",
      level: EBehaviorLogLevel.Info,
      success: true,
      summary: "message received platform=discord",
      metadata: {
        messageChars: 18,
      },
    });

    stdoutSpy.mockRestore();
    await appLogger.flush();

    expect(stdout).toHaveLength(1);

    const stdoutEvent = JSON.parse(stdout[0] ?? "{}");
    expect(stdoutEvent).toMatchObject({
      schemaVersion: 1,
      event: "message.received",
      turnId: "turn-test-1",
      platform: "discord",
      component: "messaging",
      success: true,
    });
    expect(stdoutEvent.chatId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(stdoutEvent.chatId).not.toBe("discord:chat-1");

    const reader = new LogReader(dbPath);
    const result = await reader.readTurn("turn-test-1");
    await reader.close();
    if (!result.success) {
      throw new Error(result.error.message);
    }
    const events = result.data;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "message.received",
      metadata: {
        messageChars: 18,
      },
    });
    expect(events[0]?.chatId).toBe(stdoutEvent.chatId);

    await appLogger.close();
  });
});
