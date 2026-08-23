import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
    sourceName: string;
    message: string;
    timestamp: number | undefined;
  }) => Promise<void>;
};

type TMessagingAdapterStatic = {
  _instance: MessagingAdapter | undefined;
};

const originalCheckReadiness = SignalClient.prototype.checkReadiness;
const originalSubscribe = SignalClient.prototype.subscribe;

function cleanupSingletons() {
  const SignalSingletonWithInternals = SignalSingleton as unknown as TSignalSingletonStatic;
  SignalSingletonWithInternals._instance = undefined;

  const MessagingAdapterWithInternals = MessagingAdapter as unknown as TMessagingAdapterStatic;
  MessagingAdapterWithInternals._instance = undefined;
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

  test("forwards inbound messages to messaging adapter", async () => {
    Bun.env.SIGNAL_PHONE_NUMBER = "+100";
    const signal = SignalSingleton.instance as unknown as TSignalSingletonInternals;
    const adapter = MessagingAdapter.instance as unknown as {
      handleInboundMessage: typeof MessagingAdapter.prototype.handleInboundMessage;
    };
    const handleInboundMessageMock = mock(async () => {});
    const sendReadReceiptMock = mock(async () => {});
    const showTypingMock = mock(async () => {});
    const hideTypingMock = mock(async () => {});

    adapter.handleInboundMessage = handleInboundMessageMock;
    signal.client = {
      sendReadReceipt: sendReadReceiptMock,
      showTyping: showTypingMock,
      hideTyping: hideTypingMock,
    };

    await signal.handleInboundMessage({
      sourceNumber: "+200",
      sourceName: "Alice",
      message: "hello",
      timestamp: 123,
    });

    expect(sendReadReceiptMock).toHaveBeenCalledWith("+200", 123);
    expect(handleInboundMessageMock).toHaveBeenCalledWith({
      platform: EMessagePlatform.Signal,
      chatId: "+200",
      author: {
        id: "+200",
        username: "Alice",
      },
      message: {
        type: "text",
        content: "hello",
      },
    });
  });

  test("does not wait for typing indicator before forwarding inbound messages", async () => {
    Bun.env.SIGNAL_PHONE_NUMBER = "+100";
    const signal = SignalSingleton.instance as unknown as TSignalSingletonInternals;
    const adapter = MessagingAdapter.instance as unknown as {
      handleInboundMessage: typeof MessagingAdapter.prototype.handleInboundMessage;
    };
    const handleInboundMessageMock = mock(async () => {});

    adapter.handleInboundMessage = handleInboundMessageMock;
    signal.client = {
      sendReadReceipt: mock(async () => {}),
      showTyping: mock(() => new Promise<void>(() => {})),
      hideTyping: mock(async () => {}),
    };

    const result = await Promise.race([
      signal
        .handleInboundMessage({
          sourceNumber: "+200",
          sourceName: "Alice",
          message: "hello",
          timestamp: 123,
        })
        .then(() => "handled"),
      Bun.sleep(20).then(() => "timeout"),
    ]);

    expect(result).toBe("handled");
    expect(handleInboundMessageMock).toHaveBeenCalledTimes(1);
  });

  // NOTE: boot calls CronScheduler.setup() only after every transport resolves, so a setup that
  // waits out an unreachable signal-cli-rest-api leaves every scheduled job without a timer.
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

    // NOTE: the retry loop only exits once a client is set, and it would otherwise keep polling
    // for the rest of the test process.
    signal.client = {} as never;
    await Bun.sleep(20);
  });
});
