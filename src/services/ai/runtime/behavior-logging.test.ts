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

function createPrompt(text: string): TPrompt {
  return {
    role: ERole.User,
    content: [{ type: "text", text }],
  };
}

function createTrace(): TBehaviorTraceContext {
  return {
    turnId: "runtime-turn-1",
    chatId: "discord:chat-1",
    platform: "discord",
  };
}

describe("runtime behavior logging", () => {
  afterEach(async () => {
    await resetAppLogger();
  });

  test("records AI and loop events under one turn without raw prompt or reply text", async () => {
    const stdoutEvents: TBehaviorLogEvent[] = [];
    const appLogger = new AppLogger({
      dbPath: ":memory:",
      stdout(event) {
        stdoutEvents.push(event);
      },
    });
    installAppLogger(appLogger);

    const trace = createTrace();
    const result = await runAssistantToolLoop({
      prompt: createPrompt("private user prompt"),
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
      requestAssistantTurn: async () => ({
        response: "private assistant reply",
        toolCalls: [],
      }),
    });

    expect(result.finalResponse).toBe("private assistant reply");

    await appLogger.flush();

    const events = await appLogger.findByTurnId(trace.turnId);
    const eventNames = events.map((event) => event.event);

    expect(eventNames).toEqual([
      "ai.turn.started",
      "ai.turn.completed",
      "assistant_loop.completed",
    ]);
    expect(events.every((event) => event.turnId === trace.turnId)).toBe(true);
    expect(stdoutEvents).toHaveLength(3);

    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain("discord:chat-1");
    expect(serializedEvents).not.toContain("private user prompt");
    expect(serializedEvents).not.toContain("private assistant reply");
  });
});
