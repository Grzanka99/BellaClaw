import { afterEach, describe, expect, test } from "bun:test";
import { AppLogger, type TBehaviorLogEvent, type TBehaviorTraceContext } from "../../app-logger";
import { DefaultConfigRecord } from "../../settings/schema";
import { EModelPurpose, ERole, type TPrompt } from "../types";
import { runAssistantToolLoop } from "./loop";

type TAppLoggerStatic = {
  _instance: AppLogger | undefined;
};

function installAppLogger(appLogger: AppLogger) {
  const AppLoggerWithInternals = AppLogger as unknown as TAppLoggerStatic;
  AppLoggerWithInternals._instance = appLogger;
}

async function resetAppLogger() {
  const AppLoggerWithInternals = AppLogger as unknown as TAppLoggerStatic;
  await AppLoggerWithInternals._instance?.close();
  AppLoggerWithInternals._instance = undefined;
}

function createTrace(): TBehaviorTraceContext {
  return {
    turnId: "runtime-failure-turn",
    chatId: "discord:chat-1",
    platform: "discord",
  };
}

describe("runtime failure behavior logging", () => {
  afterEach(async () => {
    await resetAppLogger();
  });

  test("records one failed AI and loop completion when the provider throws", async () => {
    const stdoutEvents: TBehaviorLogEvent[] = [];
    const appLogger = new AppLogger({
      dbPath: ":memory:",
      stdout(event) {
        stdoutEvents.push(event);
      },
    });
    installAppLogger(appLogger);

    const trace = createTrace();
    const prompt: TPrompt = {
      role: ERole.User,
      content: [{ type: "text", text: "hello" }],
    };

    await expect(
      runAssistantToolLoop({
        prompt,
        history: [],
        user: {
          id: "user-1",
          username: "user",
          displayName: "User",
        },
        tools: [],
        purpose: EModelPurpose.Chat,
        chatId: trace.chatId,
        settings: DefaultConfigRecord,
        trace,
        requestAssistantTurn: async () => {
          throw new Error("provider failed");
        },
      }),
    ).rejects.toThrow("provider failed");

    await appLogger.flush();

    const aiCompletions = stdoutEvents.filter((event) => event.event === "ai.turn.completed");
    const loopCompletions = stdoutEvents.filter(
      (event) => event.event === "assistant_loop.completed",
    );

    expect(aiCompletions).toHaveLength(1);
    expect(aiCompletions[0]?.success).toBe(false);
    expect(loopCompletions).toHaveLength(1);
    expect(loopCompletions[0]?.success).toBe(false);
  });
});
