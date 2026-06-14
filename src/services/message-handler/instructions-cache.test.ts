import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  DEFINE_MESSAGE_IMPORTANCE_TOOL,
  ERole,
  SEARCH_MEMORY_TOOL,
  type TAssistantToolLoopArgs,
  type TToolTaskArgs,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
} from "../ai/api";
import { LIST_CRON_JOBS_TOOL } from "../ai/tools/list-cron-jobs/definition";
import { SCHEDULE_ONCE_TOOL } from "../ai/tools/schedule-once/definition";
import { SCHEDULE_RECURRING_TOOL } from "../ai/tools/schedule-recurring/definition";
import { UNSCHEDULE_CRON_JOB_TOOL } from "../ai/tools/unschedule-cron-job/definition";
import { EMemoryImportance } from "../memory/types";
import { MessageHandler } from "./index";
import { MessageHandlerInstructions } from "./instructions";

type TMessageHandlerInternals = {
  ai: {
    runAssistantToolLoop: typeof import("../ai/api").AiConnector.prototype.runAssistantToolLoop;
    runToolTask: typeof import("../ai/api").AiConnector.prototype.runToolTask;
  };
  memory: {
    findRecent: typeof import("../memory").Memory.prototype.findRecent;
    save: typeof import("../memory").Memory.prototype.save;
  };
  queue: TestQueue;
};

type TQueuedCallback<T> = () => Promise<T>;

class TestQueue {
  private promises: Promise<unknown>[] = [];

  public enqueue<T>(callback: TQueuedCallback<T>): Promise<T> {
    const promise = callback();
    this.promises.push(promise);
    return promise;
  }

  public async drain(): Promise<void> {
    while (this.promises.length > 0) {
      const promises = this.promises;
      this.promises = [];
      await Promise.all(promises);
    }
  }
}

describe("MessageHandler instruction cache", () => {
  const originalBunFile = Bun.file;
  let testQueue: TestQueue | undefined;

  afterEach(async () => {
    try {
      if (testQueue !== undefined) {
        await testQueue.drain();
      }
    } finally {
      testQueue = undefined;
      (MessageHandler as unknown as { _instances: Map<string, unknown> })._instances.clear();
      Bun.file = originalBunFile;
    }
  });

  test("handleMessage reuses loaded XML instructions", async () => {
    let instructionReadCount = 0;

    Bun.file = mock((...args: Parameters<typeof Bun.file>) => {
      const path = args[0];
      let filePath: string | undefined;

      if (typeof path === "string") {
        filePath = path;
      }

      if (filePath === "instructions.xml" || filePath?.endsWith("/instructions.xml")) {
        instructionReadCount += 1;
        return originalBunFile("./package.json");
      }

      return originalBunFile(...args);
    }) as unknown as typeof Bun.file;

    const handler = MessageHandler.getInstance("test-chat-id");
    const internals = handler as unknown as TMessageHandlerInternals;
    const runToolTaskArgs: TToolTaskArgs[] = [];
    const runAssistantToolLoopArgs: TAssistantToolLoopArgs[] = [];

    testQueue = new TestQueue();
    internals.queue = testQueue;

    internals.memory = {
      findRecent: mock(async () => ({ success: true, data: [] })),
      save: mock(async () => ({
        chatId: "test-chat-id",
        author: ERole.User,
        importance: EMemoryImportance.Low,
        message: "hello",
        createdAt: new Date(),
        lastReadAt: new Date(),
      })),
    } as never;

    internals.ai = {
      runToolTask: mock(async (args) => {
        runToolTaskArgs.push(args);

        return {
          assistantResponse: "",
          toolCalls: [],
          toolResults: [
            {
              toolName: DEFINE_MESSAGE_IMPORTANCE_TOOL,
              success: true,
              data: { reasoning: "test", importance: EMemoryImportance.Low },
            },
          ],
        };
      }),
      runAssistantToolLoop: mock(async (args) => {
        runAssistantToolLoopArgs.push(args);

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

    await handler.handleMessage({
      chatId: "test-chat-id",
      message: { type: "text", content: "hello again" },
      author: { type: ERole.User, id: "test-user-id", username: "TestUser" },
    });

    await testQueue.drain();

    expect(runToolTaskArgs).toHaveLength(4);
    for (const args of runToolTaskArgs) {
      expect(args.history[0]?.content).toBe(MessageHandlerInstructions.defineMessageImportance);
    }

    expect(runAssistantToolLoopArgs).toHaveLength(2);
    for (const args of runAssistantToolLoopArgs) {
      expect(args.tools).toHaveLength(7);
      expect(args.tools.map((tool) => tool.definition.function.name)).toEqual([
        SEARCH_MEMORY_TOOL,
        LIST_CRON_JOBS_TOOL,
        SCHEDULE_ONCE_TOOL,
        SCHEDULE_RECURRING_TOOL,
        UNSCHEDULE_CRON_JOB_TOOL,
        WEB_SEARCH_TOOL,
        WEB_FETCH_TOOL,
      ]);
      expect(args.tools.map((tool) => tool.instructions)).toEqual([
        MessageHandlerInstructions.searchMemory,
        MessageHandlerInstructions.listCronJobs,
        MessageHandlerInstructions.scheduleOnce,
        MessageHandlerInstructions.scheduleRecurring,
        MessageHandlerInstructions.unscheduleCronJob,
        MessageHandlerInstructions.webSearch,
        MessageHandlerInstructions.webFetch,
      ]);
    }

    expect(instructionReadCount).toBe(0);
  });
});
