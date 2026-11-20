import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EEventType, eventsTable, identityLinksTable } from "@bellaclaw/database";
import { ADDRESS_LINKED_ELSEWHERE } from "@bellaclaw/shared";
import { eq } from "drizzle-orm";
import { LlmClient } from "../ai/llm";
import { EAiProvider } from "../ai/types";
import { DatabaseConnector } from "../database";
import { resetEventTables, resetIdentityLinksTable } from "../database/test-utils";
import { ESubscriptionMode, EventBus } from "../events";
import { IdentityService } from "../identity";
import { EIdentityLinkState } from "../identity/schema";
import { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { DefaultConfigRecord, EConfigKey } from "../settings/schema";
import { handleInternalApiRequest, setupInternalApi } from ".";

const SECRET = "internal-secret";
// a provider whose model list needs no network
const SETTINGS = { ...DefaultConfigRecord, [EConfigKey.AiProvider]: EAiProvider.Ollama };

function reset() {
  Object.assign(EventBus, { _instance: undefined });
  Object.assign(IdentityService, { _instance: undefined });
  Object.assign(SettingsService, { _instance: undefined });
}

function send(method: string, path: string, body?: unknown) {
  return handleInternalApiRequest(
    new Request(`http://internal${path}`, {
      method,
      headers: { Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(body),
    }),
    SECRET,
  );
}

function link(address: string, accountId: string, state: EIdentityLinkState, linkedAt: number) {
  return DatabaseConnector.instance.database.insert(identityLinksTable).values({
    channel: EMessagePlatform.Signal,
    address,
    accountId,
    state,
    linkedAt: new Date(linkedAt),
  });
}

async function start() {
  setupInternalApi();
  await IdentityService.instance.setup();
  await EventBus.instance.start();
}

beforeEach(async () => {
  reset();
  await resetEventTables();
  await resetIdentityLinksTable();
});

afterEach(async () => {
  await EventBus.instance.idle();
  await EventBus.instance.stop();
  await resetIdentityLinksTable();
  reset();
  mock.restore();
});

describe("internal API", () => {
  test("a link request answers once the cutover started, without waiting for the link", async () => {
    await start();

    const response = await send("POST", "/internal/links", {
      accountId: "acct-1",
      chatKey: "signal:+100",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "migrating" });
    expect(
      await DatabaseConnector.instance.database.select().from(identityLinksTable),
    ).toMatchObject([
      { address: "+100", accountId: "acct-1", state: EIdentityLinkState.Migrating },
    ]);
    const started = await DatabaseConnector.instance.database
      .select({ key: eventsTable.key })
      .from(eventsTable)
      .where(eq(eventsTable.type, EEventType.IdentityLinkStarted));
    expect(started).toEqual([{ key: "signal:+100" }]);

    // the read model answers the new link at once
    const read = await send("GET", "/internal/links/signal%3A%2B100");
    expect(await read.json()).toEqual({ link: { accountId: "acct-1", state: "migrating" } });
  });

  test("a link to an address of another account is rejected with its stable code", async () => {
    await link("+100", "acct-owner", EIdentityLinkState.Active, 1_000);
    await start();

    const response = await send("POST", "/internal/links", {
      accountId: "acct-other",
      chatKey: "signal:+100",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "The address is linked to another account",
      code: ADDRESS_LINKED_ELSEWHERE,
    });
  });

  test("a link already migrating is rejected without a code", async () => {
    await link("+100", "acct-1", EIdentityLinkState.Migrating, 1_000);
    await start();

    const response = await send("POST", "/internal/links", {
      accountId: "acct-1",
      chatKey: "signal:+100",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "The address is already being linked" });
  });

  test("a link request with a chat key that names no address is invalid", async () => {
    await start();

    const response = await send("POST", "/internal/links", {
      accountId: "acct-1",
      chatKey: "nowhere",
    });

    expect(response.status).toBe(400);
    expect(await DatabaseConnector.instance.database.select().from(identityLinksTable)).toEqual([]);
  });

  test("the link of a chat key is none, or its account and state", async () => {
    await link("+100", "acct-1", EIdentityLinkState.Active, 1_000);
    await start();

    expect(await (await send("GET", "/internal/links/signal%3A%2B100")).json()).toEqual({
      link: { accountId: "acct-1", state: "active" },
    });
    expect(await (await send("GET", "/internal/links/signal%3A%2B999")).json()).toEqual({});
  });

  test("an account answers its keys and its links, oldest first", async () => {
    await link("+200", "acct-1", EIdentityLinkState.Migrating, 2_000);
    await link("+100", "acct-1", EIdentityLinkState.Active, 1_000);
    await link("+300", "acct-2", EIdentityLinkState.Active, 500);
    await start();

    expect(await (await send("GET", "/internal/accounts/acct-1")).json()).toEqual({
      conversationKey: "bella:acct-1",
      ownerKey: "account:acct-1",
      links: [
        { chatKey: "signal:+100", state: "active", linkedAt: 1_000 },
        { chatKey: "signal:+200", state: "migrating", linkedAt: 2_000 },
      ],
    });
  });

  test("model settings are read and changed under the account's owner key, traced in its Bella conversation", async () => {
    const getAll = mock(async (_ownerKey: string) => SETTINGS);
    Object.assign(SettingsService, { _instance: { getAll } });
    const verify = spyOn(LlmClient.instance, "verifySettings").mockResolvedValue(undefined);
    const updates: { ownerKey: string; key: string }[] = [];
    EventBus.instance.subscribe({
      consumer: "settings",
      type: EEventType.SettingsUpdateRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event, ctx) => {
        updates.push({ ownerKey: event.payload.ownerKey, key: event.key });
        await ctx.complete(async (_tx, emit) => {
          emit(
            EEventType.SettingsChanged,
            { ownerKey: event.payload.ownerKey, record: SETTINGS },
            undefined,
            undefined,
          );
        });
      },
    });
    await start();

    const read = await send("GET", "/internal/accounts/acct-1/model");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ provider: EAiProvider.Ollama });

    const changed = await send("PUT", "/internal/accounts/acct-1/model", {
      aiProvider: EAiProvider.Openrouter,
    });
    expect(changed.status).toBe(200);

    expect(getAll.mock.calls.map(([ownerKey]) => ownerKey)).toEqual([
      "account:acct-1",
      "account:acct-1",
    ]);
    expect(updates).toEqual([{ ownerKey: "account:acct-1", key: "account:acct-1" }]);
    // acct-1 has no link yet
    expect(verify.mock.calls.length).toBeGreaterThan(0);
    expect(verify.mock.calls.every(([, , trace]) => trace.chatId === "bella:acct-1")).toBe(true);
  });

  test("a message is deleted in the account's Bella conversation", async () => {
    const deletes: { chatId: string; key: string }[] = [];
    EventBus.instance.subscribe({
      consumer: "conversation",
      type: EEventType.ConversationMessageDeleteRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event, ctx) => {
        deletes.push({ chatId: event.payload.chatId, key: event.key });
        await ctx.complete(async (_tx, emit) => {
          emit(
            EEventType.ConversationMessageDeleted,
            { chatId: event.payload.chatId, messageIds: [event.payload.messageId] },
            undefined,
            undefined,
          );
        });
      },
    });
    await start();

    const response = await send("DELETE", "/internal/accounts/acct-1/messages/7");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deletedMessageIds: [7] });
    expect(deletes).toEqual([{ chatId: "bella:acct-1", key: "bella:acct-1" }]);
  });

  test("a wrong bearer is refused", async () => {
    await start();

    const unauthorized = await handleInternalApiRequest(
      new Request("http://internal/internal/accounts/acct-1", { method: "GET" }),
      SECRET,
    );
    expect(unauthorized.status).toBe(401);
  });
});
