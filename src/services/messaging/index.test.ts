import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ECronEngineJobType, type TCronEngineJobContext } from "../../lib/cron-engine";
import { ERole } from "../ai/types";
import { CronSingleton } from "../cron";
import { Memory } from "../memory";
import { EMemoryImportance } from "../memory/types";
import { MessagingAdapter } from "./index";
import { EMessagePlatform, type TMessageTransport } from "./types";

type TMessagingAdapterStatic = {
  _instance: MessagingAdapter | undefined;
};

type TMessagingAdapterInternals = {
  handleCronFire: (ctx: TCronEngineJobContext) => Promise<void>;
};

type TCronSingletonStatic = {
  _instance: CronSingleton | undefined;
};

type TMemoryStatic = {
  _instance: Memory | undefined;
};

function cleanupSingletons() {
  const MessagingAdapterWithInternals = MessagingAdapter as unknown as TMessagingAdapterStatic;
  MessagingAdapterWithInternals._instance = undefined;

  const CronSingletonWithInternals = CronSingleton as unknown as TCronSingletonStatic;
  CronSingletonWithInternals._instance?.destroy();
  CronSingletonWithInternals._instance = undefined;

  const MemoryWithInternals = Memory as unknown as TMemoryStatic;
  MemoryWithInternals._instance = undefined;
}

function createTransport(platform: EMessagePlatform) {
  const sendText = mock(async () => {});
  const transport: TMessageTransport = {
    platform,
    sendText,
  };

  return { transport, sendText };
}

function createCronContext(scope: string): TCronEngineJobContext {
  const now = new Date("2026-01-01T00:00:00.000Z");

  return {
    name: "reminder",
    scope,
    group: undefined,
    type: ECronEngineJobType.Recurring,
    pattern: "* * * * *",
    nextRunAt: now,
    lastRunAt: undefined,
    reminderText: "time to move",
    reminderPromptData: undefined,
    reminderFallbackText: undefined,
    createdAt: now,
  };
}

describe("MessagingAdapter", () => {
  beforeEach(() => {
    cleanupSingletons();
  });

  afterEach(() => {
    cleanupSingletons();
  });

  test("routes cron reminders to discord and signal transports", async () => {
    const adapter = MessagingAdapter.instance;
    const discord = createTransport(EMessagePlatform.Discord);
    const signal = createTransport(EMessagePlatform.Signal);
    const saveMock = mock(async () => ({
      chatId: "discord:123",
      author: ERole.Assistant,
      importance: EMemoryImportance.Low,
      message: "saved",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    const MemoryWithInternals = Memory as unknown as TMemoryStatic;
    MemoryWithInternals._instance = {
      save: saveMock,
    } as unknown as Memory;

    adapter.registerTransport(discord.transport);
    adapter.registerTransport(signal.transport);

    const internals = adapter as unknown as TMessagingAdapterInternals;

    await internals.handleCronFire(createCronContext("discord:123"));
    await internals.handleCronFire(createCronContext("signal:+100"));

    expect(discord.sendText).toHaveBeenCalledWith("123", "time to move");
    expect(signal.sendText).toHaveBeenCalledWith("+100", "time to move");
    expect(saveMock).toHaveBeenCalledTimes(2);
  });
});
