import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EEventType, eventsTable } from "@bellaclaw/database";
import type { TOption } from "@bellaclaw/shared";
import { asc, eq } from "drizzle-orm";
import { setupMcpAuth } from "../connectors/mcp/auth";
import { DatabaseConnector } from "../database";
import { resetEventTables } from "../database/test-utils";
import { EventBus } from "../events";
import { testMessageOrigin } from "../events/test-utils";
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
    trace: { turnId: "test:connector-auth", chatId, platform: EMessagePlatform.Signal },
    payload: {
      ...testMessageOrigin(chatId, EMessagePlatform.Signal),
      content,
      attachments: [],
      receivedAt: Date.now(),
    },
    causationId: undefined,
    dedupeKey: undefined,
  });
  await bus.idle();
  const replies = await rowsOf(EEventType.ReplyReady);
  return (replies.at(-1)?.payload as { text: string }).text;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "bellaclaw-connector-auth-command-"));
  previousConfig = Bun.env.BELLACLAW_CONNECTORS_CONFIG;
  previousCredentials = Bun.env.BELLACLAW_MCP_CREDENTIALS_PATH;
  Bun.env.BELLACLAW_CONNECTORS_CONFIG = join(directory, "connectors.json");
  Bun.env.BELLACLAW_MCP_CREDENTIALS_PATH = join(directory, "credentials.json");
  await Bun.write(
    join(directory, "connectors.json"),
    JSON.stringify({
      connectors: [
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
    delete Bun.env.BELLACLAW_CONNECTORS_CONFIG;
  } else {
    Bun.env.BELLACLAW_CONNECTORS_CONFIG = previousConfig;
  }
  if (previousCredentials === undefined) {
    delete Bun.env.BELLACLAW_MCP_CREDENTIALS_PATH;
  } else {
    Bun.env.BELLACLAW_MCP_CREDENTIALS_PATH = previousCredentials;
  }
  await rm(directory, { recursive: true, force: true });
});

test("the token command saves through mcp-auth and loses its payload once handled", async () => {
  expect(await send("!connector-auth token vault secret-token")).toBe(
    "Saved the token for connector vault in this chat.",
  );

  const [command] = await rowsOf(EEventType.McpAuthTokenSaveRequested);
  expect(command?.payload).toBeNull();
  expect((await rowsOf(EEventType.McpAuthCredentialsChanged)).map((row) => row.payload)).toEqual([
    { chatId, profileId: "vault" },
  ]);
  expect(await send("!connector-auth status vault")).toBe("Connector vault is connected.");
  // the token command is confidential: the history gets its name and outcome, the token never
  const [saved] = await rowsOf(EEventType.ReplyReady);
  expect(saved?.payload).toMatchObject({
    text: "Saved the token for connector vault in this chat.",
    confidential: true,
    display: {
      text: "connector vault connected",
      request: { text: "!connector-auth" },
      command: { name: "connector-auth", state: "done", outcome: "connector vault connected" },
    },
  });
  expect(JSON.stringify(saved?.payload)).not.toContain("secret-token");
});

test("a malformed command, a token in it or not, carries no token for the history", async () => {
  for (const content of [
    "!connector-auth TOKEN vault secret-1",
    "!connector-auth Token vault secret-2 extra",
    "!connector-auth token vault",
    "!CONNECTOR-AUTH token vault secret-3 extra",
    "!connector-auth connect vault secret-4",
  ]) {
    expect(await send(content)).toBe(
      "Usage: !connector-auth connect|disconnect|status CONNECTOR or !connector-auth token CONNECTOR TOKEN",
    );
  }

  const replies = (await rowsOf(EEventType.ReplyReady)).map((row) => JSON.stringify(row.payload));
  expect(replies).toHaveLength(5);
  for (const reply of replies) {
    expect(reply).toContain('"request":{"text":"!connector-auth"');
    expect(reply).not.toContain("secret-");
  }
  expect(await rowsOf(EEventType.McpAuthTokenSaveRequested)).toEqual([]);
  expect(await rowsOf(EEventType.McpAuthConnectRequested)).toEqual([]);
});

test("disconnect replies from the outcome and announces the credential change", async () => {
  await send("!connector-auth token vault secret-token");

  expect(await send("!connector-auth disconnect vault")).toBe("Disconnected connector vault.");
  expect(await send("!connector-auth disconnect vault")).toBe("Connector vault was not connected.");
  expect((await rowsOf(EEventType.McpAuthDisconnected)).map((row) => row.payload)).toEqual([
    { chatId, profileId: "vault", disconnected: true },
    { chatId, profileId: "vault", disconnected: false },
  ]);
});

test("a rejected command replies with its reason", async () => {
  expect(await send("!connector-auth connect vault")).toBe(
    "Connector authentication failed: Error: Connector vault does not use OAuth",
  );
  expect(await rowsOf(EEventType.EventDeadLettered)).toEqual([]);
});
