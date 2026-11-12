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
import { ECronJobType } from "../cron/types";
import { DatabaseConnector } from "../database";
import { eventDeliveriesTable, eventsTable, memoriesTable } from "../database/schema";
import { resetEventTables } from "../database/test-utils";
import { EventBus } from "../events";
import { EEventType, type TCronFiredPayload } from "../events/catalog";
import { Memory } from "../memory";
import { MessageHandler } from "../message-handler";
import type { TIncommingMessage } from "../message-handler/types";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform } from "../messaging/types";
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
};

function cron(overrides: Partial<TCronFiredPayload> = {}): TCronFiredPayload {
  return {
    jobId: 1,
    name: "daily",
    scope: "signal:+100",
    jobType: ECronJobType.Recurring,
    pattern: "0 9 * * *",
    content: { kind: "text", text: "Take a break." },
    automationIds: [],
    nextRunAt: Date.parse("2026-07-24T08:00:00.000Z"),
    timezone: "Europe/Warsaw",
    ...overrides,
  };
}

function fire(payload: TCronFiredPayload): Promise<void> {
  return EventBus.instance.publish({
    type: EEventType.CronFired,
    source: "test",
    key: `${payload.scope}|${payload.name}`,
    trace: TEST_TRACE,
    causationId: undefined,
    dedupeKey: undefined,
    payload,
  });
}

// the consumers of the cron path, registered on a fresh bus
async function setupBus(start = true) {
  await resetEventTables();
  Object.assign(EventBus, { _instance: undefined });
  // a failed send is dead at once instead of waiting for the outbound backoff
  Object.assign(MessagingAdapter.instance, { outboundBackoffMs: [] });
  ScheduledDelivery.instance.setup();
  MessagingAdapter.instance.setup();
  MessageHandler.setup();

  if (start) {
    await EventBus.instance.start();
  }
}

async function eventsOf(type: EEventType) {
  return DatabaseConnector.instance.database
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.type, type));
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

beforeEach(async () => {
  reset();
  await setupBus();
});

afterEach(async () => {
  await EventBus.instance.idle();
  await EventBus.instance.stop();
  reset();
});

describe("ScheduledDelivery", () => {
  test.each([
    "reminder",
    "task",
  ])("replays a delivered %s in the next Main request", async (kind) => {
    const chatId = `signal:replay-${kind}-${crypto.randomUUID()}`;
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

    await fire(context);
    await EventBus.instance.idle();
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
    const chatId = `signal:overlap-${phase}-${crypto.randomUUID()}`;
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

    try {
      const turn = handler.handleMessage(message, TEST_TRACE, EMessagePlatform.Signal);
      await started.promise;
      await fire(cron({ scope: chatId }));
      await waitForCall(sendText);
      clock.mockReturnValue(deliveredAt + 60_000);
      finish.resolve();
      await turn;
      await EventBus.instance.idle();
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

  test("scheduling publishes delivery.ready", async () => {
    await fire(cron());
    await EventBus.instance.idle();

    const [delivery] = await eventsOf(EEventType.DeliveryReady);
    expect(delivery?.key).toBe("signal:+100");
    expect(delivery?.payload).toEqual({
      chatId: "signal:+100",
      text: "Take a break.",
      transcript: {
        text: "[CRON REMINDER daily]: Take a break.",
        notice: expect.stringContaining('reminder "daily" fired at'),
      },
    });
  });

  test("conversation appends on message.sent only", async () => {
    const save = mock(async () => undefined);
    Object.assign(MessageHandler.getInstance("signal:+100"), {
      conversations: { saveDeliveredMessage: save },
    });
    const sendText = mock(async () => undefined);
    const adapter = MessagingAdapter.instance;
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });

    await fire(cron());
    await EventBus.instance.idle();
    expect(sendText).toHaveBeenCalledWith("+100", "Take a break.");
    expect(save).toHaveBeenCalledWith(
      expect.anything(),
      "signal:+100",
      "[CRON REMINDER daily]: Take a break.",
      expect.stringContaining('reminder "daily" fired at'),
      expect.any(Number),
    );

    save.mockClear();
    sendText.mockImplementation(async () => {
      throw new Error("offline");
    });
    await fire(cron({ name: "failed" }));
    await EventBus.instance.idle();
    expect(await eventsOf(EEventType.DeliveryReady)).toHaveLength(2);
    expect(await eventsOf(EEventType.MessageSent)).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();
  });

  test("skips a task fired during its run and runs one fired after it", async () => {
    (SettingsService as unknown as { _instance: unknown })._instance = {
      getAll: mock(async () => DefaultConfigRecord),
    };
    const save = mock(async () => undefined);
    Object.assign(MessageHandler.getInstance("signal:+100"), {
      conversations: { saveDeliveredMessage: save },
    });
    const sendText = mock(async () => undefined);
    const release = Promise.withResolvers<void>();
    const adapter = MessagingAdapter.instance;
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    const internals = ScheduledDelivery.instance as unknown as TDeliveryInternals;
    internals.llm = { completeText: mock(async () => undefined) };
    internals.ai = {
      runScheduledTask: mock(async () => {
        await release.promise;
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

    await fire(task);
    await waitForCall(internals.ai.runScheduledTask);
    await fire(task);
    release.resolve();
    await EventBus.instance.idle();

    expect(internals.ai.runScheduledTask).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("+100", "Briefing unavailable.");
    expect(save).toHaveBeenCalledWith(
      expect.anything(),
      "signal:+100",
      "[CRON TASK daily]: Briefing unavailable.",
      expect.stringContaining('scheduled task "daily" ran at'),
      expect.any(Number),
    );

    await fire(task);
    await EventBus.instance.idle();
    expect(internals.ai.runScheduledTask).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  test("a pending cron.fired delivery replays through start() and ends in one transcript append", async () => {
    const chatId = `signal:pending-${crypto.randomUUID()}`;
    const sendText = mock(async () => undefined);
    MessagingAdapter.instance.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    await EventBus.instance.stop();
    await setupBus(false);
    await fire(cron({ scope: chatId }));

    await EventBus.instance.start();
    await EventBus.instance.idle();

    const memories = await DatabaseConnector.instance.database
      .select()
      .from(memoriesTable)
      .where(eq(memoriesTable.chatId, chatId));
    expect(memories.map((row) => row.message)).toEqual([
      expect.stringContaining('reminder "daily" fired at'),
      "[CRON REMINDER daily]: Take a break.",
    ]);
    expect(sendText).toHaveBeenCalledTimes(1);
    const deliveries = await DatabaseConnector.instance.database
      .select()
      .from(eventDeliveriesTable);
    expect(deliveries.map((delivery) => delivery.status)).toEqual(["done", "done", "done"]);
  });

  test("a replayed task fire with cron.task.started sends the fallback without the agent", async () => {
    const chatId = `signal:interrupted-${crypto.randomUUID()}`;
    const sendText = mock(async () => undefined);
    MessagingAdapter.instance.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    const internals = ScheduledDelivery.instance as unknown as TDeliveryInternals;
    internals.ai = { runScheduledTask: mock(async () => undefined) };
    await EventBus.instance.stop();
    await setupBus(false);
    await fire(
      cron({
        scope: chatId,
        content: { kind: "task", prompt: "Prepare briefing.", fallback: "Briefing unavailable." },
      }),
    );
    const [fired] = await eventsOf(EEventType.CronFired);
    if (fired === undefined) {
      throw new Error("Expected cron.fired");
    }
    // the checkpoint an earlier attempt committed before it died
    await EventBus.instance.publish({
      type: EEventType.CronTaskStarted,
      source: "scheduling",
      key: fired.key,
      trace: TEST_TRACE,
      causationId: fired.id,
      dedupeKey: `${fired.id}:scheduling:${EEventType.CronTaskStarted}:`,
      payload: { jobId: 1 },
    });

    await EventBus.instance.start();
    await EventBus.instance.idle();

    expect(internals.ai.runScheduledTask).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(chatId.slice("signal:".length), "Briefing unavailable.");
    const memories = await DatabaseConnector.instance.database
      .select()
      .from(memoriesTable)
      .where(eq(memoriesTable.chatId, chatId));
    expect(memories.map((row) => row.message)).toContain(
      "[CRON TASK daily]: Briefing unavailable.",
    );
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

      await fire(job);
      await fire(job);
      await EventBus.instance.idle();

      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith(chatId, "Tram at 7:10\n\nBus at 7:05");
      expect(save).toHaveBeenCalledWith(
        expect.anything(),
        scope,
        "[CRON TASK daily]: Tram at 7:10\n\nBus at 7:05",
        expect.stringContaining("text output of its automations, sent as written"),
        expect.any(Number),
      );
      expect(internals.ai.runScheduledTask).not.toHaveBeenCalled();
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
      const { save, sendText } = setupAutomationDelivery(scope);

      await fire(
        cron({ scope, content: { kind: "automations" }, automationIds: [quiet.id, metrics.id] }),
      );
      await EventBus.instance.idle();

      expect(sendText).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    });

    test("falls back to the task fallback text when running the automations throws", async () => {
      const { sendText } = setupAutomationDelivery(scope);
      const getByIds = spyOn(AutomationService.instance, "getByIds").mockRejectedValue(
        new Error("database unavailable"),
      );

      try {
        await fire(
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
        await fire(
          cron({ scope, name: "raw", content: { kind: "automations" }, automationIds: [1] }),
        );
        await EventBus.instance.idle();
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
      const { save, sendText, prompts } = setupAutomationDelivery(scope);

      await fire(
        cron({
          scope,
          content: { kind: "task", prompt: "Prepare briefing.", fallback: "Briefing unavailable." },
          automationIds: [metrics.id],
        }),
      );
      await EventBus.instance.idle();

      expect(prompts[0]).toContain("Prepare briefing.\n\n<automation_outputs>");
      expect(prompts[0]).toContain('"data": {');
      expect(sendText).toHaveBeenCalledWith(chatId, "Your briefing.");
      expect(save).toHaveBeenCalledWith(
        expect.anything(),
        scope,
        "[CRON TASK daily]: Your briefing.",
        expect.stringContaining("It also used the outputs of the job's automations."),
        expect.any(Number),
      );
    });

    test("sends a fixed notice when an automation of a passthrough job fails", async () => {
      const broken = await saveAutomation(
        scope,
        "broken",
        "export default async () => { throw new Error('boom'); }",
      );
      const { save, sendText } = setupAutomationDelivery(scope);

      await fire(cron({ scope, content: { kind: "automations" }, automationIds: [broken.id] }));
      await EventBus.instance.idle();

      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith(
        chatId,
        'Automation "broken" failed in this run. Ask me what went wrong.',
      );
      expect(save).toHaveBeenCalledWith(
        expect.anything(),
        scope,
        expect.stringMatching(/^\[CRON TASK daily\]: Automation "broken" failed/),
        expect.stringContaining("had an automation fail"),
        expect.any(Number),
      );
    });

    test("leaves a failing automation of a task job to the task's message", async () => {
      const broken = await saveAutomation(
        scope,
        "broken",
        "export default async () => { throw new Error('boom'); }",
      );
      const { sendText } = setupAutomationDelivery(scope);

      await fire(
        cron({
          scope,
          content: { kind: "task", prompt: "Prepare briefing.", fallback: "Briefing unavailable." },
          automationIds: [broken.id],
        }),
      );
      await EventBus.instance.idle();

      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith(chatId, "Your briefing.");
    });

    test("sends one fixed notice when a run pauses an automation", async () => {
      const broken = await saveAutomation(
        scope,
        "broken",
        "export default async () => { throw new Error('boom'); }",
      );
      await AutomationService.instance.recordFailure(broken.id, "boom");
      await AutomationService.instance.recordFailure(broken.id, "boom");
      const { save, sendText } = setupAutomationDelivery(scope);
      const job = cron({ scope, content: { kind: "automations" }, automationIds: [broken.id] });

      await fire(job);
      await EventBus.instance.idle();
      await fire(job);
      await EventBus.instance.idle();

      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith(
        chatId,
        expect.stringMatching(
          /^Automation "broken" was paused after 3 failed runs\. Ask me to fix it\.$/,
        ),
      );
      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith(
        expect.anything(),
        scope,
        expect.stringMatching(/^\[CRON TASK daily\]: Automation "broken" was paused/),
        expect.stringContaining("paused a failing automation"),
        expect.any(Number),
      );
    });
  });
});
