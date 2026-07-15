import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ChannelType } from "discord.js";
import { CronSingleton } from "../cron";
import { resetCronEngineJobsTable } from "../database/test-utils";
import { MessageHandler } from "../message-handler";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform } from "../messaging/types";
import { DiscordSingleton } from "./index";

type TDiscordSingletonInternals = {
  client: {
    users: {
      fetch: (userId: string) => Promise<{
        send: (text: string) => Promise<void>;
      }>;
    };
  };
  handleMessage: (message: {
    author: { id: string; username: string };
    channel: { type: ChannelType };
    content: string;
  }) => Promise<void>;
  onReady: (client: { user: { tag: string } }) => Promise<void>;
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
});
