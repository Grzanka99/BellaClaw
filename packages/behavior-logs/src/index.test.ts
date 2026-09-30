import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from ".";

function createTrace(): TBehaviorTraceContext {
  return {
    turnId: "turn-test-1",
    chatId: "discord:chat-1",
    platform: "discord",
  };
}

afterEach(() => {
  mock.restore();
});

describe("AppLogger", () => {
  test("writes JSON stdout events and persists them by turnId", async () => {
    const stdout: string[] = [];
    const stdoutSpy = spyOn(console, "log").mockImplementation((line: unknown) => {
      stdout.push(String(line));
    });
    const appLogger = new AppLogger({ dbPath: ":memory:" });

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

    const events = await appLogger.findByTurnId("turn-test-1");
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
