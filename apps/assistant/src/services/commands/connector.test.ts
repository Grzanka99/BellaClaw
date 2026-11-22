import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectorsTable,
  EConnectorKind,
  EConnectorStatus,
  EEventType,
  eventsTable,
} from "@bellaclaw/database";
import type { TOption } from "@bellaclaw/shared";
import { asc, eq } from "drizzle-orm";
import { ConnectorService } from "../connectors";
import { loadConnectors } from "../connectors/config";
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

// sends a message through the commands consumer and returns its reply
async function send(content: string) {
  await bus.publish({
    type: EEventType.MessageAuthorized,
    source: "test",
    key: chatId,
    trace: { turnId: "test:connector", chatId, platform: EMessagePlatform.Signal },
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
  const replies = await DatabaseConnector.instance.database
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.type, EEventType.ReplyReady))
    .orderBy(asc(eventsTable.seq));
  return (replies.at(-1)?.payload as { text: string }).text;
}

async function store(id: string, status: EConnectorStatus, createdAt: number) {
  await DatabaseConnector.instance.database.insert(connectorsTable).values({
    ownerKey: chatId,
    id,
    kind: EConnectorKind.Mcp,
    url: `https://${id}.example.com/mcp`,
    description: `The ${id} tools`,
    plainChats: false,
    status,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  });
}

async function usableIds() {
  return (await loadConnectors(chatId)).map((connector) => connector.id);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "bellaclaw-connector-command-"));
  previousConfig = Bun.env.BELLACLAW_CONNECTORS_CONFIG;
  Bun.env.BELLACLAW_CONNECTORS_CONFIG = join(directory, "connectors.json");
  await resetEventTables();
  await DatabaseConnector.instance.database.delete(connectorsTable);
  Object.assign(EventBus, { _instance: undefined });
  Object.assign(Commands, { _instance: undefined });
  Object.assign(ConnectorService, { _instance: undefined });
  bus = EventBus.instance;
  Commands.instance.setup();
  ConnectorService.instance.setup();
  await bus.start();
  await store("notes", EConnectorStatus.PendingAdd, 1_000);
  await store("calendar", EConnectorStatus.PendingRemoval, 2_000);
});

afterEach(async () => {
  await bus.idle();
  await bus.stop();
  await DatabaseConnector.instance.database.delete(connectorsTable);
  if (previousConfig === undefined) {
    delete Bun.env.BELLACLAW_CONNECTORS_CONFIG;
  } else {
    Bun.env.BELLACLAW_CONNECTORS_CONFIG = previousConfig;
  }
  await rm(directory, { recursive: true, force: true });
});

test("list shows the stored connectors in plain words", async () => {
  expect(await send("!connector list")).toBe(
    [
      "- notes (waiting for approval to add): https://notes.example.com/mcp — The notes tools",
      "- calendar (waiting for approval to remove): https://calendar.example.com/mcp — The calendar tools",
    ].join("\n"),
  );
});

test("approve makes a pending add active and removes a pending removal", async () => {
  expect(await send("!connector approve notes")).toBe(
    "Connector notes is active: https://notes.example.com/mcp",
  );
  expect(await send("!connector approve calendar")).toBe("Connector calendar is removed.");
  expect(await usableIds()).toEqual(["notes"]);
  expect(await send("!connector approve notes")).toBe(
    "Connector notes has nothing waiting for approval.",
  );
});

test("reject drops a pending add and keeps a connector waiting for removal", async () => {
  expect(await send("!connector reject notes")).toBe(
    "The request to add connector notes was dropped.",
  );
  expect(await send("!connector reject calendar")).toBe("Connector calendar stays.");
  expect(await send("!connector list")).toBe(
    "- calendar (active): https://calendar.example.com/mcp — The calendar tools",
  );
  expect(await send("!connector reject notes")).toBe("You have no connector notes.");
});

test("anything else answers with the usage line", async () => {
  expect(await send("!connector approve")).toBe(
    "Usage: !connector list | !connector approve|reject CONNECTOR",
  );
});
