import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ChannelType } from "discord.js";
import { CronScheduler } from "../cron";
import { DatabaseConnector } from "../database";
import { eventsTable } from "../database/schema";
import { resetCronEngineJobsTable, resetEventTables } from "../database/test-utils";
import { EventBus } from "../events";
import { EEventType } from "../events/catalog";
import { MessageHandler } from "../message-handler";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform } from "../messaging/types";
import { DiscordSingleton } from "./index";

type TDiscordSingletonInternals = {
  client: {
    login: (token: string) => Promise<string>;
    users: {
      fetch: (userId: string) => Promise<{
        send: (text: string) => Promise<void>;
      }>;
    };
  };
  handleMessage: (message: {
    id: string;
    author: { id: string };
    channel: { type: ChannelType };
    content: string;
    attachments: Map<string, { id: string; contentType: string | null }>;
  }) => Promise<void>;
  onReady: (client: { user: { tag: string } }) => Promise<void>;
  logger: { error: (message: string) => void };
};

type TDiscordSingletonStatic = {
  _instance: DiscordSingleton | undefined;
};

type TCronSchedulerStatic = {
  _instance: CronScheduler | undefined;
};

type TMessagingAdapterStatic = {
  _instance: MessagingAdapter | undefined;
};

const originalDiscordToken = Bun.env.DISCORD_TOKEN;

function cleanupSingletons() {
  const CronSchedulerWithInternals = CronScheduler as unknown as TCronSchedulerStatic;
  CronSchedulerWithInternals._instance?.destroy();
  CronSchedulerWithInternals._instance = undefined;

  const DiscordSingletonWithInternals = DiscordSingleton as unknown as TDiscordSingletonStatic;
  DiscordSingletonWithInternals._instance = undefined;

  const MessagingAdapterWithInternals = MessagingAdapter as unknown as TMessagingAdapterStatic;
  MessagingAdapterWithInternals._instance = undefined;

  Object.assign(MessageHandler, { _instance: undefined });
  Object.assign(EventBus, { _instance: undefined });
}

describe("DiscordSingleton", () => {
  beforeEach(async () => {
    cleanupSingletons();
    Bun.env.DISCORD_TOKEN = originalDiscordToken;
    await resetCronEngineJobsTable();
    await resetEventTables();
  });

  afterEach(() => {
    cleanupSingletons();
    Bun.env.DISCORD_TOKEN = originalDiscordToken;
  });

  test("disabled setup does not log in Discord client", async () => {
    Bun.env.DISCORD_TOKEN = undefined;
    const loginMock = mock(async () => "token");
    const discord = DiscordSingleton.instance as unknown as TDiscordSingletonInternals;
    discord.client = {
      login: loginMock,
    } as never;

    await DiscordSingleton.instance.setup();

    expect(loginMock).toHaveBeenCalledTimes(0);
  });

  test("does not start cron after Discord client is ready", async () => {
    const discord = DiscordSingleton.instance as unknown as TDiscordSingletonInternals;
    const cron = CronScheduler.instance as unknown as { setup: () => void };
    const setupMock = mock(() => {});

    cron.setup = setupMock;

    await discord.onReady({
      user: {
        tag: "BellaClaw#0001",
      },
    });

    expect(setupMock).toHaveBeenCalledTimes(0);
  });

  test("publishes an inbound Discord message as message.received", async () => {
    const discord = DiscordSingleton.instance as unknown as TDiscordSingletonInternals;
    discord.client = { user: { id: "bot-1" } } as never;

    await discord.handleMessage({
      id: "message-1",
      author: { id: "user-1" },
      channel: { type: ChannelType.DM },
      content: "hello",
      attachments: new Map(),
    });

    const rows = await DatabaseConnector.instance.database.select().from(eventsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe(EEventType.MessageReceived);
    expect(rows[0]?.key).toBe("discord:user-1");
    expect(rows[0]?.dedupeKey).toBe("discord:message-1");
    expect(rows[0]?.chatId).toBe("discord:user-1");
    expect(rows[0]?.platform).toBe(EMessagePlatform.Discord);
    expect(rows[0]?.turnId).toStartWith("msg:");
    expect(rows[0]?.payload).toEqual({
      chatId: "discord:user-1",
      content: "hello",
      attachments: [],
      receivedAt: expect.any(Number),
      platform: EMessagePlatform.Discord,
    });
  });

  test("references image attachments by message and attachment id and drops other files", async () => {
    const discord = DiscordSingleton.instance as unknown as TDiscordSingletonInternals;
    discord.client = { user: { id: "bot-1" } } as never;

    await discord.handleMessage({
      id: "message-1",
      author: { id: "user-1" },
      channel: { type: ChannelType.DM },
      content: "",
      attachments: new Map([
        ["att-1", { id: "att-1", contentType: "image/png" }],
        ["att-2", { id: "att-2", contentType: "application/pdf" }],
      ]),
    });
    await discord.handleMessage({
      id: "message-2",
      author: { id: "user-1" },
      channel: { type: ChannelType.DM },
      content: "",
      attachments: new Map([["att-3", { id: "att-3", contentType: "audio/ogg" }]]),
    });

    const rows = await DatabaseConnector.instance.database.select().from(eventsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({
      chatId: "discord:user-1",
      content: "",
      attachments: [{ id: "message-1:att-1", mimeType: "image/png" }],
      receivedAt: expect.any(Number),
      platform: EMessagePlatform.Discord,
    });
  });

  test("swallows and logs a publish failure instead of rejecting", async () => {
    const discord = DiscordSingleton.instance as unknown as TDiscordSingletonInternals;
    const errorMock = mock(() => undefined);

    Object.assign(EventBus.instance, {
      publish: mock(async () => {
        throw new Error("database is gone");
      }),
    });
    discord.logger = { error: errorMock };
    discord.client = { user: { id: "bot-1" } } as never;

    expect(
      await discord.handleMessage({
        id: "message-1",
        author: { id: "user-1" },
        channel: { type: ChannelType.DM },
        content: "hello",
        attachments: new Map(),
      }),
    ).toBeUndefined();
    expect(errorMock).toHaveBeenCalledWith(expect.stringContaining("database is gone"));
  });
});
