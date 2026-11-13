import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { AuthorizationService } from "../authorization";
import { DatabaseConnector } from "../database";
import { eventsTable } from "../database/schema";
import { resetEventTables } from "../database/test-utils";
import { EventBus } from "../events";
import { EEventType } from "../events/catalog";
import { EMessagePlatform } from "../messaging/types";
import { Commands } from ".";

const originalMcpConfig = Bun.env.BELLACLAW_MCP_CONFIG;

async function rowsOf(type: EEventType) {
  return DatabaseConnector.instance.database
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.type, type))
    .orderBy(asc(eventsTable.seq));
}

async function payloadsOf(type: EEventType) {
  return (await rowsOf(type)).map((row) => row.payload);
}

describe("commands consumer", () => {
  let bus: EventBus;
  let directory: string;

  async function authorized(
    chatId: string,
    content: string,
    receivedAt: number,
    attachments: { id: string; mimeType: string }[] = [],
  ) {
    await bus.publish({
      type: EEventType.MessageAuthorized,
      source: "test",
      key: chatId,
      trace: { turnId: "test:commands", chatId, platform: EMessagePlatform.Discord },
      payload: { chatId, content, attachments, receivedAt, platform: EMessagePlatform.Discord },
      causationId: undefined,
      dedupeKey: undefined,
    });
    await bus.idle();
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "bellaclaw-commands-"));
    await resetEventTables();
    Object.assign(Commands, { _instance: undefined });
    Object.assign(EventBus, { _instance: undefined });
    bus = EventBus.instance;
    Commands.instance.setup();
    await bus.start();
  });

  afterEach(async () => {
    await bus.idle();
    await bus.stop();
    if (originalMcpConfig === undefined) {
      delete Bun.env.BELLACLAW_MCP_CONFIG;
    } else {
      Bun.env.BELLACLAW_MCP_CONFIG = originalMcpConfig;
    }
    await rm(directory, { recursive: true, force: true });
  });

  test("a plain message becomes turn.requested with the transport's arrival time", async () => {
    await authorized("signal:+100", "What is on my calendar tomorrow?", 1_234);

    expect(await payloadsOf(EEventType.TurnRequested)).toEqual([
      {
        chatId: "signal:+100",
        content: "What is on my calendar tomorrow?",
        attachments: [],
        receivedAt: 1_234,
        platform: EMessagePlatform.Discord,
      },
    ]);
  });

  test("!update asks the supervisor for an update, and says so when there is none", async () => {
    const send = mock((_message: unknown) => true);
    const activated = spyOn(
      AuthorizationService.instance,
      "listAuthorizedChatIds",
    ).mockResolvedValue(["signal:+100"]);

    await authorized("signal:+100", "!update", 1);
    process.send = send;
    try {
      await authorized("signal:+100", "!update", 2);
      await authorized("signal:+999", "!update", 3);
    } finally {
      process.send = undefined;
      activated.mockRestore();
    }

    expect(send.mock.calls).toEqual([[{ type: "update" }]]);
    expect(await payloadsOf(EEventType.ReplyReady)).toEqual([
      {
        chatId: "signal:+100",
        text: "Self-update is unavailable: the bot is not running under its supervisor.",
      },
      { chatId: "signal:+100", text: "Checking for an update." },
      {
        chatId: "signal:+999",
        text: "Updating requires BELLACLAW_ACTIVATION_TOKEN and an activated chat.",
      },
    ]);
  });

  test("an MCP prompt command becomes turn.requested keyed by the chat with its trace", async () => {
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

    await authorized("discord:channel-1", '!mcp-prompt documents summarize {"style":"brief"}', 5, [
      { id: "m:a", mimeType: "image/png" },
    ]);

    const rows = await rowsOf(EEventType.TurnRequested);
    expect(rows[0]?.chatId).toBe("discord:channel-1");
    expect(rows[0]?.platform).toBe(EMessagePlatform.Discord);
    expect(rows[0]?.turnId).toBe("test:commands");
    expect(rows[0]?.payload).toEqual({
      chatId: "discord:channel-1",
      content:
        'Use MCP profile documents to run the explicitly requested prompt template summarize with arguments {"style":"brief"}.',
      attachments: [],
      receivedAt: 5,
      platform: EMessagePlatform.Discord,
    });
  });

  test("a command reply becomes reply.ready", async () => {
    const configPath = join(directory, "mcp.json");
    await Bun.write(configPath, JSON.stringify({ profiles: [] }));
    Bun.env.BELLACLAW_MCP_CONFIG = configPath;

    await authorized("discord:channel-1", "!mcp-prompt missing summarize", 1);
    await Bun.write(configPath, JSON.stringify({ profiles: [{ id: "INVALID" }] }));
    await authorized("discord:channel-1", "!mcp-prompts", 2);

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
  });
});
