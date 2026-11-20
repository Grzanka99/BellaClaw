import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appDevicesTable,
  conversationsTable,
  EConversationKind,
  EEventType,
  eventDeliveriesTable,
  eventsTable,
  listHistory,
  memoriesTable,
} from "@bellaclaw/database";
import { APP_PUSH_MAX_BYTES, SAppPush, type TAppPush } from "@bellaclaw/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { AgentHarness } from "../ai/agent-harness";
import { DatabaseConnector } from "../database";
import { linkTestAddress, resetEventTables, resetIdentityLinksTable } from "../database/test-utils";
import { EventBus, type TEventDraft } from "../events";
import { testEventRequester } from "../events/test-utils";
import { IdentityService } from "../identity";
import { MessageHandler } from "../message-handler";
import { scriptedReply } from "../message-handler/test-utils";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform } from "../messaging/types";
import { Notices } from "../notices";
import { SettingsService } from "../settings";
import { DefaultConfigRecord } from "../settings/schema";
import { AppChannel } from ".";
import { appPush } from "./push";
import { encryptWebPush } from "./web-push";

const BELLA = "bella:acct-1";
const PLAIN = "plain:acct-1:push-test";
const OWNER = "account:acct-1";
const PROJECT = "test-project";
const ACCESS_TOKEN = "fake-access-token";

// a test device: its RFC 8291 key pair and auth secret, as the app keeps them
type TDevice = { privateKey: CryptoKey; publicKey: string; authSecret: string };

async function createDevice(): Promise<TDevice> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));

  return {
    privateKey: pair.privateKey,
    publicKey: Buffer.from(raw).toString("base64url"),
    authSecret: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
  };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(ikm), "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(salt), info: new Uint8Array(info) },
      key,
      bytes * 8,
    ),
  );
}

// what the phone does with a push: RFC 8291 decryption of the one aes128gcm record
async function decrypt(device: TDevice, ciphertext: string): Promise<string> {
  const body = Buffer.from(ciphertext, "base64url");
  const salt = body.subarray(0, 16);
  const idLength = body[20] ?? 0;
  const senderPublic = body.subarray(21, 21 + idLength);
  const record = new Uint8Array(body.subarray(21 + idLength));
  const devicePublic = Buffer.from(device.publicKey, "base64url");
  const senderKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(senderPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, device.privateKey, 256),
  );
  const ikm = await hkdf(
    Buffer.from(device.authSecret, "base64url"),
    shared,
    Buffer.concat([Buffer.from("WebPush: info\0"), devicePublic, senderPublic]),
    32,
  );
  const cek = await hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, record),
  );

  expect(plain.at(-1)).toBe(2);
  return Buffer.from(plain.subarray(0, -1)).toString("utf8");
}

describe("Web Push encryption", () => {
  test("the RFC 8291 Appendix A sender key and salt give the published message", async () => {
    const senderPublic = Buffer.from(
      "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
      "base64url",
    );
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
        x: senderPublic.subarray(1, 33).toString("base64url"),
        y: senderPublic.subarray(33).toString("base64url"),
      },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const publicKey = await crypto.subtle.importKey(
      "raw",
      senderPublic,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    );

    const body = await encryptWebPush(
      new TextEncoder().encode("When I grow up, I want to be a watermelon"),
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      "BTBZMqHH6r4Tts7J_aSIgg",
      { privateKey, publicKey },
      Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"),
    );

    expect(Buffer.from(body).toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });
});

describe("appPush", () => {
  test("a text that fits is whole; a long one is cut between characters to fit", () => {
    expect(appPush(BELLA, EConversationKind.Bella, 7, 3, 'Short "reply"\n')).toEqual({
      conversationKey: BELLA,
      kind: "bella",
      messageId: 7,
      revision: 3,
      text: 'Short "reply"\n',
      truncated: false,
    });

    const long = `${"a".repeat(2_650)}${"😀".repeat(100)}`;
    const cut = appPush(BELLA, EConversationKind.Bella, 7, 3, long);
    const size = Buffer.byteLength(JSON.stringify(cut));

    expect(cut.truncated).toBe(true);
    expect(size).toBeLessThanOrEqual(APP_PUSH_MAX_BYTES);
    // one more character would not fit
    expect(size + 4).toBeGreaterThan(APP_PUSH_MAX_BYTES);
    expect(long.startsWith(cut.text)).toBe(true);
    expect(cut.text.endsWith("😀")).toBe(true);
  });
});

describe("AppChannel push", () => {
  let signal: ReturnType<typeof mock>;
  let fcm: ReturnType<typeof Bun.serve>;
  let credentialPath: string;
  let privatePem: string;
  // the messages FCM accepted, with the token each went to
  let pushed: { token: string; message: Record<string, unknown> }[];
  // what FCM answers for a token, by token; anything else is accepted
  let answers: Map<string, () => Response>;
  let tokenExchanges: number;

  function reset() {
    for (const service of [
      EventBus,
      AppChannel,
      IdentityService,
      MessageHandler,
      MessagingAdapter,
      SettingsService,
      Notices,
    ]) {
      Object.assign(service, { _instance: undefined });
    }
  }

  async function startFcm() {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    privatePem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString("base64")}\n-----END PRIVATE KEY-----\n`;

    fcm = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);

        if (url.pathname === "/token") {
          const form = new URLSearchParams(await request.text());
          const [header, claims, signature] = (form.get("assertion") ?? "").split(".");
          const valid = await crypto.subtle.verify(
            "RSASSA-PKCS1-v1_5",
            pair.publicKey,
            Buffer.from(signature ?? "", "base64url"),
            Buffer.from(`${header}.${claims}`),
          );
          const payload = JSON.parse(Buffer.from(claims ?? "", "base64url").toString());

          if (
            !valid ||
            form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" ||
            payload.scope !== "https://www.googleapis.com/auth/firebase.messaging" ||
            payload.iss !== "push@test-project.iam.gserviceaccount.com" ||
            payload.aud !== `http://127.0.0.1:${fcm.port}/token`
          ) {
            return new Response("bad assertion", { status: 400 });
          }

          tokenExchanges += 1;
          return Response.json({ access_token: ACCESS_TOKEN, expires_in: 3600 });
        }

        if (
          url.pathname !== `/v1/projects/${PROJECT}/messages:send` ||
          request.headers.get("Authorization") !== `Bearer ${ACCESS_TOKEN}`
        ) {
          return new Response("unexpected", { status: 403 });
        }

        const { message } = (await request.json()) as {
          message: { token: string } & Record<string, unknown>;
        };
        const answer = answers.get(message.token);

        if (answer !== undefined) {
          return answer();
        }

        pushed.push({ token: message.token, message });
        return Response.json({ name: `projects/${PROJECT}/messages/1` });
      },
    });
    credentialPath = join(tmpdir(), `bellaclaw-test-fcm-${crypto.randomUUID()}.json`);
    await Bun.write(
      credentialPath,
      JSON.stringify({
        type: "service_account",
        project_id: PROJECT,
        client_email: "push@test-project.iam.gserviceaccount.com",
        private_key: privatePem,
        token_uri: `http://127.0.0.1:${fcm.port}/token`,
      }),
    );
    Bun.env.BELLACLAW_FCM_CREDENTIALS_PATH = credentialPath;
    Bun.env.BELLACLAW_FCM_URL = `http://127.0.0.1:${fcm.port}`;
  }

  // the turn engine scripted, outbound with a Signal transport, the App channel and Notices
  async function start(reply: string) {
    Object.assign(SettingsService, { _instance: { getAll: async () => DefaultConfigRecord } });
    const runMain = mock(async (args: Parameters<AgentHarness["runMain"]>[0]) =>
      scriptedReply(args, reply),
    );
    Object.assign(MessageHandler.instance, {
      ai: { runMain, compactConversation: mock(async () => undefined) },
    });
    signal = mock(async (_address: string, _text: string) => undefined);
    const adapter = MessagingAdapter.instance;
    Object.assign(adapter, { outboundBackoffMs: [] });
    adapter.registerTransport({
      platform: EMessagePlatform.Signal,
      sendText: signal,
      fetchAttachment: async () => new Uint8Array(),
      deleteAttachment: async () => undefined,
    });
    Object.assign(AppChannel.instance, { pushBackoffMs: [10, 10] });
    adapter.setup();
    MessageHandler.instance.setup();
    Notices.instance.setup();
    await AppChannel.instance.setup();
    await IdentityService.instance.setup();
    await EventBus.instance.start();
  }

  function register(deviceId: string, fcmToken: string, device: TDevice) {
    return testEventRequester.request(
      EEventType.AppDeviceRegisterRequested,
      {
        deviceId,
        accountId: "acct-1",
        fcmToken,
        publicKey: device.publicKey,
        authSecret: device.authSecret,
      },
      { outcome: EEventType.AppDeviceRegistered, step: undefined, key: "global", timeoutMs: 5_000 },
    );
  }

  function publish<T extends EEventType>(type: T, payload: TEventDraft<T>["payload"], id: string) {
    return EventBus.instance.publish({
      type,
      source: "test",
      key: BELLA,
      trace: { turnId: `test:${id}`, chatId: BELLA, platform: undefined },
      payload,
      causationId: undefined,
      dedupeKey: undefined,
    });
  }

  // a message of the Bella conversation, from the app or from the linked Signal address
  async function ask(channel: EMessagePlatform, content: string) {
    let replyAddress = "acct-1";

    if (channel === EMessagePlatform.Signal) {
      replyAddress = "+100";
    }

    await publish(
      EEventType.TurnRequested,
      {
        conversationKey: BELLA,
        ownerKey: OWNER,
        channel,
        replyAddress,
        kind: EConversationKind.Bella,
        content,
        attachments: [],
        receivedAt: Date.now(),
        clientMessageId: undefined,
      },
      content,
    );
    await EventBus.instance.idle();
  }

  async function reminder(text: string) {
    await publish(
      EEventType.DeliveryReady,
      {
        chatId: BELLA,
        text,
        transcript: { text: `[CRON REMINDER daily]: ${text}`, notice: "A reminder fired." },
      },
      text,
    );
    await EventBus.instance.idle();
  }

  async function pushesOf(device: TDevice): Promise<TAppPush[]> {
    const opened: TAppPush[] = [];

    for (const { message } of pushed) {
      const data = SAppPush.safeParse(
        JSON.parse(
          await decrypt(device, String(Reflect.get(message.data as object, "ciphertext"))),
        ),
      );
      expect(data.success).toBe(true);
      if (data.success) {
        opened.push(data.data);
      }
    }

    return opened;
  }

  function lastAssistantRow() {
    return DatabaseConnector.instance.database
      .select()
      .from(memoriesTable)
      .where(and(eq(memoriesTable.chatId, BELLA), eq(memoriesTable.author, "assistant")))
      .orderBy(memoriesTable.id)
      .all()
      .then((rows) => rows.at(-1));
  }

  async function eventsOf(types: EEventType[]) {
    return DatabaseConnector.instance.database
      .select()
      .from(eventsTable)
      .where(inArray(eventsTable.type, types));
  }

  beforeEach(async () => {
    reset();
    await resetEventTables();
    await resetIdentityLinksTable();
    await DatabaseConnector.instance.database.delete(appDevicesTable);
    await DatabaseConnector.instance.database
      .delete(memoriesTable)
      .where(inArray(memoriesTable.chatId, [BELLA, PLAIN]));
    await DatabaseConnector.instance.database
      .delete(conversationsTable)
      .where(eq(conversationsTable.conversationKey, PLAIN));
    await linkTestAddress("+100", "acct-1");
    pushed = [];
    answers = new Map();
    tokenExchanges = 0;
    await startFcm();
  });

  afterEach(async () => {
    await EventBus.instance.idle();
    await EventBus.instance.stop();
    await resetIdentityLinksTable();
    await DatabaseConnector.instance.database.delete(appDevicesTable);
    fcm.stop(true);
    await rm(credentialPath, { force: true });
    delete Bun.env.BELLACLAW_FCM_CREDENTIALS_PATH;
    delete Bun.env.BELLACLAW_FCM_URL;
    reset();
  });

  test("a reply to an app message with no open stream rings once, as ciphertext the device opens; no event carries the token, the access token or the key", async () => {
    await start("Here is your answer");
    const phone = await createDevice();
    await register("phone-1", "fcm-token-1", phone);

    await ask(EMessagePlatform.App, "What now?");

    const row = await lastAssistantRow();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.token).toBe("fcm-token-1");
    // data-only, high priority, nothing readable
    expect(Object.keys(pushed[0]?.message ?? {}).sort()).toEqual(["android", "data", "token"]);
    expect(pushed[0]?.message.android).toEqual({ priority: "HIGH" });
    expect(JSON.stringify(pushed[0]?.message)).not.toContain("answer");
    const revision = (await eventsOf([EEventType.ConversationChanged])).at(-1)?.payload;
    expect(await pushesOf(phone)).toEqual([
      {
        conversationKey: BELLA,
        kind: "bella",
        messageId: row?.id ?? 0,
        revision: Number(Reflect.get(revision as object, "revision")),
        text: "Here is your answer",
        truncated: false,
      },
    ]);
    expect(tokenExchanges).toBe(1);

    // the access token is cached for the next push
    await reminder("Stretch");
    expect(pushed).toHaveLength(2);
    expect(tokenExchanges).toBe(1);

    const log = JSON.stringify(
      await DatabaseConnector.instance.database.select().from(eventsTable),
    );
    expect(log).not.toContain("fcm-token-1");
    expect(log).not.toContain(ACCESS_TOKEN);
    expect(log).not.toContain(pkcs8Body(privatePem));
    // the reply's text is in its reply.ready only
    const withText = (await DatabaseConnector.instance.database.select().from(eventsTable)).filter(
      (event) => JSON.stringify(event.payload).includes("Here is your answer"),
    );
    expect(withText.map((event) => event.type)).toEqual([EEventType.ReplyReady]);
  });

  test("a long reply arrives cut, with the row id to fetch the rest by", async () => {
    const long = `${"Long reply. ".repeat(400)}The end.`;
    await start(long);
    const phone = await createDevice();
    await register("phone-1", "fcm-token-1", phone);

    await ask(EMessagePlatform.App, "Tell me everything");

    const row = await lastAssistantRow();
    const [push] = await pushesOf(phone);
    expect(push?.truncated).toBe(true);
    expect(push?.messageId).toBe(row?.id ?? 0);
    expect(long.startsWith(push?.text ?? "x")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(push))).toBeLessThanOrEqual(APP_PUSH_MAX_BYTES);
    expect(row?.message).toBe(long);
  });

  test("a row of a plain chat rings with the plain kind", async () => {
    await start("Unused");
    const phone = await createDevice();
    await register("phone-1", "fcm-token-1", phone);
    await DatabaseConnector.instance.database.insert(conversationsTable).values({
      conversationKey: PLAIN,
      ownerKey: OWNER,
      kind: EConversationKind.Plain,
      createdAt: new Date(1_000),
    });
    const row = await DatabaseConnector.instance.database
      .insert(memoriesTable)
      .values({
        chatId: PLAIN,
        channel: EMessagePlatform.App,
        author: "assistant",
        message: "Plain reply",
        createdAt: new Date(2_000),
      })
      .returning()
      .get();

    await publish(
      EEventType.ConversationChanged,
      {
        conversationKey: PLAIN,
        ownerKey: OWNER,
        revision: 1,
        rewriteRevision: 0,
        messageId: row.id,
      },
      "plain-reply",
    );
    await EventBus.instance.idle();

    expect((await pushesOf(phone)).map((push) => [push.conversationKey, push.kind])).toEqual([
      [PLAIN, "plain"],
    ]);
  });

  test("nothing rings while the stream is open, for a reply to a Signal message, or for a confidential reply", async () => {
    await start("Reply");
    const phone = await createDevice();
    await register("phone-1", "fcm-token-1", phone);

    const close = AppChannel.instance.openEdgeConnection();
    AppChannel.instance.reportPresence(["acct-1"]);
    await ask(EMessagePlatform.App, "While open");
    close();

    await ask(EMessagePlatform.Signal, "From Signal");
    expect(signal.mock.calls).toEqual([["+100", "Reply"]]);

    // a login link: a confidential reply, with neither transcript nor display
    await publish(
      EEventType.ReplyReady,
      {
        conversationKey: BELLA,
        ownerKey: OWNER,
        channel: EMessagePlatform.App,
        replyAddress: "acct-1",
        kind: EConversationKind.Bella,
        text: "https://dashboard.test/app?token=secret",
        confidential: true,
      },
      "confidential",
    );
    await EventBus.instance.idle();

    expect(pushed).toEqual([]);
  });

  test("with a device, a reminder is stored in the Bella conversation and pushed, not sent on Signal; after the unregister it goes to Signal unpushed and is still in history", async () => {
    await start("Reply");
    const phone = await createDevice();
    await register("phone-1", "fcm-token-1", phone);

    await reminder("Stretch");

    expect(signal).not.toHaveBeenCalled();
    expect((await pushesOf(phone)).map((push) => push.text)).toEqual(["Stretch"]);

    await testEventRequester.request(
      EEventType.AppDeviceUnregisterRequested,
      { deviceId: "phone-1", accountId: "acct-1" },
      {
        outcome: EEventType.AppDeviceUnregistered,
        step: undefined,
        key: "global",
        timeoutMs: 5_000,
      },
    );
    await reminder("Drink water");

    expect(signal.mock.calls).toEqual([["+100", "Drink water"]]);
    expect(pushed).toHaveLength(1);
    const history = await listHistory(DatabaseConnector.instance.database, BELLA, undefined, 50);
    expect(
      history.filter((message) => message.author === "assistant").map((message) => message.text),
    ).toEqual(["Stretch", "Drink water"]);
  });

  test("a reminder comes back from history without its scheduler label; a user message that starts with the label keeps it", async () => {
    await start("Reply");

    await reminder("Stretch");
    await ask(EMessagePlatform.App, "[CRON REMINDER daily]: Stretch");

    const history = await listHistory(DatabaseConnector.instance.database, BELLA, undefined, 50);
    expect(history.map((message) => [message.author, message.text])).toEqual([
      ["assistant", "Stretch"],
      ["user", "[CRON REMINDER daily]: Stretch"],
      ["assistant", "Reply"],
    ]);
  });

  test("with FCM unreachable the reminder is still stored and readable, and the push gives up with no dead letter and no notice", async () => {
    // nothing listens on the send URL's port any more
    const closed = Bun.serve({ port: 0, fetch: () => new Response() });
    Bun.env.BELLACLAW_FCM_URL = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    await start("Reply");
    const phone = await createDevice();
    await register("phone-1", "fcm-token-1", phone);

    await reminder("Stretch");

    const history = await listHistory(DatabaseConnector.instance.database, BELLA, undefined, 50);
    expect(history.map((message) => message.text)).toEqual(["Stretch"]);
    expect(pushed).toEqual([]);
    expect(await eventsOf([EEventType.EventDeadLettered, EEventType.NoticeReady])).toEqual([]);
    // the push's delivery ended acked on its third attempt
    const deliveries = await DatabaseConnector.instance.database
      .select()
      .from(eventDeliveriesTable)
      .where(eq(eventDeliveriesTable.consumer, "app"));
    expect(deliveries.filter((delivery) => delivery.status !== "done")).toEqual([]);
    expect(Math.max(...deliveries.map((delivery) => delivery.attempts))).toBe(2);
  });

  test("a failed push is retried and rings on the next attempt", async () => {
    await start("Reply");
    const phone = await createDevice();
    await register("phone-1", "fcm-token-1", phone);
    let calls = 0;
    answers.set("fcm-token-1", () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({ error: { code: 503, status: "UNAVAILABLE" } }, { status: 503 });
      }
      pushed.push({ token: "fcm-token-1", message: {} });
      return Response.json({});
    });

    await reminder("Stretch");

    expect(pushed).toHaveLength(1);
    expect(await eventsOf([EEventType.EventDeadLettered])).toEqual([]);
  });

  test("a token FCM no longer knows unregisters its device without a retry; the account's other device still rings", async () => {
    await start("Reply");
    const phone = await createDevice();
    const gone = await createDevice();
    await register("phone-1", "fcm-token-1", phone);
    await register("phone-2", "gone-token", gone);
    let refused = 0;
    answers.set("gone-token", () => {
      refused += 1;
      return Response.json(
        {
          error: {
            code: 404,
            status: "NOT_FOUND",
            details: [
              {
                "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                errorCode: "UNREGISTERED",
              },
            ],
          },
        },
        { status: 404 },
      );
    });

    await reminder("Stretch");

    expect(refused).toBe(1);
    expect((await pushesOf(phone)).map((push) => push.text)).toEqual(["Stretch"]);
    expect(
      (await DatabaseConnector.instance.database.select().from(appDevicesTable)).map(
        (device) => device.id,
      ),
    ).toEqual(["phone-1"]);
    expect(await AppChannel.instance.listDeviceIds("acct-1")).toEqual(["phone-1"]);
  });

  test("without a credential nothing is sent and the change is acked", async () => {
    delete Bun.env.BELLACLAW_FCM_CREDENTIALS_PATH;
    await start("Reply");
    const phone = await createDevice();
    await register("phone-1", "fcm-token-1", phone);

    await reminder("Stretch");

    expect(pushed).toEqual([]);
    expect(tokenExchanges).toBe(0);
    expect(
      (await DatabaseConnector.instance.database.select().from(eventDeliveriesTable)).filter(
        (delivery) => delivery.status !== "done",
      ),
    ).toEqual([]);
  });
});

// the key's base64 body, without its PEM lines
function pkcs8Body(pem: string): string {
  return pem.split("\n")[1] ?? pem;
}
