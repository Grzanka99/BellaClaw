import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectorsTable,
  EConnectorKind,
  EConnectorStatus,
  EEventType,
  eventDeliveriesTable,
  eventsTable,
} from "@bellaclaw/database";
import {
  CONNECTOR_EXISTS,
  CONNECTOR_NOT_FOUND,
  CONNECTOR_NOT_PENDING,
  type TOption,
} from "@bellaclaw/shared";
import { eq } from "drizzle-orm";
import { DatabaseConnector } from "../database";
import { resetEventTables } from "../database/test-utils";
import { EventBus } from "../events";
import { ERejectionCode } from "../events/catalog";
import { testEventRequester } from "../events/test-utils";
import { EIdentityLinkOwner } from "../identity/schema";
import { EMessagePlatform } from "../messaging/types";
import { ConnectorService } from ".";
import { loadConnectors } from "./config";

const OWNER = "account:owner";
const OTHER = "account:other";

let directory: string;
let previousConfig: TOption<string>;

function reset() {
  Object.assign(EventBus, { _instance: undefined });
  Object.assign(ConnectorService, { _instance: undefined });
}

// the tools' path: a command on the owner's lane, answered by connectors.changed
async function send<T extends EEventType>(
  type: T,
  payload: Parameters<typeof testEventRequester.request<T, EEventType.ConnectorsChanged>>[1],
  ownerKey: string,
) {
  const changed = await testEventRequester.request(type, payload, {
    outcome: EEventType.ConnectorsChanged,
    step: undefined,
    key: ownerKey,
    timeoutMs: undefined,
  });
  await EventBus.instance.idle();
  return changed.payload;
}

function add(id: string, ownerKey = OWNER, url = "https://example.com/mcp") {
  return send(
    EEventType.ConnectorAddRequested,
    {
      ownerKey,
      id,
      kind: EConnectorKind.Mcp,
      url,
      description: "Example tools",
      plainChats: false,
    },
    ownerKey,
  );
}

function resolve(id: string, decision: "approve" | "reject", ownerKey = OWNER) {
  return send(EEventType.ConnectorResolveRequested, { ownerKey, id, decision }, ownerKey);
}

function remove(id: string, ownerKey = OWNER) {
  return send(EEventType.ConnectorRemoveRequested, { ownerKey, id }, ownerKey);
}

async function ids(ownerKey = OWNER) {
  return (await loadConnectors(ownerKey)).map((connector) => connector.id);
}

beforeEach(async () => {
  reset();
  directory = await mkdtemp(join(tmpdir(), "bellaclaw-stored-connectors-"));
  previousConfig = Bun.env.BELLACLAW_CONNECTORS_CONFIG;
  Bun.env.BELLACLAW_CONNECTORS_CONFIG = join(directory, "connectors.json");
  await Bun.write(
    join(directory, "connectors.json"),
    JSON.stringify({
      connectors: [
        {
          id: "files",
          description: "File tools",
          instructions: "Use the file tools",
          transport: { type: "stdio", command: "unused" },
        },
      ],
    }),
  );
  await resetEventTables();
  await DatabaseConnector.instance.database.delete(connectorsTable);
  ConnectorService.instance.setup();
  await EventBus.instance.start();
});

afterEach(async () => {
  await EventBus.instance.idle();
  await EventBus.instance.stop();
  await DatabaseConnector.instance.database.delete(connectorsTable);
  if (previousConfig === undefined) {
    delete Bun.env.BELLACLAW_CONNECTORS_CONFIG;
  } else {
    Bun.env.BELLACLAW_CONNECTORS_CONFIG = previousConfig;
  }
  await rm(directory, { recursive: true, force: true });
  reset();
});

describe("stored connectors", () => {
  test("adds a pending connector, and the row and the ack commit together", async () => {
    const changed = await add("notes");

    expect(changed).toEqual({
      ownerKey: OWNER,
      connectorId: "notes",
      connector: {
        kind: EConnectorKind.Mcp,
        url: "https://example.com/mcp",
        description: "Example tools",
        plainChats: false,
        status: EConnectorStatus.PendingAdd,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
    });
    const deliveries = await DatabaseConnector.instance.database
      .select({ status: eventDeliveriesTable.status })
      .from(eventDeliveriesTable)
      .innerJoin(eventsTable, eq(eventsTable.seq, eventDeliveriesTable.eventSeq))
      .where(eq(eventsTable.type, EEventType.ConnectorAddRequested));
    expect(deliveries).toEqual([{ status: "done" }]);
  });

  test("rejects an add of an existing, a file connector's, or a malformed id and a non-http URL", async () => {
    await add("notes");

    await expect(add("notes")).rejects.toMatchObject({
      code: ERejectionCode.Invalid,
      errorCode: CONNECTOR_EXISTS,
    });
    await expect(add("files")).rejects.toMatchObject({
      code: ERejectionCode.Invalid,
      errorCode: CONNECTOR_EXISTS,
    });
    await expect(add("Bad_Id")).rejects.toMatchObject({
      code: ERejectionCode.Invalid,
      errorCode: undefined,
    });
    await expect(add("ftp", OWNER, "ftp://example.com/mcp")).rejects.toMatchObject({
      code: ERejectionCode.Invalid,
      errorCode: undefined,
    });
  });

  test("updates the description and plainChats only", async () => {
    await add("notes");

    const changed = await send(
      EEventType.ConnectorUpdateRequested,
      { ownerKey: OWNER, id: "notes", plainChats: true },
      OWNER,
    );

    expect(changed.connector).toMatchObject({
      description: "Example tools",
      plainChats: true,
      url: "https://example.com/mcp",
    });
    await expect(
      send(
        EEventType.ConnectorUpdateRequested,
        { ownerKey: OWNER, id: "files", description: "Mine" },
        OWNER,
      ),
    ).rejects.toMatchObject({ errorCode: CONNECTOR_NOT_FOUND });
  });

  test("approving an add makes it usable; rejecting one deletes it", async () => {
    await add("notes");
    await add("drafts");
    expect(await ids()).toEqual(["files"]);

    const approved = await resolve("notes", "approve");
    expect(approved.connector?.status).toBe(EConnectorStatus.Active);
    const rejected = await resolve("drafts", "reject");
    expect(rejected.connector).toBeNull();

    expect(await ids()).toEqual(["files", "notes"]);
    await expect(resolve("notes", "approve")).rejects.toMatchObject({
      errorCode: CONNECTOR_NOT_PENDING,
    });
    await expect(resolve("drafts", "approve")).rejects.toMatchObject({
      errorCode: CONNECTOR_NOT_FOUND,
    });
  });

  test("removing a pending add deletes it; an active one waits for approval and stays usable", async () => {
    await add("drafts");
    expect((await remove("drafts")).connector).toBeNull();

    await add("notes");
    await resolve("notes", "approve");
    expect((await remove("notes")).connector?.status).toBe(EConnectorStatus.PendingRemoval);
    expect((await remove("notes")).connector?.status).toBe(EConnectorStatus.PendingRemoval);
    expect(await ids()).toEqual(["files", "notes"]);

    expect((await resolve("notes", "reject")).connector?.status).toBe(EConnectorStatus.Active);
    await remove("notes");
    expect((await resolve("notes", "approve")).connector).toBeNull();
    expect(await ids()).toEqual(["files"]);
    await expect(remove("files")).rejects.toMatchObject({ errorCode: CONNECTOR_NOT_FOUND });
  });

  test("one owner cannot see or change another owner's connector", async () => {
    await add("notes", OTHER);
    await resolve("notes", "approve", OTHER);

    expect(await ids(OWNER)).toEqual(["files"]);
    await expect(remove("notes")).rejects.toMatchObject({ errorCode: CONNECTOR_NOT_FOUND });
    await expect(resolve("notes", "reject")).rejects.toMatchObject({
      errorCode: CONNECTOR_NOT_FOUND,
    });
    expect(await ids(OTHER)).toEqual(["files", "notes"]);
  });

  test("loads a stored connector as plain HTTP, and the file wins an id clash", async () => {
    await add("notes");
    await resolve("notes", "approve");
    const now = new Date();
    await DatabaseConnector.instance.database.insert(connectorsTable).values({
      ownerKey: OWNER,
      id: "files",
      kind: EConnectorKind.Mcp,
      url: "https://shadow.example.com/mcp",
      description: "Shadow",
      plainChats: true,
      status: EConnectorStatus.Active,
      createdAt: now,
      updatedAt: now,
    });

    const connectors = await loadConnectors(OWNER);

    expect(connectors.map((connector) => [connector.id, connector.description])).toEqual([
      ["files", "File tools"],
      ["notes", "Example tools"],
    ]);
    expect(connectors[1]).toMatchObject({
      transport: { type: "http", url: "https://example.com/mcp" },
      plainChats: false,
    });
  });

  test("on a link, moves the address's connectors to the account, and the account keeps its row on an id clash", async () => {
    const chatKey = "signal:+100";
    await add("notes", chatKey, "https://address.example.com/mcp");
    await add("calendar", chatKey);
    await resolve("calendar", "approve", chatKey);
    await add("notes");
    const keys = {
      accountId: "owner",
      channel: EMessagePlatform.Signal,
      address: "+100",
      chatKey,
      conversationKey: "bella:owner",
      ownerKey: OWNER,
    };

    await EventBus.instance.publish({
      type: EEventType.IdentityLinkQuiet,
      source: "test",
      key: chatKey,
      trace: { turnId: "test:link", chatId: chatKey, platform: undefined },
      payload: keys,
      causationId: undefined,
      dedupeKey: undefined,
    });
    await EventBus.instance.idle();

    const rows = await DatabaseConnector.instance.database
      .select({
        ownerKey: connectorsTable.ownerKey,
        id: connectorsTable.id,
        url: connectorsTable.url,
        status: connectorsTable.status,
      })
      .from(connectorsTable)
      .orderBy(connectorsTable.id);
    expect(rows).toEqual([
      {
        ownerKey: OWNER,
        id: "calendar",
        url: "https://example.com/mcp",
        status: EConnectorStatus.Active,
      },
      {
        ownerKey: OWNER,
        id: "notes",
        url: "https://example.com/mcp",
        status: EConnectorStatus.PendingAdd,
      },
    ]);
    const moved = await DatabaseConnector.instance.database
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.type, EEventType.IdentityLinkMoved));
    expect(moved.map((event) => event.payload)).toEqual([
      { ...keys, owner: EIdentityLinkOwner.Connectors },
    ]);
  });
});
