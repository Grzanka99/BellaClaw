import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import { fauxAssistantMessage, type Message, normalizeContext } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { eq } from "drizzle-orm";
import type { AgentHarness } from "../ai/agent-harness";
import { getAiModelConfig } from "../ai/providers/registry";
import { EAiProvider, EModelPurpose, ERole } from "../ai/types";
import { conversationMessages, type TConversation } from "../conversation/types";
import { ECronJobType, type TCronJobContext } from "../cron/types";
import { DatabaseConnector } from "../database";
import { memoriesTable } from "../database/schema";
import { Memory } from "../memory";
import { MessageHandler } from "../message-handler";
import type { TIncommingMessage } from "../message-handler/types";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform, type TMessageTransport } from "../messaging/types";
import { SettingsService } from "../settings";
import { DefaultConfigRecord } from "../settings/schema";
import { ScheduledDelivery } from "./delivery";

const TEST_TRACE: TBehaviorTraceContext = {
  turnId: "test",
  chatId: undefined,
  platform: undefined,
};

type TDeliveryInternals = {
  ai: {
    runScheduledTask: ReturnType<typeof mock>;
  };
  llm: {
    completeText: ReturnType<typeof mock>;
  };
  runningCronTaskKeys: Set<string>;
  handleCronFire(ctx: TCronJobContext): Promise<void>;
};

type TMessagingInternals = {
  transports: Map<EMessagePlatform, TMessageTransport>;
  transportWaitAttempts: number;
  transportWaitIntervalMs: number;
};

function cron(overrides: Partial<TCronJobContext> = {}): TCronJobContext {
  return {
    name: "daily",
    scope: "signal:+100",
    type: ECronJobType.Recurring,
    pattern: "0 9 * * *",
    content: { kind: "text", text: "Take a break." },
    lastRunAt: undefined,
    nextRunAt: new Date("2026-07-24T08:00:00.000Z"),
    createdAt: new Date("2026-07-01T08:00:00.000Z"),
    timezone: "Europe/Warsaw",
    ...overrides,
  };
}

function reset() {
  (MessagingAdapter as unknown as { _instance: unknown })._instance = undefined;
  (ScheduledDelivery as unknown as { _instance: unknown })._instance = undefined;
  (Memory as unknown as { _instance: unknown })._instance = undefined;
  (SettingsService as unknown as { _instance: unknown })._instance = undefined;
  (MessageHandler as unknown as { _instances: Map<string, MessageHandler> })._instances.clear();
}

function setupConversationHandler(chatId: string) {
  (SettingsService as unknown as { _instance: unknown })._instance = {
    getAll: mock(async () => DefaultConfigRecord),
  };
  const handler = MessageHandler.getInstance(chatId);
  const runMain = mock(async (args: Parameters<AgentHarness["runMain"]>[0]) => {
    const messages: Message[] = [
      ...(args.conversation?.entries.map((entry) => entry.message) ?? []),
      { role: "user", content: args.prompt, timestamp: Date.now() },
      fauxAssistantMessage("Main reply"),
    ];
    return {
      text: "Main reply",
      iterations: 1,
      toolCallCount: 0,
      stopReason: "completed",
      messages,
    };
  });
  const compactConversation = mock(async (_state: TConversation): Promise<unknown> => undefined);
  Object.assign(handler, {
    ai: { runMain, compactConversation },
    factDistiller: { enqueueFactDrain: async () => true },
  });
  const message: TIncommingMessage = {
    chatId,
    receivedAt: new Date(),
    author: { type: ERole.User },
    message: { content: "Hello" },
  };
  return { handler, runMain, compactConversation, message };
}

async function waitForCall(callback: ReturnType<typeof mock>) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (callback.mock.calls.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Expected callback to run");
}

beforeEach(() => {
  reset();
});

afterEach(() => {
  reset();
});

describe("ScheduledDelivery", () => {
  test.each([
    "reminder",
    "task",
  ])("replays a delivered %s in the next Main request", async (kind) => {
    const chatId = `signal:replay-${kind}`;
    const { handler, runMain, message } = setupConversationHandler(chatId);
    await handler.handleMessage(message, TEST_TRACE, EMessagePlatform.Signal);
    const adapter = MessagingAdapter.instance;
    const sendText = mock(async () => undefined);
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    const internals = ScheduledDelivery.instance as unknown as TDeliveryInternals;
    internals.llm = { completeText: mock(async () => undefined) };
    internals.ai = {
      runScheduledTask: mock(async () => ({
        text: "Your briefing is ready.",
        stopReason: "completed",
        iterations: 1,
        toolCallCount: 0,
      })),
    };
    let context = cron({ scope: chatId });
    let transcript = "[CRON REMINDER daily]: Take a break.";
    if (kind === "task") {
      context = cron({
        scope: chatId,
        content: { kind: "task", prompt: "Prepare briefing", fallback: "Failed" },
      });
      transcript = "[CRON TASK daily]: Your briefing is ready.";
    }

    await internals.handleCronFire(context);
    await handler.handleMessage(message, TEST_TRACE, EMessagePlatform.Signal);

    const conversation = runMain.mock.calls[1]?.[0].conversation;
    expect(JSON.stringify(conversation)).toContain(transcript);
    if (conversation === undefined) {
      throw new Error("Expected replayable conversation");
    }
    const messages = conversationMessages(conversation);
    for (const provider of Object.values(EAiProvider)) {
      expect(
        JSON.stringify(
          transformMessages(messages, getAiModelConfig(provider, EModelPurpose.Main).model),
        ),
      ).toContain(transcript);
    }
    const request = convertResponsesMessages(
      getAiModelConfig(EAiProvider.OpenaiCodex, EModelPurpose.Main).model,
      normalizeContext({ messages }),
      new Set(),
    );
    expect(JSON.stringify(request)).toContain(transcript);
    const memories = await DatabaseConnector.instance.database
      .select()
      .from(memoriesTable)
      .where(eq(memoriesTable.chatId, chatId));
    expect(memories.filter((row) => row.message === transcript)).toHaveLength(1);
  });

  test.each([
    "turn",
    "compaction",
  ])("retains delivery during an active %s after compaction", async (phase) => {
    const chatId = `signal:overlap-${phase}`;
    const { handler, runMain, compactConversation, message } = setupConversationHandler(chatId);
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const deliveredAt = 1_800_000_000_000;
    const clock = spyOn(Date, "now").mockReturnValue(deliveredAt);
    if (phase === "turn") {
      const completeMain = runMain.getMockImplementation();
      if (completeMain === undefined) {
        throw new Error("Missing Main fixture");
      }
      runMain.mockImplementationOnce(async (args) => {
        started.resolve();
        await finish.promise;
        return completeMain(args);
      });
    }
    compactConversation.mockImplementationOnce(async (state) => {
      if (phase === "compaction") {
        started.resolve();
        await finish.promise;
      }
      return {
        state: {
          ...state,
          summary: "The normal turn was summarized.",
          summaryTimestamp: Date.now(),
          summarizedThroughId: state.entries.at(-1)?.id ?? 0,
          entries: [],
        },
        usage: {},
      };
    });
    const adapter = MessagingAdapter.instance;
    const sendText = mock(async () => undefined);
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    const internals = ScheduledDelivery.instance as unknown as TDeliveryInternals;

    try {
      const turn = handler.handleMessage(message, TEST_TRACE, EMessagePlatform.Signal);
      await started.promise;
      const delivery = internals.handleCronFire(cron({ scope: chatId }));
      await waitForCall(sendText);
      clock.mockReturnValue(deliveredAt + 60_000);
      finish.resolve();
      await turn;
      await delivery;
      await handler.handleMessage(message, TEST_TRACE, EMessagePlatform.Signal);

      const conversation = runMain.mock.calls[1]?.[0].conversation;
      expect(conversation?.summary).toBe("The normal turn was summarized.");
      expect(conversation?.entries).toHaveLength(1);
      expect(conversation?.entries[0]?.message).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "[CRON REMINDER daily]: Take a break." }],
        timestamp: deliveredAt,
      });
      expect(conversation?.entries[0]?.id).toBeGreaterThan(conversation?.summarizedThroughId ?? 0);
      const saved = (
        await DatabaseConnector.instance.database
          .select()
          .from(memoriesTable)
          .where(eq(memoriesTable.chatId, chatId))
      ).find((row) => row.message.includes("CRON REMINDER"));
      expect(saved?.createdAt.getTime()).toBe(deliveredAt);
    } finally {
      finish.resolve();
      clock.mockRestore();
    }
  });

  test("records the reminder transcript only after successful delivery", async () => {
    const save = mock(async () => undefined);
    Object.assign(MessageHandler.getInstance("signal:+100"), {
      conversations: { saveDeliveredMessage: save },
    });
    const sendText = mock(async () => undefined);
    const adapter = MessagingAdapter.instance;
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    const internals = ScheduledDelivery.instance as unknown as TDeliveryInternals;

    await internals.handleCronFire(cron());
    expect(sendText).toHaveBeenCalledWith("+100", "Take a break.");
    expect(save).toHaveBeenCalledWith(
      "signal:+100",
      "[CRON REMINDER daily]: Take a break.",
      expect.any(Number),
    );

    save.mockClear();
    sendText.mockImplementation(async () => {
      throw new Error("offline");
    });
    await internals.handleCronFire(cron({ name: "failed" }));
    expect(save).not.toHaveBeenCalled();
  });

  test("prevents overlapping scheduled tasks and delivers fallback output once", async () => {
    (SettingsService as unknown as { _instance: unknown })._instance = {
      getAll: mock(async () => DefaultConfigRecord),
    };
    const save = mock(async () => undefined);
    Object.assign(MessageHandler.getInstance("signal:+100"), {
      conversations: { saveDeliveredMessage: save },
    });
    const sendText = mock(async () => undefined);
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = MessagingAdapter.instance;
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    const internals = ScheduledDelivery.instance as unknown as TDeliveryInternals;
    internals.llm = { completeText: mock(async () => undefined) };
    internals.ai = {
      runScheduledTask: mock(async () => {
        await waiting;
        return {
          text: " ",
          stopReason: "error",
          iterations: 1,
          toolCallCount: 0,
        };
      }),
    };
    const task = cron({
      content: { kind: "task", prompt: "Prepare briefing.", fallback: "Briefing unavailable." },
    });

    const first = internals.handleCronFire(task);
    await Promise.resolve();
    await internals.handleCronFire(task);
    release();
    await first;

    expect(internals.ai.runScheduledTask).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("+100", "Briefing unavailable.");
    expect(save).toHaveBeenCalledWith(
      "signal:+100",
      "[CRON TASK daily]: Briefing unavailable.",
      expect.any(Number),
    );
    expect(internals.runningCronTaskKeys.size).toBe(0);
  });

  test("waits for a still-connecting transport before giving up on a cron delivery", async () => {
    const adapter = MessagingAdapter.instance as unknown as TMessagingInternals;
    const internals = ScheduledDelivery.instance as unknown as TDeliveryInternals;
    const sendTextMock = mock(async () => {});

    adapter.transportWaitAttempts = 20;
    adapter.transportWaitIntervalMs = 1;
    adapter.transports.clear();

    setTimeout(() => {
      adapter.transports.set(EMessagePlatform.Signal, {
        platform: EMessagePlatform.Signal,
        sendText: sendTextMock,
      });
    }, 5);

    await internals.handleCronFire(cron({ content: { kind: "text", text: "Take a break." } }));

    expect(sendTextMock).toHaveBeenCalledWith("+100", "Take a break.");
  });
});
