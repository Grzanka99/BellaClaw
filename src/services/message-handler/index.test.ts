import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { LIST_CRON_JOBS_TOOL } from "../ai/tools/list-cron-jobs/definition";
import { SCHEDULE_ONCE_TOOL } from "../ai/tools/schedule-once/definition";
import { SCHEDULE_RECURRING_TOOL } from "../ai/tools/schedule-recurring/definition";
import { UNSCHEDULE_CRON_JOB_TOOL } from "../ai/tools/unschedule-cron-job/definition";
import { UPDATE_CRON_JOB_TOOL } from "../ai/tools/update-cron-job/definition";
import { ERole } from "../ai/types";
import { Memory } from "../memory";
import { MessageHandler } from "./index";

const EXPECTED_CRON_TOOL_NAMES = [
  LIST_CRON_JOBS_TOOL,
  SCHEDULE_RECURRING_TOOL,
  UNSCHEDULE_CRON_JOB_TOOL,
  UPDATE_CRON_JOB_TOOL,
  SCHEDULE_ONCE_TOOL,
];

type TAiConnectorInternals = {
  ai: {
    runAssistantToolLoop: typeof import("../ai/api").AiConnector.prototype.runAssistantToolLoop;
    runToolTask: typeof import("../ai/api").AiConnector.prototype.runToolTask;
  };
  memory: {
    findRecent: typeof import("../memory").Memory.prototype.findRecent;
    save: typeof import("../memory").Memory.prototype.save;
  };
};

function resetMemoryInstance() {
  const MemoryWithPrivate = Memory as unknown as {
    _instance: unknown;
  };
  MemoryWithPrivate._instance = undefined;
}

describe("MessageHandler", () => {
  beforeEach(() => {
    resetMemoryInstance();
  });

  afterEach(() => {
    (MessageHandler as unknown as { _instances: Map<string, MessageHandler> })._instances.clear();
    resetMemoryInstance();
  });

  test("handleMessage passes cron tools into runAssistantToolLoop", async () => {
    const capturedTools: Array<unknown> = [];

    const handler = MessageHandler.getInstance("test-chat-id");
    const internals = handler as unknown as TAiConnectorInternals;

    internals.memory = {
      findRecent: mock(async () => ({ success: true, data: [] })),
      save: mock(async () => ({
        chatId: "test-chat-id",
        author: ERole.User,
        importance: "low",
        message: "hello",
        createdAt: new Date(),
        lastReadAt: new Date(),
      })),
    } as never;

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

    expect(internals.memory.save).toHaveBeenCalledWith({
      chatId: "test-chat-id",
      author: ERole.User,
      importance: "low",
      message: "hello",
    });
  });
});
