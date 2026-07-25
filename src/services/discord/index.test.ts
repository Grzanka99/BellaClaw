import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ChannelType, DiscordjsErrorCodes } from "discord.js";
import type { TOption } from "../../types";
import { CronSingleton } from "../cron";
import { resetCronEngineJobsTable } from "../database/test-utils";
import { MessageHandler } from "../message-handler";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform } from "../messaging/types";
import { DiscordSingleton } from "./index";

type TReadyClient = {
  user: {
    tag: string;
  };
};

type TReadyListener = (client: TReadyClient) => void;

type TDiscordSingletonInternals = {
  client: {
    login: (token: string) => Promise<string>;
    off: (event: string, listener: TReadyListener) => void;
    on: (event: string, listener: () => void) => void;
    once: (event: string, listener: TReadyListener) => void;
    users?: {
      fetch: (userId: string) => Promise<{
        send: (text: string) => Promise<void>;
      }>;
    };
  };
  logger: {
    error: (message: string) => void;
    warning: (message: string) => void;
  };
  createClient: ReturnType<typeof mock>;
  retryDelayMs: number;
  retryTimer: TOption<ReturnType<typeof setTimeout>>;
  handleMessage: (message: {
    author: { id: string; username: string };
    channel: { type: ChannelType };
    content: string;
  }) => Promise<void>;
  onReady: (client: TReadyClient) => Promise<void>;
};

type TDiscordSingletonStatic = {
  _instance: DiscordSingleton | undefined;
};

type TCronSingletonStatic = {
  _instance: CronSingleton | undefined;
};

type TMessagingAdapterStatic = {
  _instance: MessagingAdapter | undefined;
};

const originalDiscordToken = Bun.env.DISCORD_TOKEN;

function cleanupSingletons() {
  const CronSingletonWithInternals = CronSingleton as unknown as TCronSingletonStatic;
  CronSingletonWithInternals._instance?.destroy();
  CronSingletonWithInternals._instance = undefined;

  const DiscordSingletonWithInternals = DiscordSingleton as unknown as TDiscordSingletonStatic;
  DiscordSingletonWithInternals._instance = undefined;

  const MessagingAdapterWithInternals = MessagingAdapter as unknown as TMessagingAdapterStatic;
  MessagingAdapterWithInternals._instance = undefined;

  (MessageHandler as unknown as { _instances: Map<string, MessageHandler> })._instances.clear();
}

describe("DiscordSingleton", () => {
  beforeEach(async () => {
    cleanupSingletons();
    await resetCronEngineJobsTable();
  });

  afterEach(() => {
    cleanupSingletons();

    if (originalDiscordToken === undefined) {
      delete Bun.env.DISCORD_TOKEN;
    } else {
      Bun.env.DISCORD_TOKEN = originalDiscordToken;
    }
  });

  test("stays unavailable without a configured Discord token", async () => {
    Bun.env.DISCORD_TOKEN = "   ";

    const discord = DiscordSingleton.instance as unknown as TDiscordSingletonInternals;
    const login = mock(async () => "token");
    const warning = mock(() => {});
    discord.client = {
      login,
    } as never;
    discord.logger.warning = warning;

    await expect(DiscordSingleton.instance.setup()).resolves.toBeUndefined();

    expect(login).toHaveBeenCalledTimes(0);
    expect(warning).toHaveBeenCalledWith("Discord unavailable: DISCORD_TOKEN is not configured");

    const adapter = MessagingAdapter.instance as unknown as {
      transports: Map<EMessagePlatform, unknown>;
    };
    expect(adapter.transports.has(EMessagePlatform.Discord)).toBeFalse();
  });

  test("recreates the Discord client and retries after a transient login failure", async () => {
    Bun.env.DISCORD_TOKEN = "discord-token";

    const discord = DiscordSingleton.instance as unknown as TDiscordSingletonInternals;
    discord.retryDelayMs = 1;
    const adapter = MessagingAdapter.instance as unknown as {
      registerTransport: ReturnType<typeof mock>;
    };
    const registerTransport = mock(() => {});
    const login = mock(async (_token: string) => {
      throw new Error("network unavailable");
    });
    const retryLogin = mock(async (_token: string) => {
      markRetryStarted();
      return "token";
    });
    const off = mock(() => {});
    const error = mock(() => {});
    let readyListener: TOption<TReadyListener>;
    let markRetryStarted: () => void = () => undefined;
    const retryStarted = new Promise<void>((resolve) => {
      markRetryStarted = resolve;
    });

    discord.client = {
      login,
      off,
      on: mock(() => {}),
      once: mock(() => {}),
    } as never;
    const retryClient = {
      login: retryLogin,
      off: mock(() => {}),
      on: mock(() => {}),
      once: mock((_event: string, listener: TReadyListener) => {
        readyListener = listener;
      }),
    };
    const createClient = mock(() => retryClient);
    discord.createClient = createClient;
    discord.logger.error = error;
    adapter.registerTransport = registerTransport;

    const setup = DiscordSingleton.instance.setup();
    const concurrentSetup = DiscordSingleton.instance.setup();

    expect(concurrentSetup).toBe(setup);
    await expect(setup).resolves.toBeUndefined();

    expect(login).toHaveBeenNthCalledWith(1, "discord-token");
    expect(off).toHaveBeenCalledTimes(1);
    expect(registerTransport).toHaveBeenCalledTimes(0);
    expect(error).toHaveBeenCalledWith(
      "Discord unavailable: failed to log in: Error: network unavailable",
    );
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(discord.client).toBe(retryClient);

    await retryStarted;
    expect(login).toHaveBeenCalledTimes(1);
    expect(retryLogin).toHaveBeenCalledWith("discord-token");
    expect(registerTransport).toHaveBeenCalledTimes(0);

    if (readyListener === undefined) {
      throw new Error("Expected the retry to register a ready listener");
    }

    readyListener({
      user: {
        tag: "BellaClaw#0001",
      },
    });

    await DiscordSingleton.instance.setup();

    expect(registerTransport).toHaveBeenCalledTimes(1);
    expect(registerTransport).toHaveBeenCalledWith(DiscordSingleton.instance);
  });

  test("does not retry an invalid Discord token", async () => {
    Bun.env.DISCORD_TOKEN = "invalid-token";

    const discord = DiscordSingleton.instance as unknown as TDiscordSingletonInternals;
    const invalidTokenError = Object.assign(new Error("An invalid token was provided."), {
      code: DiscordjsErrorCodes.TokenInvalid,
    });
    const login = mock(async () => {
      throw invalidTokenError;
    });
    const replacementLogin = mock(async () => "token");
    const replacementClient = {
      login: replacementLogin,
      off: mock(() => {}),
      on: mock(() => {}),
      once: mock(() => {}),
    };
    const createClient = mock(() => replacementClient);

    discord.client = {
      login,
      off: mock(() => {}),
      on: mock(() => {}),
      once: mock(() => {}),
    } as never;
    discord.createClient = createClient;

    await expect(DiscordSingleton.instance.setup()).resolves.toBeUndefined();

    expect(login).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(discord.client).toBe(replacementClient);
    expect(discord.retryTimer).toBeUndefined();
    expect(replacementLogin).toHaveBeenCalledTimes(0);
  });

  test("does not start cron after Discord client is ready", async () => {
    const discord = DiscordSingleton.instance as unknown as TDiscordSingletonInternals;
    const cron = CronSingleton.instance as unknown as { setup: () => void };
    const setupMock = mock(() => {});

    cron.setup = setupMock;

    await discord.onReady({
      user: {
        tag: "BellaClaw#0001",
      },
    });

    expect(setupMock).toHaveBeenCalledTimes(0);
  });

  test("forwards inbound Discord messages to messaging adapter", async () => {
    const discord = DiscordSingleton.instance as unknown as TDiscordSingletonInternals;
    const adapter = MessagingAdapter.instance as unknown as {
      handleInboundMessage: typeof MessagingAdapter.prototype.handleInboundMessage;
    };
    const handleInboundMessageMock = mock(async () => {});

    adapter.handleInboundMessage = handleInboundMessageMock;
    discord.client = {
      user: {
        id: "bot-1",
      },
      users: {
        fetch: mock(async () => ({
          send: mock(async () => {}),
        })),
      },
    } as never;

    await discord.handleMessage({
      author: {
        id: "user-1",
        username: "TestUser",
      },
      channel: {
        type: ChannelType.DM,
      },
      content: "hello",
    });

    expect(handleInboundMessageMock).toHaveBeenCalledWith({
      platform: EMessagePlatform.Discord,
      chatId: "user-1",
      author: {
        id: "user-1",
        username: "TestUser",
      },
      message: {
        type: "text",
        content: "hello",
      },
    });
  });

  test("absorbs inbound processing failures at the Discord event boundary", async () => {
    const discord = DiscordSingleton.instance as unknown as TDiscordSingletonInternals;
    const adapter = MessagingAdapter.instance as unknown as {
      handleInboundMessage: typeof MessagingAdapter.prototype.handleInboundMessage;
    };
    const handleInboundMessageMock = mock(async () => {
      throw new Error("assistant persistence failed");
    });
    const error = mock(() => {});

    adapter.handleInboundMessage = handleInboundMessageMock;
    discord.logger.error = error;
    discord.client = {
      user: {
        id: "bot-1",
      },
    } as never;

    await expect(
      discord.handleMessage({
        author: {
          id: "user-1",
          username: "TestUser",
        },
        channel: {
          type: ChannelType.DM,
        },
        content: "hello",
      }),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      "handleMessage: failed to process message from user-1: Error: assistant persistence failed",
    );
  });
});
