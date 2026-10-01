import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { ECronJobType, type TCronJobContext } from "../../lib/cron-engine";
import type { AgentHarness } from "../ai/agent-harness";
import { getAiModelConfig } from "../ai/providers/registry";
import { EAiProvider, EModelPurpose, ERole } from "../ai/types";
import {
  AuthorizationService,
  EAuthorizationDecision,
  type TAuthorizationResult,
} from "../authorization";
import { ConversationStore } from "../conversation";
import { conversationMessages, type TConversation } from "../conversation/types";
import { Memory } from "../memory";
import { EMemoryImportance } from "../memory/types";
import { MessageHandler } from "../message-handler";
import { getMessageTrace } from "../message-handler/trace";
import type { TIncommingMessage } from "../message-handler/types";
import { SettingsService } from "../settings";
import { DefaultConfigRecord } from "../settings/schema";
import { MessagingAdapter } from ".";
import { EMessagePlatform, type TMessageTransport, type TPlatformMessage } from "./types";

type TAdapterInternals = {
  authorization: {
    authorize: ReturnType<typeof mock>;
  };
  ai: {
    completeText: ReturnType<typeof mock>;
    runScheduledTask: ReturnType<typeof mock>;
  };
  transports: Map<EMessagePlatform, TMessageTransport>;
  runningCronTaskKeys: Set<string>;
  transportWaitAttempts: number;
  transportWaitIntervalMs: number;
  handleCronFire(ctx: TCronJobContext): Promise<void>;
};

const originalActivationToken = Bun.env.BELLACLAW_ACTIVATION_TOKEN;

function authorizationResult(
  decision: EAuthorizationDecision,
  failedAttempts: number,
): TAuthorizationResult {
  return { decision, failedAttempts };
}

function cron(overrides: Partial<TCronJobContext> = {}): TCronJobContext {
  return {
    name: "daily",
    scope: "signal:+100",
    group: undefined,
    type: ECronJobType.Recurring,
    pattern: "0 9 * * *",
    reminderText: "Take a break.",
    reminderPromptData: undefined,
    reminderFallbackText: undefined,
    taskPrompt: undefined,
    taskFallbackText: undefined,
    lastRunAt: undefined,
    nextRunAt: new Date("2026-07-24T08:00:00.000Z"),
    createdAt: new Date("2026-07-01T08:00:00.000Z"),
    timezone: "Europe/Warsaw",
    ...overrides,
  };
}

function reset() {
  (AuthorizationService as unknown as { _instance: unknown })._instance = undefined;
  (MessagingAdapter as unknown as { _instance: unknown })._instance = undefined;
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
    factQueue: { enqueue: async () => undefined },
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
  Bun.env.BELLACLAW_ACTIVATION_TOKEN = undefined;
});

afterEach(() => {
  reset();
  Bun.env.BELLACLAW_ACTIVATION_TOKEN = originalActivationToken;
});

describe("MessagingAdapter", () => {
  test("captures arrival before awaiting authorization", async () => {
    const arrival = new Date("2026-07-24T21:59:50.000Z");
    const originalGetInstance = MessageHandler.getInstance;
    const handleMessage = mock(async (_message: TIncommingMessage) => "Root reply");
    MessageHandler.getInstance = mock(() => ({
      handleMessage,
    })) as unknown as typeof MessageHandler.getInstance;
    const adapter = MessagingAdapter.instance;
    adapter.registerTransport({
      platform: EMessagePlatform.Signal,
      sendText: mock(async () => undefined),
    });
    const internals = adapter as unknown as TAdapterInternals;
    internals.authorization.authorize = mock(async () => {
      setSystemTime(new Date("2026-07-24T22:00:10.000Z"));
      return authorizationResult(EAuthorizationDecision.Allow, 0);
    });

    setSystemTime(arrival);
    try {
      await adapter.handleInboundMessage({
        platform: EMessagePlatform.Signal,
        chatId: "+100",
        message: { content: "What is on my calendar tomorrow?" },
      });

      expect(handleMessage.mock.calls[0]?.[0].receivedAt).toEqual(arrival);
    } finally {
      MessageHandler.getInstance = originalGetInstance;
      setSystemTime();
    }
  });

  test.each([
    "reminder",
    "task",
  ])("replays a delivered %s in the next Main request", async (kind) => {
    const chatId = `signal:replay-${kind}`;
    const { handler, runMain, message } = setupConversationHandler(chatId);
    await handler.handleMessage(message, EMessagePlatform.Signal);
    const adapter = MessagingAdapter.instance;
    const sendText = mock(async () => undefined);
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    const internals = adapter as unknown as TAdapterInternals;
    internals.ai = {
      completeText: mock(async () => undefined),
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
      context = cron({ scope: chatId, taskPrompt: "Prepare briefing", taskFallbackText: "Failed" });
      transcript = "[CRON TASK daily]: Your briefing is ready.";
    }

    await internals.handleCronFire(context);
    await handler.handleMessage(message, EMessagePlatform.Signal);

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
      { messages },
      new Set(),
    );
    expect(JSON.stringify(request)).toContain(transcript);
    expect(await ConversationStore.instance.load(chatId, EMessagePlatform.Discord)).toBeUndefined();
    const memories = await Memory.instance.findRecent(chatId, 10, EMessagePlatform.Signal);
    expect(memories.filter((row) => row.message === transcript)).toHaveLength(1);
    expect(memories.find((row) => row.message === transcript)?.importance).toBe(
      EMemoryImportance.Low,
    );
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
    const internals = adapter as unknown as TAdapterInternals;

    try {
      const turn = handler.handleMessage(message, EMessagePlatform.Signal);
      await started.promise;
      const delivery = internals.handleCronFire(cron({ scope: chatId }));
      await waitForCall(sendText);
      clock.mockReturnValue(deliveredAt + 60_000);
      finish.resolve();
      await turn;
      await delivery;
      await handler.handleMessage(message, EMessagePlatform.Signal);

      const conversation = runMain.mock.calls[1]?.[0].conversation;
      expect(conversation?.summary).toBe("The normal turn was summarized.");
      expect(conversation?.entries).toHaveLength(1);
      expect(conversation?.entries[0]?.message).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "[CRON REMINDER daily]: Take a break." }],
        timestamp: deliveredAt,
      });
      expect(conversation?.entries[0]?.id).toBeGreaterThan(conversation?.summarizedThroughId ?? 0);
      const saved = (await Memory.instance.findRecent(chatId, 10)).find((row) =>
        row.message.includes("CRON REMINDER"),
      );
      expect(saved?.createdAt.getTime()).toBe(deliveredAt);
    } finally {
      finish.resolve();
      clock.mockRestore();
    }
  });

  test("silently rejects failures and handles activation without invoking the AI", async () => {
    const originalGetInstance = MessageHandler.getInstance;
    const handleMessage = mock(async () => "Root reply");
    MessageHandler.getInstance = mock(() => ({
      handleMessage,
    })) as unknown as typeof MessageHandler.getInstance;
    const sendText = mock(async () => undefined);
    const adapter = MessagingAdapter.instance;
    const internals = adapter as unknown as TAdapterInternals;
    adapter.registerTransport({ platform: EMessagePlatform.Discord, sendText });
    const authorizationResults = [
      authorizationResult(EAuthorizationDecision.FailedAttempt, 1),
      authorizationResult(EAuthorizationDecision.Activated, 0),
      authorizationResult(EAuthorizationDecision.AlreadyActivated, 0),
      authorizationResult(EAuthorizationDecision.Allow, 0),
    ];
    internals.authorization = {
      authorize: mock(async () => {
        const result = authorizationResults.shift();

        if (result !== undefined) {
          return result;
        }

        throw new Error("Missing authorization result fixture");
      }),
    };

    const message = {
      platform: EMessagePlatform.Discord,
      chatId: "user-1",
      message: { content: "wrong" },
    };

    await adapter.handleInboundMessage(message);
    expect(sendText).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();

    message.message.content = "token";
    await adapter.handleInboundMessage(message);
    expect(sendText).toHaveBeenLastCalledWith("user-1", "Activated.");
    expect(handleMessage).not.toHaveBeenCalled();

    message.message.content = "token";
    await adapter.handleInboundMessage(message);
    expect(sendText).toHaveBeenLastCalledWith("user-1", "Already activated.");
    expect(handleMessage).not.toHaveBeenCalled();

    message.message.content = "hello";
    await adapter.handleInboundMessage(message);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenLastCalledWith("user-1", "Root reply");
    expect(internals.authorization.authorize).toHaveBeenCalledWith("discord:user-1", "wrong");

    MessageHandler.getInstance = originalGetInstance;
  });

  test("delivers the sole MessageHandler result and absorbs transport failures", async () => {
    const originalGetInstance = MessageHandler.getInstance;
    const handleMessage = mock(async () => "Root reply");
    MessageHandler.getInstance = mock(() => ({
      handleMessage,
    })) as unknown as typeof MessageHandler.getInstance;
    const sendText = mock(async () => undefined);
    const adapter = MessagingAdapter.instance;
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });

    await adapter.handleInboundMessage({
      platform: EMessagePlatform.Signal,
      chatId: "+100",
      message: { content: "hello" },
    });
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("+100", "Root reply");

    sendText.mockImplementation(async () => {
      throw new Error("offline");
    });
    await expect(
      adapter.handleInboundMessage({
        platform: EMessagePlatform.Signal,
        chatId: "+100",
        message: { content: "again" },
      }),
    ).resolves.toBeUndefined();
    MessageHandler.getInstance = originalGetInstance;
  });

  test("runs MCP prompt commands through the normal message pipeline with identity and trace", async () => {
    const originalGetInstance = MessageHandler.getInstance;
    const originalMcpConfig = Bun.env.BELLACLAW_MCP_CONFIG;
    const directory = await mkdtemp(join(tmpdir(), "bellaclaw-messaging-mcp-"));
    let receivedMessage: TIncommingMessage | undefined;
    let receivedPlatform: EMessagePlatform | undefined;
    const handleMessage = mock(async (message: TIncommingMessage, platform: EMessagePlatform) => {
      receivedMessage = message;
      receivedPlatform = platform;
      return "Prompt completed.";
    });
    MessageHandler.getInstance = mock(() => ({
      handleMessage,
    })) as unknown as typeof MessageHandler.getInstance;

    try {
      const configPath = join(directory, "mcp.json");
      await Bun.write(
        configPath,
        JSON.stringify({
          profiles: [
            {
              id: "documents",
              description: "Documents",
              instructions: "Use document prompts",
              transport: { type: "stdio", command: "unused" },
              prompts: true,
            },
          ],
        }),
      );
      Bun.env.BELLACLAW_MCP_CONFIG = configPath;

      const sendText = mock(async () => undefined);
      const adapter = MessagingAdapter.instance;
      adapter.registerTransport({ platform: EMessagePlatform.Discord, sendText });

      await adapter.handleInboundMessage({
        platform: EMessagePlatform.Discord,
        chatId: "channel-1",
        message: {
          content: '!mcp-prompt documents summarize {"style":"brief"}',
        },
      });

      expect(MessageHandler.getInstance).toHaveBeenCalledWith("discord:channel-1");
      expect(handleMessage).toHaveBeenCalledTimes(1);
      expect(receivedPlatform).toBe(EMessagePlatform.Discord);
      expect(receivedMessage).toEqual({
        chatId: "discord:channel-1",
        receivedAt: expect.any(Date),
        author: { type: ERole.User },
        message: {
          content:
            'Use MCP profile documents to run the explicitly requested prompt template summarize with arguments {"style":"brief"}.',
        },
      });
      expect(getMessageTrace(receivedMessage as TIncommingMessage)).toEqual({
        turnId: expect.any(String),
        chatId: "discord:channel-1",
        platform: EMessagePlatform.Discord,
      });
      expect(sendText).toHaveBeenCalledWith("channel-1", "Prompt completed.");
    } finally {
      MessageHandler.getInstance = originalGetInstance;
      if (originalMcpConfig === undefined) {
        delete Bun.env.BELLACLAW_MCP_CONFIG;
      } else {
        Bun.env.BELLACLAW_MCP_CONFIG = originalMcpConfig;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("replies when MCP prompt commands encounter configuration errors", async () => {
    const originalGetInstance = MessageHandler.getInstance;
    const originalMcpConfig = Bun.env.BELLACLAW_MCP_CONFIG;
    const directory = await mkdtemp(join(tmpdir(), "bellaclaw-messaging-mcp-errors-"));
    const handleMessage = mock(async () => "Unexpected AI reply");
    MessageHandler.getInstance = mock(() => ({
      handleMessage,
    })) as unknown as typeof MessageHandler.getInstance;

    try {
      const configPath = join(directory, "mcp.json");
      await Bun.write(configPath, JSON.stringify({ profiles: [] }));
      Bun.env.BELLACLAW_MCP_CONFIG = configPath;

      const sendText = mock(async () => undefined);
      const adapter = MessagingAdapter.instance;
      adapter.registerTransport({ platform: EMessagePlatform.Discord, sendText });
      const message: TPlatformMessage = {
        platform: EMessagePlatform.Discord,
        chatId: "channel-1",
        message: { content: "!mcp-prompt missing summarize" },
      };

      await adapter.handleInboundMessage(message);

      expect(sendText).toHaveBeenLastCalledWith(
        "channel-1",
        "MCP prompt request failed: Error: Unknown MCP profile: missing",
      );

      await Bun.write(configPath, JSON.stringify({ profiles: [{ id: "INVALID" }] }));
      message.message.content = "!mcp-prompts";
      await adapter.handleInboundMessage(message);

      expect(sendText).toHaveBeenLastCalledWith(
        "channel-1",
        expect.stringContaining("MCP prompt listing failed: Error: Invalid MCP configuration:"),
      );
      expect(handleMessage).not.toHaveBeenCalled();
    } finally {
      MessageHandler.getInstance = originalGetInstance;
      if (originalMcpConfig === undefined) {
        delete Bun.env.BELLACLAW_MCP_CONFIG;
      } else {
        Bun.env.BELLACLAW_MCP_CONFIG = originalMcpConfig;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("sends MCP connection notifications through the canonical chat transport", async () => {
    const sendText = mock(async () => undefined);
    const adapter = MessagingAdapter.instance;
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });

    await adapter.sendMcpConnectedMessage("signal:+15551234567", "documents");

    expect(sendText).toHaveBeenCalledWith("+15551234567", "Connected MCP profile documents.");
  });

  test("records the reminder transcript only after successful delivery", async () => {
    const save = mock(async () => undefined);
    Object.assign(MessageHandler.getInstance("signal:+100"), {
      conversations: { saveDeliveredMessage: save },
    });
    const sendText = mock(async () => undefined);
    const adapter = MessagingAdapter.instance;
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    const internals = adapter as unknown as TAdapterInternals;

    await internals.handleCronFire(cron());
    expect(sendText).toHaveBeenCalledWith("+100", "Take a break.");
    expect(save).toHaveBeenCalledWith(
      "signal:+100",
      EMessagePlatform.Signal,
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
    const internals = adapter as unknown as TAdapterInternals;
    internals.ai = {
      completeText: mock(async () => undefined),
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
      reminderText: undefined,
      taskPrompt: "Prepare briefing.",
      taskFallbackText: "Briefing unavailable.",
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
      EMessagePlatform.Signal,
      "[CRON TASK daily]: Briefing unavailable.",
      expect.any(Number),
    );
    expect(internals.runningCronTaskKeys.size).toBe(0);
  });

  test("waits for a still-connecting transport before giving up on a cron delivery", async () => {
    const adapter = MessagingAdapter.instance as unknown as TAdapterInternals;
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

    await adapter.handleCronFire(cron({ reminderText: "Take a break." }));

    expect(sendTextMock).toHaveBeenCalledWith("+100", "Take a break.");
  });
});
