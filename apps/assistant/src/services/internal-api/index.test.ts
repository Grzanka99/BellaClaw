import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EEventType, eventsTable, identityLinksTable } from "@bellaclaw/database";
import { ADDRESS_LINKED_ELSEWHERE } from "@bellaclaw/shared";
import { eq } from "drizzle-orm";
import { LlmClient } from "../ai/llm";
import { EAiProvider } from "../ai/types";
import { AuthorizationService } from "../authorization";
import { DatabaseConnector } from "../database";
import { linkTestAddress } from "../database/test-utils";
import { ESubscriptionMode, EventBus } from "../events";
import { IdentityService } from "../identity";
import { EIdentityLinkState } from "../identity/schema";
import { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { DefaultConfigRecord, EConfigKey } from "../settings/schema";
import { handleInternalApiRequest, setupInternalApi } from ".";
import { internalRequest, resetServices, TEST_SECRET } from "./test-utils";

// a provider whose model list needs no network
const SETTINGS = { ...DefaultConfigRecord, [EConfigKey.AiProvider]: EAiProvider.Ollama };

resetServices([EventBus, IdentityService, SettingsService]);

function link(address: string, accountId: string, state: EIdentityLinkState, linkedAt: number) {
  return linkTestAddress(address, accountId, EMessagePlatform.Signal, state, linkedAt);
}

async function start() {
  setupInternalApi();
  await IdentityService.instance.setup();
  await EventBus.instance.start();
}

afterEach(() => {
  mock.restore();
});

describe("internal API", () => {
  test("a link request answers once the cutover started, without waiting for the link", async () => {
    await start();

    const response = await internalRequest(
      "POST",
      "/internal/links",
      JSON.stringify({
        accountId: "acct-1",
        chatKey: "signal:+100",
      }),
    );

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
    const read = await internalRequest("GET", "/internal/links/signal%3A%2B100");
    expect(await read.json()).toEqual({ link: { accountId: "acct-1", state: "migrating" } });
  });

  test("a link to an address of another account is rejected with its stable code", async () => {
    await link("+100", "acct-owner", EIdentityLinkState.Active, 1_000);
    await start();

    const response = await internalRequest(
      "POST",
      "/internal/links",
      JSON.stringify({
        accountId: "acct-other",
        chatKey: "signal:+100",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "The address is linked to another account",
      code: ADDRESS_LINKED_ELSEWHERE,
    });
  });

  test("a link request with a chat key that names no address is invalid", async () => {
    await start();

    const response = await internalRequest(
      "POST",
      "/internal/links",
      JSON.stringify({
        accountId: "acct-1",
        chatKey: "nowhere",
      }),
    );

    expect(response.status).toBe(400);
    expect(await DatabaseConnector.instance.database.select().from(identityLinksTable)).toEqual([]);
  });

  test("the link of a chat key is none, or its account and state", async () => {
    await link("+100", "acct-1", EIdentityLinkState.Active, 1_000);
    await start();

    expect(await (await internalRequest("GET", "/internal/links/signal%3A%2B100")).json()).toEqual({
      link: { accountId: "acct-1", state: "active" },
    });
    expect(await (await internalRequest("GET", "/internal/links/signal%3A%2B999")).json()).toEqual(
      {},
    );
  });

  test("an account answers its keys and its links, oldest first", async () => {
    await link("+200", "acct-1", EIdentityLinkState.Migrating, 2_000);
    await link("+100", "acct-1", EIdentityLinkState.Active, 1_000);
    await link("+300", "acct-2", EIdentityLinkState.Active, 500);
    await start();

    expect(await (await internalRequest("GET", "/internal/accounts/acct-1")).json()).toEqual({
      conversationKey: "bella:acct-1",
      ownerKey: "account:acct-1",
      links: [
        { chatKey: "signal:+100", state: "active", linkedAt: 1_000 },
        { chatKey: "signal:+200", state: "migrating", linkedAt: 2_000 },
      ],
    });
  });

  test("an account with no link answers its keys and no links", async () => {
    await link("+100", "acct-1", EIdentityLinkState.Active, 1_000);
    await start();

    const response = await internalRequest("GET", "/internal/accounts/acct-2");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      conversationKey: "bella:acct-2",
      ownerKey: "account:acct-2",
      links: [],
    });
  });

  test("an activation code check answers valid, invalid, or unset with no code configured, and publishes nothing", async () => {
    const original = Bun.env.BELLACLAW_ACTIVATION_TOKEN;
    await start();

    try {
      Bun.env.BELLACLAW_ACTIVATION_TOKEN = "open-sesame";
      Object.assign(AuthorizationService, { _instance: undefined });
      const check = async (code: unknown) =>
        (
          await internalRequest("POST", "/internal/activation-code/check", JSON.stringify({ code }))
        ).json();

      expect(await check(" open-sesame ")).toEqual({ result: "valid" });
      expect(await check("open-sesam")).toEqual({ result: "invalid" });
      expect(await check("")).toEqual({ result: "invalid" });
      expect(
        (await internalRequest("POST", "/internal/activation-code/check", JSON.stringify({})))
          .status,
      ).toBe(400);

      Bun.env.BELLACLAW_ACTIVATION_TOKEN = "  ";
      Object.assign(AuthorizationService, { _instance: undefined });
      expect(await check("open-sesame")).toEqual({ result: "unset" });
      expect(await check("")).toEqual({ result: "unset" });

      await EventBus.instance.idle();
      expect(await DatabaseConnector.instance.database.select().from(eventsTable)).toEqual([]);
    } finally {
      Bun.env.BELLACLAW_ACTIVATION_TOKEN = original;
      Object.assign(AuthorizationService, { _instance: undefined });
    }
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

    const read = await internalRequest("GET", "/internal/accounts/acct-1/model");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ provider: EAiProvider.Ollama });

    const changed = await internalRequest(
      "PUT",
      "/internal/accounts/acct-1/model",
      JSON.stringify({
        aiProvider: EAiProvider.Openrouter,
      }),
    );
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

  test("personality settings are read and changed per account, each field alone, with Settings' validation", async () => {
    SettingsService.instance.setup();
    await start();
    const alice = `acct-${crypto.randomUUID()}`;
    const bob = `acct-${crypto.randomUUID()}`;
    const path = (accountId: string) => `/internal/accounts/${accountId}/personality`;
    const read = async (accountId: string) => {
      const response = await internalRequest("GET", path(accountId));
      return [response.status, await response.json()];
    };
    const change = async (accountId: string, body: unknown) => {
      const response = await internalRequest("PUT", path(accountId), JSON.stringify(body));
      return [response.status, await response.json()];
    };
    const defaults = {
      bellaPersona: DefaultConfigRecord[EConfigKey.AiInstructionsPersona],
      plainChatsUseBellaPersona: true,
      plainChatsPersona: "",
    };

    expect(await read(alice)).toEqual([200, defaults]);
    expect(await change(alice, { bellaPersona: "  Be brief.  " })).toEqual([
      200,
      { ...defaults, bellaPersona: "Be brief." },
    ]);
    expect(await change(alice, { plainChatsUseBellaPersona: false })).toEqual([
      200,
      { ...defaults, bellaPersona: "Be brief.", plainChatsUseBellaPersona: false },
    ]);
    const changed = {
      bellaPersona: "Be brief.",
      plainChatsUseBellaPersona: false,
      plainChatsPersona: "Code in Kotlin.",
    };
    expect(await change(alice, { plainChatsPersona: "Code in Kotlin." })).toEqual([200, changed]);
    expect(await read(alice)).toEqual([200, changed]);
    expect(
      (await SettingsService.instance.getAll(`account:${alice}`))[
        EConfigKey.AiPlainChatsUseBellaPersona
      ],
    ).toBe("false");

    // invalid changes answer 400 and change nothing
    for (const body of [
      { bellaPersona: "   " },
      { bellaPersona: "   ", plainChatsPersona: "Other" },
      {},
      { plainChatsUseBellaPersona: "yes" },
      { mood: "dark" },
    ]) {
      const [status] = await change(alice, body);
      expect(status).toBe(400);
    }
    expect(await read(alice)).toEqual([200, changed]);

    // another account's settings are its own
    expect(await read(bob)).toEqual([200, defaults]);
    // an empty chats text with Bella's persona off is the mode with no persona
    expect(await change(alice, { plainChatsPersona: "" })).toEqual([
      200,
      { ...changed, plainChatsPersona: "" },
    ]);
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

    const response = await internalRequest("DELETE", "/internal/accounts/acct-1/messages/7");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deletedMessageIds: [7] });
    expect(deletes).toEqual([{ chatId: "bella:acct-1", key: "bella:acct-1" }]);
  });

  test("a wrong bearer is refused", async () => {
    await start();

    const unauthorized = await handleInternalApiRequest(
      new Request("http://internal/internal/accounts/acct-1", { method: "GET" }),
      TEST_SECRET,
    );
    expect(unauthorized.status).toBe(401);
  });
});
