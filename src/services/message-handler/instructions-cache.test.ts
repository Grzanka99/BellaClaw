import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync } from "node:fs";
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
import { UPDATE_CRON_JOB_TOOL } from "../ai/tools/update-cron-job/definition";
import { EMemoryImportance } from "../memory/types";
import { SettingsService } from "../settings";
import { DefaultConfigRecord, EConfigKey, type TConfigRecord } from "../settings/schema";
import { MessageHandler } from "./index";
import {
  getMessageHandlerInstructions,
  invalidateMessageHandlerInstructions,
} from "./instructions";

const testTempDir = Bun.env.TMPDIR ?? "tmp";
mkdirSync(testTempDir, { recursive: true });

function getTempXmlPath(prefix: string): string {
  return `${testTempDir}/${prefix}-${Date.now()}.xml`;
}

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

function mockSettingsService() {
  const SettingsServiceStatic = SettingsService as unknown as { _instance: unknown };
  SettingsServiceStatic._instance = {
    getAll: mock(async () => DefaultConfigRecord),
  };
}

function resetSettingsInstance() {
  const SettingsServiceStatic = SettingsService as unknown as { _instance: unknown };
  SettingsServiceStatic._instance = undefined;
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
      invalidateMessageHandlerInstructions();
      resetSettingsInstance();
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

    mockSettingsService();

    const reference = await getMessageHandlerInstructions("test-chat-id", DefaultConfigRecord);
    instructionReadCount = 0;

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
      expect(args.history[0]?.content).toBe(reference.defineMessageImportance);
    }

    expect(runAssistantToolLoopArgs).toHaveLength(2);
    for (const args of runAssistantToolLoopArgs) {
      expect(args.tools).toHaveLength(8);
      expect(args.tools.map((tool) => tool.definition.function.name)).toEqual([
        SEARCH_MEMORY_TOOL,
        LIST_CRON_JOBS_TOOL,
        SCHEDULE_ONCE_TOOL,
        SCHEDULE_RECURRING_TOOL,
        UNSCHEDULE_CRON_JOB_TOOL,
        UPDATE_CRON_JOB_TOOL,
        WEB_SEARCH_TOOL,
        WEB_FETCH_TOOL,
      ]);
      expect(args.tools.map((tool) => tool.instructions)).toEqual([
        reference.searchMemory,
        reference.listCronJobs,
        reference.scheduleOnce,
        reference.scheduleRecurring,
        reference.unscheduleCronJob,
        reference.updateCronJob,
        reference.webSearch,
        reference.webFetch,
      ]);
    }

    expect(instructionReadCount).toBe(0);
  });

  test("isolates instructions per owner", async () => {
    const tempPath = getTempXmlPath("test-inject-isolation");
    await Bun.write(
      tempPath,
      `<tool>{{config.ai.instructions.assistantName}} {{config.ai.instructions.timezone}}</tool>`,
    );

    Bun.file = mock((...args: Parameters<typeof Bun.file>) => {
      const path = args[0];
      let filePath: string | undefined;

      if (typeof path === "string") {
        filePath = path;
      }

      if (filePath === "instructions.xml" || filePath?.endsWith("/instructions.xml")) {
        return originalBunFile(tempPath);
      }

      return originalBunFile(...args);
    }) as unknown as typeof Bun.file;

    const settingsA: TConfigRecord = {
      ...DefaultConfigRecord,
      [EConfigKey.AiInstructionsAssistantName]: "Alpha",
      [EConfigKey.AiInstructionsTimezone]: "America/New_York",
    };
    const settingsB: TConfigRecord = {
      ...DefaultConfigRecord,
      [EConfigKey.AiInstructionsAssistantName]: "Beta",
      [EConfigKey.AiInstructionsTimezone]: "Asia/Tokyo",
    };

    const instructionsA = await getMessageHandlerInstructions("owner-a", settingsA);
    const instructionsB = await getMessageHandlerInstructions("owner-b", settingsB);

    expect(instructionsA.defineMessageImportance).toContain("Alpha");
    expect(instructionsA.defineMessageImportance).toContain("America/New_York");
    expect(instructionsB.defineMessageImportance).toContain("Beta");
    expect(instructionsB.defineMessageImportance).toContain("Asia/Tokyo");
    expect(instructionsA).not.toBe(instructionsB);

    await Bun.file(tempPath).delete();
  });
});
