import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  appDevicesTable,
  EConversationKind,
  EEventType,
  eventDeliveriesTable,
  eventsTable,
  memoriesTable,
} from "@bellaclaw/database";
import { asc, eq, inArray } from "drizzle-orm";
import { AppChannel } from "../app";
import { DatabaseConnector } from "../database";
import { linkTestAddress, resetEventTables, resetIdentityLinksTable } from "../database/test-utils";
import { EventBus, type TEventDraft } from "../events";
import { testEventRequester, testMessageOrigin } from "../events/test-utils";
import { IdentityService } from "../identity";
import { MessageHandler } from "../message-handler";
import { SettingsService } from "../settings";
import { DefaultConfigRecord } from "../settings/schema";
import { MessagingAdapter } from ".";
import { EMessagePlatform, readAttachment } from "./types";

beforeEach(async () => {
  Object.assign(MessagingAdapter, { _instance: undefined });
  await resetEventTables();
  Object.assign(EventBus, { _instance: undefined });
});

afterEach(() => {
  Object.assign(MessagingAdapter, { _instance: undefined });
});

describe("MessagingAdapter outbound", () => {
  let bus: EventBus;

  function notice(): TEventDraft<EEventType.NoticeReady> {
    return {
      type: EEventType.NoticeReady,
      source: "test",
      key: "signal:+100",
      trace: { turnId: "test:outbound", chatId: "signal:+100", platform: undefined },
      payload: { chatId: "signal:+100", text: "Notice" },
      causationId: undefined,
      dedupeKey: undefined,
    };
  }

  async function deliveries() {
    return DatabaseConnector.instance.database.select().from(eventDeliveriesTable);
  }

  async function sentEvents() {
    return DatabaseConnector.instance.database
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.type, EEventType.MessageSent));
  }

  beforeEach(() => {
    bus = EventBus.instance;
  });

  afterEach(async () => {
    await bus.idle();
    await bus.stop();
  });

  test("retries a missing transport and delivers once it registers", async () => {
    const sendText = mock(async () => undefined);
    const adapter = MessagingAdapter.instance;
    Object.assign(adapter, { outboundBackoffMs: [20, 20, 20, 20, 20] });
    adapter.setup();
    await bus.start();

    await bus.publish(notice());
    while (((await deliveries())[0]?.attempts ?? 0) < 1) {
      await Bun.sleep(1);
    }
    adapter.registerTransport({
      platform: EMessagePlatform.Signal,
      sendText,
      fetchAttachment: async () => new Uint8Array(),
      deleteAttachment: async () => undefined,
    });
    await bus.idle();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("+100", "Notice");
    expect((await deliveries()).map((row) => [row.consumer, row.status])).toEqual([
      ["outbound", "done"],
    ]);
    expect((await sentEvents()).map((row) => row.payload)).toEqual([
      {
        chatId: "signal:+100",
        channel: EMessagePlatform.Signal,
        sourceType: EEventType.NoticeReady,
        chars: 6,
        sentAt: expect.any(Number),
        display: { text: "Notice" },
      },
    ]);
  });

  test("delivers reply.ready to its transport and absorbs a transport failure", async () => {
    const sendText = mock(async () => undefined);
    const adapter = MessagingAdapter.instance;
    Object.assign(adapter, { outboundBackoffMs: [] });
    adapter.registerTransport({
      platform: EMessagePlatform.Signal,
      sendText,
      fetchAttachment: async () => new Uint8Array(),
      deleteAttachment: async () => undefined,
    });
    adapter.setup();
    await bus.start();
    const reply = { ...notice(), type: EEventType.ReplyReady };

    await bus.publish({
      ...reply,
      payload: { ...testMessageOrigin("signal:+100", EMessagePlatform.Signal), text: "Root reply" },
    });
    await bus.idle();
    expect(sendText).toHaveBeenCalledWith("+100", "Root reply");

    sendText.mockImplementation(async () => {
      throw new Error("offline");
    });
    await expect(
      bus.publish({
        ...reply,
        payload: { ...testMessageOrigin("signal:+100", EMessagePlatform.Signal), text: "again" },
      }),
    ).resolves.toBeUndefined();
    await bus.idle();
    expect((await deliveries()).map((row) => row.status)).toEqual(["done", "dead"]);
  });
});

// NOTE: the account acct-1 has the Signal address +100 linked; a delivery or notice names its Bella
// conversation, as Scheduling and Notices write them
describe("MessagingAdapter main channel", () => {
  let signal: ReturnType<typeof mock>;

  function reset() {
    for (const service of [AppChannel, IdentityService, MessageHandler, SettingsService]) {
      Object.assign(service, { _instance: undefined });
    }
  }

  function publish<T extends EEventType>(type: T, payload: TEventDraft<T>["payload"], id: string) {
    return EventBus.instance.publish({
      type,
      source: "test",
      key: "bella:acct-1",
      trace: { turnId: `test:${id}`, chatId: "bella:acct-1", platform: undefined },
      payload,
      causationId: undefined,
      dedupeKey: undefined,
    });
  }

  function reminder(text: string) {
    return publish(
      EEventType.DeliveryReady,
      {
        chatId: "bella:acct-1",
        text,
        transcript: { text, modelText: `[CRON REMINDER daily]: ${text}`, notice: "notice" },
      },
      text,
    );
  }

  function registerDevice() {
    return testEventRequester.request(
      EEventType.AppDeviceRegisterRequested,
      {
        deviceId: "phone-1",
        accountId: "acct-1",
        fcmToken: "token",
        publicKey: "key",
        authSecret: "secret",
      },
      { outcome: EEventType.AppDeviceRegistered, step: undefined, key: "global", timeoutMs: 5_000 },
    );
  }

  // the Bella conversation's rows: who wrote them, where they went and what they say
  function bellaRows() {
    return DatabaseConnector.instance.database
      .select({
        author: memoriesTable.author,
        channel: memoriesTable.channel,
        message: memoriesTable.message,
      })
      .from(memoriesTable)
      .where(eq(memoriesTable.chatId, "bella:acct-1"))
      .orderBy(asc(memoriesTable.id));
  }

  beforeEach(async () => {
    reset();
    await resetIdentityLinksTable();
    await DatabaseConnector.instance.database.delete(appDevicesTable);
    await DatabaseConnector.instance.database
      .delete(memoriesTable)
      .where(inArray(memoriesTable.chatId, ["bella:acct-1", "bella:acct-unlinked"]));
    await linkTestAddress("+100", "acct-1");
    Object.assign(SettingsService, { _instance: { getAll: async () => DefaultConfigRecord } });
    signal = mock(async (_address: string, _text: string) => undefined);
    const adapter = MessagingAdapter.instance;
    Object.assign(adapter, { outboundBackoffMs: [] });
    adapter.registerTransport({
      platform: EMessagePlatform.Signal,
      sendText: signal,
      fetchAttachment: async () => new Uint8Array(),
      deleteAttachment: async () => undefined,
    });
    adapter.setup();
    MessageHandler.instance.setup();
    await AppChannel.instance.setup();
    await IdentityService.instance.setup();
    await EventBus.instance.start();
  });

  afterEach(async () => {
    await EventBus.instance.idle();
    await EventBus.instance.stop();
    await resetIdentityLinksTable();
    await DatabaseConnector.instance.database.delete(appDevicesTable);
    reset();
  });

  test("with a device registered, a reminder and a notice are stored in the Bella conversation and nothing is sent on Signal", async () => {
    await registerDevice();

    await reminder("Stretch");
    await publish(EEventType.NoticeReady, { chatId: "bella:acct-1", text: "A notice" }, "notice");
    await EventBus.instance.idle();

    expect(signal).not.toHaveBeenCalled();
    expect(await bellaRows()).toEqual([
      { author: "user", channel: EMessagePlatform.App, message: "notice" },
      {
        author: "assistant",
        channel: EMessagePlatform.App,
        message: "Stretch",
      },
      { author: "assistant", channel: EMessagePlatform.App, message: "A notice" },
    ]);
  });

  test("once the device is unregistered, as at logout, the next reminder goes to Signal and still appears in the Bella history", async () => {
    await registerDevice();
    await reminder("Before");
    await EventBus.instance.idle();

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
    await reminder("After");
    await EventBus.instance.idle();

    expect(signal.mock.calls).toEqual([["+100", "After"]]);
    expect((await bellaRows()).filter((row) => row.author === "assistant")).toEqual([
      {
        author: "assistant",
        channel: EMessagePlatform.App,
        message: "Before",
      },
      {
        author: "assistant",
        channel: EMessagePlatform.Signal,
        message: "After",
      },
    ]);
  });

  test("with a device registered, a reply goes back where it was asked: a Signal message to Signal, an app message to no transport", async () => {
    await registerDevice();

    await publish(
      EEventType.ReplyReady,
      {
        ...testMessageOrigin("signal:+100", EMessagePlatform.Signal),
        conversationKey: "bella:acct-1",
        ownerKey: "account:acct-1",
        text: "To Signal",
      },
      "signal-reply",
    );
    await publish(
      EEventType.ReplyReady,
      {
        conversationKey: "bella:acct-1",
        ownerKey: "account:acct-1",
        channel: EMessagePlatform.App,
        replyAddress: "acct-1",
        kind: EConversationKind.Bella,
        text: "To the app",
      },
      "app-reply",
    );
    await EventBus.instance.idle();

    expect(signal.mock.calls).toEqual([["+100", "To Signal"]]);
    const sent = await DatabaseConnector.instance.database
      .select({ payload: eventsTable.payload })
      .from(eventsTable)
      .where(eq(eventsTable.type, EEventType.MessageSent))
      .orderBy(asc(eventsTable.seq));
    expect(sent.map((row) => row.payload)).toEqual([
      expect.objectContaining({ chatId: "bella:acct-1", channel: EMessagePlatform.Signal }),
      expect.objectContaining({ chatId: "bella:acct-1", channel: EMessagePlatform.App }),
    ]);
  });

  test("an account with no device and no link keeps the app as its destination", async () => {
    await publish(
      EEventType.NoticeReady,
      { chatId: "bella:acct-unlinked", text: "Hello" },
      "unlinked",
    );
    await EventBus.instance.idle();

    expect(signal).not.toHaveBeenCalled();
    const [sent] = await DatabaseConnector.instance.database
      .select({ payload: eventsTable.payload })
      .from(eventsTable)
      .where(eq(eventsTable.type, EEventType.MessageSent));
    expect(sent?.payload).toEqual(
      expect.objectContaining({ chatId: "bella:acct-unlinked", channel: EMessagePlatform.App }),
    );
  });
});

describe("readAttachment", () => {
  test("refuses a file declared larger than the cap without reading it", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, { headers: { "content-length": "6000000" } });

    expect(await readAttachment(response, 5_000_000)).toBeUndefined();
    expect(cancelled).toBe(true);
    expect(await readAttachment(new Response("abc"), 2)).toBeUndefined();
    expect(await readAttachment(new Response("abc"), 3)).toEqual(new TextEncoder().encode("abc"));
  });
});
