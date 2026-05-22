import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ECronEngineJobType, type TCronEngineJobContext } from "../../lib/cron-engine";
import { CronSingleton } from "../cron";
import { DiscordSingleton } from "./index";

const TEST_DB = join(import.meta.dir, "../../../test-discord-cron-service.db");

type TDiscordSingletonInternals = {
  ai: {
    runToolTask: typeof import("../ai/api").AiConnector.prototype.runToolTask;
  };
  client: {
    users: {
      fetch: (userId: string) => Promise<{
        send: (text: string) => Promise<void>;
      }>;
    };
  };
  handleCronFire: (ctx: TCronEngineJobContext) => Promise<void>;
  onReady: (client: { user: { tag: string } }) => Promise<void>;
};

type TDiscordSingletonStatic = {
  _instance: DiscordSingleton | undefined;
};

type TCronSingletonStatic = {
  _instance: CronSingleton | undefined;
};

function cleanupSingletons() {
  const CronSingletonWithInternals = CronSingleton as unknown as TCronSingletonStatic;
  CronSingletonWithInternals._instance?.destroy();
  CronSingletonWithInternals._instance = undefined;
  CronSingleton.resetDbFile();

  const DiscordSingletonWithInternals = DiscordSingleton as unknown as TDiscordSingletonStatic;
  DiscordSingletonWithInternals._instance = undefined;

  if (existsSync(TEST_DB)) {
    unlinkSync(TEST_DB);
  }
}

function createCronContext(overrides: Partial<TCronEngineJobContext> = {}): TCronEngineJobContext {
  return {
    name: "study-checkin",
    scope: "user-1",
    group: undefined,
    type: ECronEngineJobType.Recurring,
    pattern: "*/30 * * * *",
    reminderText: undefined,
    reminderPromptData: undefined,
    reminderFallbackText: "Fallback reminder.",
    lastRunAt: undefined,
    nextRunAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

describe("DiscordSingleton", () => {
  beforeEach(() => {
    cleanupSingletons();
    CronSingleton.setDbFile(TEST_DB);
  });

  afterEach(() => {
    cleanupSingletons();
  });

  test("starts cron after Discord client is ready", async () => {
    const discord = DiscordSingleton.instance as unknown as TDiscordSingletonInternals;
    const cron = CronSingleton.instance as unknown as { setup: () => void };
    const setupMock = mock(() => {});

    cron.setup = setupMock;

    await discord.onReady({
      user: {
        tag: "BellaClaw#0001",
      },
    });

    expect(setupMock).toHaveBeenCalledTimes(1);
  });

  test("uses generated reminder text when reminderPromptData is present", async () => {
    const discord = DiscordSingleton.instance as unknown as TDiscordSingletonInternals;
    const sendMock = mock(async (_text: string) => {});
    const fetchMock = mock(async (_userId: string) => ({
      send: sendMock,
    }));
    const runToolTaskMock = mock(async () => ({
      assistantResponse: "Stay focused on your study session.",
      toolCalls: [],
      toolResults: [],
    }));

    discord.client = {
      users: {
        fetch: fetchMock,
      },
    };
    discord.ai = {
      runToolTask: runToolTaskMock,
    };

    await discord.handleCronFire(
      createCronContext({
        reminderPromptData: '{"topic":"study","tone":"encouraging"}',
      }),
    );

    expect(runToolTaskMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("user-1");
    expect(sendMock).toHaveBeenCalledWith("Stay focused on your study session.");
  });

  test("falls back when generated reminder text is empty", async () => {
    const discord = DiscordSingleton.instance as unknown as TDiscordSingletonInternals;
    const sendMock = mock(async (_text: string) => {});
    const fetchMock = mock(async (_userId: string) => ({
      send: sendMock,
    }));
    const runToolTaskMock = mock(async () => ({
      assistantResponse: "   ",
      toolCalls: [],
      toolResults: [],
    }));

    discord.client = {
      users: {
        fetch: fetchMock,
      },
    };
    discord.ai = {
      runToolTask: runToolTaskMock,
    };

    await discord.handleCronFire(
      createCronContext({
        reminderPromptData: '{"topic":"study","tone":"encouraging"}',
        reminderFallbackText: "Fallback reminder.",
      }),
    );

    expect(runToolTaskMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("user-1");
    expect(sendMock).toHaveBeenCalledWith("Fallback reminder.");
  });

  test("falls back when direct reminder text is blank", async () => {
    const discord = DiscordSingleton.instance as unknown as TDiscordSingletonInternals;
    const sendMock = mock(async (_text: string) => {});
    const fetchMock = mock(async (_userId: string) => ({
      send: sendMock,
    }));
    const runToolTaskMock = mock(async () => ({
      assistantResponse: "should not be used",
      toolCalls: [],
      toolResults: [],
    }));

    discord.client = {
      users: {
        fetch: fetchMock,
      },
    };
    discord.ai = {
      runToolTask: runToolTaskMock,
    };

    await discord.handleCronFire(
      createCronContext({
        reminderText: "   ",
        reminderFallbackText: "Fallback reminder.",
      }),
    );

    expect(runToolTaskMock).toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledWith("user-1");
    expect(sendMock).toHaveBeenCalledWith("Fallback reminder.");
  });
});
