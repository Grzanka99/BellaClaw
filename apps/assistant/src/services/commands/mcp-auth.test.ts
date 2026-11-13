import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TOption } from "@bellaclaw/shared";
import { asc, eq } from "drizzle-orm";
import { DatabaseConnector } from "../database";
import { eventsTable } from "../database/schema";
import { resetEventTables } from "../database/test-utils";
import { EventBus } from "../events";
import { EEventType } from "../events/catalog";
import { setupMcpAuth } from "../mcp/auth";
import { EMessagePlatform } from "../messaging/types";
import { Commands } from ".";

const chatId = "signal:+100";
let bus: EventBus;
let directory: string;
let previousConfig: TOption<string>;
let previousCredentials: TOption<string>;

async function rowsOf(type: EEventType) {
  return DatabaseConnector.instance.database
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.type, type))
    .orderBy(asc(eventsTable.seq));
}

// sends a message through the commands consumer and returns its reply
async function send(content: string) {
  await bus.publish({
    type: EEventType.MessageAuthorized,
    source: "test",
    key: chatId,
    trace: { turnId: "test:mcp-auth", chatId, platform: EMessagePlatform.Signal },
    payload: {
      chatId,
      content,
      attachments: [],
      receivedAt: Date.now(),
      platform: EMessagePlatform.Signal,
    },
    causationId: undefined,
    dedupeKey: undefined,
  });
  await bus.idle();
  const replies = await rowsOf(EEventType.ReplyReady);
  return (replies.at(-1)?.payload as { text: string }).text;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "bellaclaw-mcp-auth-command-"));
  previousConfig = Bun.env.BELLACLAW_MCP_CONFIG;
  previousCredentials = Bun.env.BELLACLAW_MCP_CREDENTIALS_PATH;
  Bun.env.BELLACLAW_MCP_CONFIG = join(directory, "mcp.json");
  Bun.env.BELLACLAW_MCP_CREDENTIALS_PATH = join(directory, "credentials.json");
  await Bun.write(
    join(directory, "mcp.json"),
    JSON.stringify({
      profiles: [
        {
          id: "vault",
          description: "Vault",
          instructions: "Use the vault",
          transport: { type: "http", url: "http://127.0.0.1:1/mcp", tokenAuth: true },
        },
      ],
    }),
  );
  await resetEventTables();
  Object.assign(EventBus, { _instance: undefined });
  Object.assign(Commands, { _instance: undefined });
  bus = EventBus.instance;
  Commands.instance.setup();
  setupMcpAuth();
  await bus.start();
});

afterEach(async () => {
  await bus.idle();
  await bus.stop();
  if (previousConfig === undefined) {
    delete Bun.env.BELLACLAW_MCP_CONFIG;
  } else {
    Bun.env.BELLACLAW_MCP_CONFIG = previousConfig;
  }
  if (previousCredentials === undefined) {
    delete Bun.env.BELLACLAW_MCP_CREDENTIALS_PATH;
  } else {
    Bun.env.BELLACLAW_MCP_CREDENTIALS_PATH = previousCredentials;
  }
  await rm(directory, { recursive: true, force: true });
});

test("the token command saves through mcp-auth and loses its payload once handled", async () => {
  expect(await send("!mcp-auth token vault secret-token")).toBe(
    "Saved the token for MCP profile vault in this chat.",
  );

  const [command] = await rowsOf(EEventType.McpAuthTokenSaveRequested);
  expect(command?.payload).toBeNull();
  expect((await rowsOf(EEventType.McpAuthCredentialsChanged)).map((row) => row.payload)).toEqual([
    { chatId, profileId: "vault" },
  ]);
  expect(await send("!mcp-auth status vault")).toBe("MCP profile vault is connected.");
});

test("disconnect replies from the outcome and announces the credential change", async () => {
  await send("!mcp-auth token vault secret-token");

  expect(await send("!mcp-auth disconnect vault")).toBe("Disconnected MCP profile vault.");
  expect(await send("!mcp-auth disconnect vault")).toBe("MCP profile vault was not connected.");
  expect((await rowsOf(EEventType.McpAuthDisconnected)).map((row) => row.payload)).toEqual([
    { chatId, profileId: "vault", disconnected: true },
    { chatId, profileId: "vault", disconnected: false },
  ]);
});

test("a rejected command replies with its reason", async () => {
  expect(await send("!mcp-auth connect vault")).toBe(
    "MCP authentication failed: Error: MCP profile vault does not use OAuth",
  );
  expect(await rowsOf(EEventType.EventDeadLettered)).toEqual([]);
});
