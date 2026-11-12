import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import {
  AuthorizationService,
  EAuthorizationDecision,
  type TAuthorizationResult,
} from "../authorization";
import { DatabaseConnector } from "../database";
import { eventDeliveriesTable, eventsTable } from "../database/schema";
import { resetEventTables } from "../database/test-utils";
import { EventBus, type TEventDraft } from "../events";
import { EEventType } from "../events/catalog";
import { Memory } from "../memory";
import { SettingsService } from "../settings";
import { MessagingAdapter } from ".";
import { EMessagePlatform, type TPlatformMessage } from "./types";

type TAdapterInternals = {
  authorization: {
    authorize: ReturnType<typeof mock>;
  };
};

const originalActivationToken = Bun.env.BELLACLAW_ACTIVATION_TOKEN;

function authorizationResult(
  decision: EAuthorizationDecision,
  failedAttempts: number,
): TAuthorizationResult {
  return { decision, failedAttempts };
}

function reset() {
  (AuthorizationService as unknown as { _instance: unknown })._instance = undefined;
  (MessagingAdapter as unknown as { _instance: unknown })._instance = undefined;
  (Memory as unknown as { _instance: unknown })._instance = undefined;
  (SettingsService as unknown as { _instance: unknown })._instance = undefined;
}

async function payloadsOf(type: EEventType) {
  const rows = await DatabaseConnector.instance.database
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.type, type))
    .orderBy(asc(eventsTable.seq));
  return rows.map((row) => row.payload);
}

beforeEach(async () => {
  reset();
  await resetEventTables();
  Object.assign(EventBus, { _instance: undefined });
  Bun.env.BELLACLAW_ACTIVATION_TOKEN = undefined;
});

afterEach(() => {
  reset();
  Bun.env.BELLACLAW_ACTIVATION_TOKEN = originalActivationToken;
});

describe("MessagingAdapter", () => {
  test("captures arrival before awaiting authorization", async () => {
    const arrival = new Date("2026-07-24T21:59:50.000Z");
    const adapter = MessagingAdapter.instance;
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

      expect(await payloadsOf(EEventType.TurnRequested)).toEqual([
        {
          chatId: "signal:+100",
          content: "What is on my calendar tomorrow?",
          receivedAt: arrival.getTime(),
          platform: EMessagePlatform.Signal,
        },
      ]);
    } finally {
      setSystemTime();
    }
  });

  test("silently rejects failures and replies to activation without requesting a turn", async () => {
    const adapter = MessagingAdapter.instance;
    const internals = adapter as unknown as TAdapterInternals;
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
    expect(await payloadsOf(EEventType.ReplyReady)).toEqual([]);
    expect(await payloadsOf(EEventType.TurnRequested)).toEqual([]);

    message.message.content = "token";
    await adapter.handleInboundMessage(message);
    await adapter.handleInboundMessage(message);
    expect(await payloadsOf(EEventType.ReplyReady)).toEqual([
      { chatId: "discord:user-1", text: "Activated." },
      { chatId: "discord:user-1", text: "Already activated." },
    ]);
    expect(await payloadsOf(EEventType.TurnRequested)).toEqual([]);

    message.message.content = "hello";
    await adapter.handleInboundMessage(message);
    expect(await payloadsOf(EEventType.TurnRequested)).toEqual([
      expect.objectContaining({ chatId: "discord:user-1", content: "hello" }),
    ]);
    expect(internals.authorization.authorize).toHaveBeenCalledWith("discord:user-1", "wrong");
  });

  test("requests MCP prompt commands as a turn keyed by the canonical chat id with its trace", async () => {
    const originalMcpConfig = Bun.env.BELLACLAW_MCP_CONFIG;
    const directory = await mkdtemp(join(tmpdir(), "bellaclaw-messaging-mcp-"));

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

      await MessagingAdapter.instance.handleInboundMessage({
        platform: EMessagePlatform.Discord,
        chatId: "channel-1",
        message: {
          content: '!mcp-prompt documents summarize {"style":"brief"}',
        },
      });

      const rows = await DatabaseConnector.instance.database
        .select()
        .from(eventsTable)
        .where(eq(eventsTable.type, EEventType.TurnRequested));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.key).toBe("discord:channel-1");
      expect(rows[0]?.chatId).toBe("discord:channel-1");
      expect(rows[0]?.platform).toBe(EMessagePlatform.Discord);
      expect(rows[0]?.turnId).toEqual(expect.any(String));
      expect(rows[0]?.payload).toEqual({
        chatId: "discord:channel-1",
        content:
          'Use MCP profile documents to run the explicitly requested prompt template summarize with arguments {"style":"brief"}.',
        receivedAt: expect.any(Number),
        platform: EMessagePlatform.Discord,
      });
    } finally {
      if (originalMcpConfig === undefined) {
        delete Bun.env.BELLACLAW_MCP_CONFIG;
      } else {
        Bun.env.BELLACLAW_MCP_CONFIG = originalMcpConfig;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("replies when MCP prompt commands encounter configuration errors", async () => {
    const originalMcpConfig = Bun.env.BELLACLAW_MCP_CONFIG;
    const directory = await mkdtemp(join(tmpdir(), "bellaclaw-messaging-mcp-errors-"));

    try {
      const configPath = join(directory, "mcp.json");
      await Bun.write(configPath, JSON.stringify({ profiles: [] }));
      Bun.env.BELLACLAW_MCP_CONFIG = configPath;

      const adapter = MessagingAdapter.instance;
      const message: TPlatformMessage = {
        platform: EMessagePlatform.Discord,
        chatId: "channel-1",
        message: { content: "!mcp-prompt missing summarize" },
      };

      await adapter.handleInboundMessage(message);

      await Bun.write(configPath, JSON.stringify({ profiles: [{ id: "INVALID" }] }));
      message.message.content = "!mcp-prompts";
      await adapter.handleInboundMessage(message);

      expect(await payloadsOf(EEventType.ReplyReady)).toEqual([
        {
          chatId: "discord:channel-1",
          text: "MCP prompt request failed: Error: Unknown MCP profile: missing",
        },
        {
          chatId: "discord:channel-1",
          text: expect.stringContaining(
            "MCP prompt listing failed: Error: Invalid MCP configuration:",
          ),
        },
      ]);
      expect(await payloadsOf(EEventType.TurnRequested)).toEqual([]);
    } finally {
      if (originalMcpConfig === undefined) {
        delete Bun.env.BELLACLAW_MCP_CONFIG;
      } else {
        Bun.env.BELLACLAW_MCP_CONFIG = originalMcpConfig;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("MessagingAdapter outbound", () => {
  let bus: EventBus;

  function notice(): TEventDraft<EEventType.NoticeReady> {
    return {
      type: EEventType.NoticeReady,
      source: "test",
      key: "signal:+100",
      trace: { turnId: "test:outbound", chatId: "signal:+100", platform: undefined },
      payload: { chatId: "signal:+100", text: "Notice" },
      causationId: undefined,
      dedupeKey: undefined,
    };
  }

  async function deliveries() {
    return DatabaseConnector.instance.database.select().from(eventDeliveriesTable);
  }

  async function sentEvents() {
    return DatabaseConnector.instance.database
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.type, EEventType.MessageSent));
  }

  beforeEach(() => {
    bus = EventBus.instance;
  });

  afterEach(async () => {
    await bus.idle();
    await bus.stop();
  });

  test("retries a missing transport and delivers once it registers", async () => {
    const sendText = mock(async () => undefined);
    const adapter = MessagingAdapter.instance;
    Object.assign(adapter, { outboundBackoffMs: [20, 20, 20, 20, 20] });
    adapter.setup();
    await bus.start();

    await bus.publish(notice());
    while (((await deliveries())[0]?.attempts ?? 0) < 1) {
      await Bun.sleep(1);
    }
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    await bus.idle();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("+100", "Notice");
    expect((await deliveries()).map((row) => [row.consumer, row.status])).toEqual([
      ["outbound", "done"],
    ]);
    expect((await sentEvents()).map((row) => row.payload)).toEqual([
      {
        chatId: "signal:+100",
        sourceType: EEventType.NoticeReady,
        chars: 6,
        sentAt: expect.any(Number),
      },
    ]);
  });

  test("delivers reply.ready to its transport and absorbs a transport failure", async () => {
    const sendText = mock(async () => undefined);
    const adapter = MessagingAdapter.instance;
    Object.assign(adapter, { outboundBackoffMs: [] });
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    adapter.setup();
    await bus.start();
    const reply = { ...notice(), type: EEventType.ReplyReady };

    await bus.publish({ ...reply, payload: { chatId: "signal:+100", text: "Root reply" } });
    await bus.idle();
    expect(sendText).toHaveBeenCalledWith("+100", "Root reply");

    sendText.mockImplementation(async () => {
      throw new Error("offline");
    });
    await expect(
      bus.publish({ ...reply, payload: { chatId: "signal:+100", text: "again" } }),
    ).resolves.toBeUndefined();
    await bus.idle();
    expect((await deliveries()).map((row) => row.status)).toEqual(["done", "dead"]);
  });

  test("a failed send does not publish message.sent", async () => {
    const sendText = mock(async () => {
      throw new Error("offline");
    });
    const adapter = MessagingAdapter.instance;
    Object.assign(adapter, { outboundBackoffMs: [] });
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    adapter.setup();
    await bus.start();

    await bus.publish(notice());
    await bus.idle();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect((await deliveries()).map((row) => [row.consumer, row.status])).toEqual([
      ["outbound", "dead"],
    ]);
    expect(await sentEvents()).toEqual([]);
  });
});
