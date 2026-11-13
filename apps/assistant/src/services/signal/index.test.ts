import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EEventType, eventsTable } from "@bellaclaw/database";
import { asc, eq } from "drizzle-orm";
import { DatabaseConnector } from "../database";
import { resetEventTables } from "../database/test-utils";
import { EventBus } from "../events";
import type { TEventPayloads } from "../events/catalog";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform } from "../messaging/types";
import { SignalClient } from "./client";
import { SignalSingleton } from "./index";

type TSignalSingletonStatic = {
  _instance: SignalSingleton | undefined;
};

type TSignalSingletonInternals = {
  retryDelayMs: number;
  setupBootGraceMs: number;
  client: Pick<SignalClient, "sendReadReceipt" | "showTyping" | "hideTyping"> | undefined;
  handleInboundMessage: (message: {
    sourceNumber: string;
    message: string;
    attachments: { id: string; mimeType: string }[];
    timestamp: number | undefined;
  }) => Promise<void>;
};

type TMessagingAdapterStatic = {
  _instance: MessagingAdapter | undefined;
};

function receivedRows() {
  return DatabaseConnector.instance.database
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.type, EEventType.MessageReceived))
    .orderBy(asc(eventsTable.seq));
}

const originalCheckReadiness = SignalClient.prototype.checkReadiness;
const originalSubscribe = SignalClient.prototype.subscribe;

function cleanupSingletons() {
  const SignalSingletonWithInternals = SignalSingleton as unknown as TSignalSingletonStatic;
  SignalSingletonWithInternals._instance = undefined;

  const MessagingAdapterWithInternals = MessagingAdapter as unknown as TMessagingAdapterStatic;
  MessagingAdapterWithInternals._instance = undefined;

  Object.assign(EventBus, { _instance: undefined });
}

describe("SignalSingleton", () => {
  beforeEach(() => {
    cleanupSingletons();
    Bun.env.SIGNAL_ENABLED = undefined;
    Bun.env.SIGNAL_PHONE_NUMBER = undefined;
    Bun.env.SIGNAL_CLI_RPC_URL = undefined;
  });

  afterEach(() => {
    SignalClient.prototype.checkReadiness = originalCheckReadiness;
    SignalClient.prototype.subscribe = originalSubscribe;
    cleanupSingletons();
    Bun.env.SIGNAL_ENABLED = undefined;
    Bun.env.SIGNAL_PHONE_NUMBER = undefined;
    Bun.env.SIGNAL_CLI_RPC_URL = undefined;
  });

  test("disabled setup does not initialize Signal client", async () => {
    const readinessMock = mock(async () => true);
    SignalClient.prototype.checkReadiness = readinessMock;

    await SignalSingleton.instance.setup();

    expect(readinessMock).toHaveBeenCalledTimes(0);
  });

  test("retries receive subscription until active", async () => {
    Bun.env.SIGNAL_ENABLED = "true";
    Bun.env.SIGNAL_PHONE_NUMBER = "+100";
    Bun.env.SIGNAL_CLI_RPC_URL = "http://127.0.0.1:8080";

    const readinessMock = mock(async () => true);
    let subscribeCalls = 0;
    const subscribeMock = mock(async () => {
      subscribeCalls += 1;
      if (subscribeCalls === 1) {
        return undefined;
      }

      return () => {};
    });
    SignalClient.prototype.checkReadiness = readinessMock;
    SignalClient.prototype.subscribe = subscribeMock;

    const signal = SignalSingleton.instance as unknown as TSignalSingletonInternals;
    signal.retryDelayMs = 1;

    await SignalSingleton.instance.setup();

    expect(readinessMock).toHaveBeenCalledTimes(2);
    expect(subscribeMock).toHaveBeenCalledTimes(2);
  });

  test("retries readiness then resolves after success without duplicate subscriptions", async () => {
    Bun.env.SIGNAL_ENABLED = "true";
    Bun.env.SIGNAL_PHONE_NUMBER = "+100";
    Bun.env.SIGNAL_CLI_RPC_URL = "http://127.0.0.1:8080";

    let readinessCalls = 0;
    const readinessMock = mock(async () => {
      readinessCalls += 1;
      return readinessCalls > 1;
    });
    const subscribeMock = mock(async () => () => {});
    SignalClient.prototype.checkReadiness = readinessMock;
    SignalClient.prototype.subscribe = subscribeMock;

    const signal = SignalSingleton.instance as unknown as TSignalSingletonInternals;
    signal.retryDelayMs = 1;

    const firstSetup = SignalSingleton.instance.setup();
    const secondSetup = SignalSingleton.instance.setup();
    await Promise.all([firstSetup, secondSetup]);

    expect(readinessMock).toHaveBeenCalledTimes(2);
    expect(subscribeMock).toHaveBeenCalledTimes(1);
  });

  test("sendText without a client rejects", async () => {
    await expect(SignalSingleton.instance.sendText("+200", "hello")).rejects.toThrow(
      "Signal client is not initialized",
    );
  });

  test("publishes inbound messages as message.received and sends a read receipt", async () => {
    Bun.env.SIGNAL_PHONE_NUMBER = "+100";
    await resetEventTables();
    const signal = SignalSingleton.instance as unknown as TSignalSingletonInternals;
    const sendReadReceiptMock = mock(async () => {});

    signal.client = {
      sendReadReceipt: sendReadReceiptMock,
      showTyping: mock(async () => {}),
      hideTyping: mock(async () => {}),
    };

    await signal.handleInboundMessage({
      sourceNumber: "+200",
      message: "hello",
      attachments: [],
      timestamp: 123,
    });

    expect(sendReadReceiptMock).toHaveBeenCalledWith("+200", 123);
    const rows = await receivedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe("signal:+200");
    expect(rows[0]?.dedupeKey).toBe("signal:+200:123");
    expect(rows[0]?.chatId).toBe("signal:+200");
    expect(rows[0]?.platform).toBe(EMessagePlatform.Signal);
    expect(rows[0]?.turnId).toStartWith("msg:");
    expect(rows[0]?.payload).toEqual({
      chatId: "signal:+200",
      content: "hello",
      attachments: [],
      receivedAt: expect.any(Number),
      platform: EMessagePlatform.Signal,
    });
  });

  test("a re-delivered message is one row and distinct ones are kept", async () => {
    Bun.env.SIGNAL_PHONE_NUMBER = "+100";
    await resetEventTables();
    const signal = SignalSingleton.instance as unknown as TSignalSingletonInternals;

    await signal.handleInboundMessage({
      sourceNumber: "+200",
      message: "hello",
      attachments: [],
      timestamp: 123,
    });
    await signal.handleInboundMessage({
      sourceNumber: "+200",
      message: "hello",
      attachments: [],
      timestamp: 123,
    });
    await signal.handleInboundMessage({
      sourceNumber: "+200",
      message: "hello",
      attachments: [],
      timestamp: 124,
    });
    await signal.handleInboundMessage({
      sourceNumber: "+300",
      message: "hello",
      attachments: [],
      timestamp: 123,
    });
    await signal.handleInboundMessage({
      sourceNumber: "+200",
      message: "hi",
      attachments: [],
      timestamp: undefined,
    });
    await signal.handleInboundMessage({
      sourceNumber: "+200",
      message: "hi",
      attachments: [],
      timestamp: undefined,
    });

    expect((await receivedRows()).map((row) => row.dedupeKey)).toEqual([
      "signal:+200:123",
      "signal:+200:124",
      "signal:+300:123",
      null,
      null,
    ]);
  });

  test("typing follows turn.requested, turn.completed, turn.failed and event.dead_lettered", async () => {
    Bun.env.SIGNAL_ENABLED = "true";
    Bun.env.SIGNAL_PHONE_NUMBER = "+100";
    Bun.env.SIGNAL_CLI_RPC_URL = "http://127.0.0.1:8080";
    SignalClient.prototype.checkReadiness = mock(async () => true);
    SignalClient.prototype.subscribe = mock(async () => () => {});
    await resetEventTables();
    await SignalSingleton.instance.setup();
    const signal = SignalSingleton.instance as unknown as TSignalSingletonInternals;
    const showTyping = mock(async (_recipient: string) => {});
    const hideTyping = mock(async (_recipient: string) => {});
    signal.client = { sendReadReceipt: mock(async () => {}), showTyping, hideTyping };
    const bus = EventBus.instance;
    await bus.start();
    const publish = <T extends EEventType>(type: T, chatId: string, payload: TEventPayloads[T]) =>
      bus.publish({
        type,
        source: "test",
        key: chatId,
        trace: { turnId: "test", chatId, platform: undefined },
        payload,
        causationId: undefined,
        dedupeKey: undefined,
      });

    try {
      await publish(EEventType.TurnRequested, "signal:+200", {
        chatId: "signal:+200",
        content: "hello",
        attachments: [],
        receivedAt: 1,
        platform: EMessagePlatform.Signal,
      });
      await publish(EEventType.TurnRequested, "discord:+200", {
        chatId: "discord:+200",
        content: "hello",
        attachments: [],
        receivedAt: 1,
        platform: EMessagePlatform.Discord,
      });
      await bus.idle();
      expect(showTyping.mock.calls).toEqual([["+200"]]);
      expect(hideTyping).not.toHaveBeenCalled();

      await publish(EEventType.TurnCompleted, "signal:+200", {
        chatId: "signal:+200",
        userMessageId: 1,
      });
      await publish(EEventType.TurnFailed, "signal:+200", {
        chatId: "signal:+200",
        reason: "error",
      });
      await publish(EEventType.EventDeadLettered, "signal:+200", {
        eventId: "event",
        eventType: EEventType.ReplyReady,
        consumer: "outbound",
        attempts: 1,
        error: "offline",
      });
      await bus.idle();
      expect(hideTyping.mock.calls).toEqual([["+200"], ["+200"], ["+200"]]);
    } finally {
      await bus.stop();
    }
  });

  test("resolves setup and keeps retrying when signal-cli never becomes ready", async () => {
    Bun.env.SIGNAL_ENABLED = "true";
    Bun.env.SIGNAL_PHONE_NUMBER = "+100";
    Bun.env.SIGNAL_CLI_RPC_URL = "http://127.0.0.1:8080";

    const readinessMock = mock(async () => false);
    const subscribeMock = mock(async () => () => {});
    SignalClient.prototype.checkReadiness = readinessMock;
    SignalClient.prototype.subscribe = subscribeMock;

    const signal = SignalSingleton.instance as unknown as TSignalSingletonInternals;
    signal.retryDelayMs = 1;
    signal.setupBootGraceMs = 5;

    const result = await Promise.race([
      SignalSingleton.instance.setup().then(() => "resolved"),
      Bun.sleep(2_000).then(() => "blocked"),
    ]);

    expect(result).toBe("resolved");
    expect(signal.client).toBeUndefined();
    expect(subscribeMock).toHaveBeenCalledTimes(0);

    const callsAtBoot = readinessMock.mock.calls.length;
    await Bun.sleep(20);
    expect(readinessMock.mock.calls.length).toBeGreaterThan(callsAtBoot);

    signal.client = {} as never;
    await Bun.sleep(20);
  });
});
