import { afterEach, describe, expect, mock, test } from "bun:test";
import { Config } from "../../config";
import { ERole } from "../ai/types";
import { MessageHandler } from "./index";

type TAiConnectorInternals = {
  ai: {
    runAssistantToolLoop: typeof import("../ai/api").AiConnector.prototype.runAssistantToolLoop;
    runToolTask: typeof import("../ai/api").AiConnector.prototype.runToolTask;
  };
};

describe("MessageHandler current time context", () => {
  afterEach(() => {
    (MessageHandler as unknown as { _instances: Map<string, MessageHandler> })._instances.clear();
  });

  test("passes current time context into assistant tool loop history", async () => {
    const capturedHistory: Array<{ role: ERole; content: string }> = [];
    const handler = MessageHandler.getInstance("test-chat-id");
    const internals = handler as unknown as TAiConnectorInternals;

    internals.ai = {
      runToolTask: mock(async () => ({
        assistantResponse: "",
        toolCalls: [],
        toolResults: [],
      })),
      runAssistantToolLoop: mock(
        async (args: { history: Array<{ role: ERole; content: string }> }) => {
          capturedHistory.push(...args.history);
          return {
            conversation: [],
            toolActivity: [],
            finalResponse: "test response",
            stopReason: "final-response" as const,
            iterations: 1,
          };
        },
      ),
    } as never;

    // WARN: has to be fixed later; test uses real Memory.instance and can pollute persistent-memory.db.
    await handler.handleMessage({
      chatId: "test-chat-id",
      message: { type: "text", content: "remind me in 2 minutes" },
      author: { type: ERole.User, id: "test-user-id", username: "TestUser" },
    });

    const currentTimeContext = capturedHistory.find((item) =>
      item.content.startsWith("Current time context:"),
    );

    expect(currentTimeContext).toBeDefined();
    expect(currentTimeContext?.role).toBe(ERole.System);
    expect(currentTimeContext?.content).toContain("UTC:");
    expect(currentTimeContext?.content).toContain(`Timezone: ${Config.ai.instructions.timezone}`);
    expect(currentTimeContext?.content).toContain("Local:");
    expect(currentTimeContext?.content).toContain("Weekday:");
  });
});
