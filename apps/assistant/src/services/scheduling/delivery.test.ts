import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import { fauxAssistantMessage, type Message, normalizeContext } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { eq } from "drizzle-orm";
import type { AgentHarness } from "../ai/agent-harness";
import { getAiModelConfig } from "../ai/providers/registry";
import { EAiProvider, EModelPurpose, ERole } from "../ai/types";
import { AutomationService } from "../automation";
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
    automationIds: [],
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

async function saveAutomation(scope: string, name: string, source: string) {
  const draft = await AutomationService.instance.createDraft({
    scope,
    name,
    source,
    config: {},
    allowedOrigins: [],
  });

  return AutomationService.instance.saveDraft(scope, draft.id);
}

function setupAutomationDelivery(scope: string) {
  (SettingsService as unknown as { _instance: unknown })._instance = {
    getAll: mock(async () => DefaultConfigRecord),
  };
  const save = mock(async () => undefined);
  Object.assign(MessageHandler.getInstance(scope), {
    conversations: { saveDeliveredMessage: save },
  });
  const sendText = mock(async () => undefined);
  MessagingAdapter.instance.registerTransport({ platform: EMessagePlatform.Signal, sendText });
  const internals = ScheduledDelivery.instance as unknown as TDeliveryInternals;
  const prompts: string[] = [];
  internals.llm = { completeText: mock(async () => undefined) };
  internals.ai = {
    runScheduledTask: mock(async (args: { prompt: string }) => {
      prompts.push(args.prompt);
      return { text: "Your briefing.", stopReason: "completed", iterations: 1, toolCallCount: 0 };
    }),
  };

  return { save, sendText, internals, prompts };
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
      expect(conversation?.entries).toHaveLength(2);
      expect(conversation?.entries[0]?.message).toMatchObject({
        role: "user",
        timestamp: deliveredAt,
      });
      expect(conversation?.entries[1]?.message).toMatchObject({
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
      expect.stringContaining('reminder "daily" fired at'),
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
      expect.stringContaining('scheduled task "daily" ran at'),
      expect.any(Number),
    );
    expect(internals.runningCronTaskKeys.size).toBe(0);
  });

  describe("cron jobs with automations", () => {
    // The test database is shared, so each test owns a fresh scope instead of clearing tables.
    let chatId = "";
    let scope = "";

    beforeEach(() => {
      chatId = `+${crypto.randomUUID()}`;
      scope = `signal:${chatId}`;
    });

    test("sends raw automation text as written and saves it as a cron task", async () => {
      const bus = await saveAutomation(
        scope,
        "bus",
        "export default async () => ({ kind: 'text', text: 'Bus at 7:05' })",
      );
      const quiet = await saveAutomation(
        scope,
        "quiet",
        "export default async () => ({ kind: 'silent' })",
      );
      const tram = await saveAutomation(
        scope,
        "tram",
        "export default async () => ({ kind: 'text', text: 'Tram at 7:10' })",
      );
      const { save, sendText, internals } = setupAutomationDelivery(scope);
      const job = cron({
        scope,
        content: { kind: "automations" },
        automationIds: [tram.id, quiet.id, bus.id],
      });

      const first = internals.handleCronFire(job);
      await Promise.resolve();
      await internals.handleCronFire(job);
      await first;

      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith(chatId, "Tram at 7:10\n\nBus at 7:05");
      expect(save).toHaveBeenCalledWith(
        scope,
        "[CRON TASK daily]: Tram at 7:10\n\nBus at 7:05",
        expect.stringContaining("text output of its automations, sent as written"),
        expect.any(Number),
      );
      expect(internals.ai.runScheduledTask).not.toHaveBeenCalled();
      expect(internals.runningCronTaskKeys.size).toBe(0);
    });

    test("sends nothing when no automation returns text", async () => {
      const quiet = await saveAutomation(
        scope,
        "quiet",
        "export default async () => ({ kind: 'silent' })",
      );
      const metrics = await saveAutomation(
        scope,
        "metrics",
        "export default async () => ({ kind: 'data', data: { value: 1 } })",
      );
      const { save, sendText, internals } = setupAutomationDelivery(scope);

      await internals.handleCronFire(
        cron({ scope, content: { kind: "automations" }, automationIds: [quiet.id, metrics.id] }),
      );

      expect(sendText).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    });

    test("falls back to the task fallback text when running the automations throws", async () => {
      const { sendText, internals } = setupAutomationDelivery(scope);
      const getByIds = spyOn(AutomationService.instance, "getByIds").mockRejectedValue(
        new Error("database unavailable"),
      );

      try {
        await internals.handleCronFire(
          cron({
            scope,
            content: {
              kind: "task",
              prompt: "Prepare briefing.",
              fallback: "Briefing unavailable.",
            },
            automationIds: [1],
          }),
        );
        await internals.handleCronFire(
          cron({ scope, name: "raw", content: { kind: "automations" }, automationIds: [1] }),
        );
      } finally {
        getByIds.mockRestore();
      }

      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith(chatId, "Briefing unavailable.");
    });

    test("passes automation outputs to the scheduled task agent", async () => {
      const metrics = await saveAutomation(
        scope,
        "metrics",
        "export default async () => ({ kind: 'data', data: { value: 1 } })",
      );
      const { save, sendText, internals, prompts } = setupAutomationDelivery(scope);

      await internals.handleCronFire(
        cron({
          scope,
          content: { kind: "task", prompt: "Prepare briefing.", fallback: "Briefing unavailable." },
          automationIds: [metrics.id],
        }),
      );

      expect(prompts[0]).toContain("Prepare briefing.\n\n<automation_outputs>");
      expect(prompts[0]).toContain('"data": {');
      expect(sendText).toHaveBeenCalledWith(chatId, "Your briefing.");
      expect(save).toHaveBeenCalledWith(
        scope,
        "[CRON TASK daily]: Your briefing.",
        expect.stringContaining("It also used the outputs of the job's automations."),
        expect.any(Number),
      );
    });

    test("sends one fixed notice when a run pauses an automation", async () => {
      const broken = await saveAutomation(
        scope,
        "broken",
        "export default async () => { throw new Error('boom'); }",
      );
      await AutomationService.instance.recordFailure(broken.id, "boom");
      await AutomationService.instance.recordFailure(broken.id, "boom");
      const { save, sendText, internals } = setupAutomationDelivery(scope);
      const job = cron({ scope, content: { kind: "automations" }, automationIds: [broken.id] });

      await internals.handleCronFire(job);
      await internals.handleCronFire(job);

      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith(
        chatId,
        expect.stringMatching(
          /^Automation "broken" was paused after 3 failed runs\. Ask me to fix it\.$/,
        ),
      );
      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith(
        scope,
        expect.stringMatching(/^\[CRON TASK daily\]: Automation "broken" was paused/),
        expect.stringContaining("paused a failing automation"),
        expect.any(Number),
      );
    });
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
