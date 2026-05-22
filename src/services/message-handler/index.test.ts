import { afterEach, describe, expect, mock, test } from "bun:test";
import { LIST_CRON_JOBS_TOOL } from "../ai/tools/list-cron-jobs/definition";
import { SCHEDULE_ONCE_TOOL } from "../ai/tools/schedule-once/definition";
import { SCHEDULE_RECURRING_TOOL } from "../ai/tools/schedule-recurring/definition";
import { UNSCHEDULE_RECURRING_TOOL } from "../ai/tools/unschedule-recurring/definition";
import { ERole } from "../ai/types";
import { MessageHandler } from "./index";

const EXPECTED_CRON_TOOL_NAMES = [
  LIST_CRON_JOBS_TOOL,
  SCHEDULE_RECURRING_TOOL,
  UNSCHEDULE_RECURRING_TOOL,
  SCHEDULE_ONCE_TOOL,
];

type TAiConnectorInternals = {
  ai: {
    runAssistantToolLoop: typeof import("../ai/api").AiConnector.prototype.runAssistantToolLoop;
    runToolTask: typeof import("../ai/api").AiConnector.prototype.runToolTask;
  };
};

describe("MessageHandler", () => {
  afterEach(() => {
    (MessageHandler as unknown as { _instances: Map<string, MessageHandler> })._instances.clear();
  });

  test("handleMessage passes cron tools into runAssistantToolLoop", async () => {
    const capturedTools: Array<unknown> = [];

    const handler = MessageHandler.getInstance("test-chat-id");
    const internals = handler as unknown as TAiConnectorInternals;

    internals.ai = {
      runToolTask: mock(async () => ({
        assistantResponse: "",
        toolCalls: [],
        toolResults: [],
      })),
      runAssistantToolLoop: mock(async (args: { tools: Array<unknown> }) => {
        capturedTools.push(...(args.tools ?? []));
        return {
          conversation: [],
          toolActivity: [],
          finalResponse: "test response",
          stopReason: "final-response" as const,
          iterations: 1,
        };
      }),
    } as never;

    await handler.handleMessage({
      chatId: "test-chat-id",
      message: { type: "text", content: "hello" },
      author: { type: ERole.User, id: "test-user-id", username: "TestUser" },
    });

    const toolNames = (capturedTools as Array<{ definition: { function: { name: string } } }>).map(
      (t) => t.definition.function.name,
    );

    for (const name of EXPECTED_CRON_TOOL_NAMES) {
      expect(toolNames).toContain(name);
    }
  });
});
