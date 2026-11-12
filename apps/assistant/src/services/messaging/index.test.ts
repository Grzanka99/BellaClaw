import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DatabaseConnector } from "../database";
import { eventDeliveriesTable, eventsTable } from "../database/schema";
import { resetEventTables } from "../database/test-utils";
import { EventBus, type TEventDraft } from "../events";
import { EEventType } from "../events/catalog";
import { MessagingAdapter } from ".";
import { EMessagePlatform } from "./types";

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
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    await bus.idle();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("+100", "Notice");
    expect((await deliveries()).map((row) => [row.consumer, row.status])).toEqual([
      ["outbound", "done"],
    ]);
    expect((await sentEvents()).map((row) => row.payload)).toEqual([
      {
        chatId: "signal:+100",
        sourceType: EEventType.NoticeReady,
        chars: 6,
        sentAt: expect.any(Number),
      },
    ]);
  });

  test("delivers reply.ready to its transport and absorbs a transport failure", async () => {
    const sendText = mock(async () => undefined);
    const adapter = MessagingAdapter.instance;
    Object.assign(adapter, { outboundBackoffMs: [] });
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    adapter.setup();
    await bus.start();
    const reply = { ...notice(), type: EEventType.ReplyReady };

    await bus.publish({ ...reply, payload: { chatId: "signal:+100", text: "Root reply" } });
    await bus.idle();
    expect(sendText).toHaveBeenCalledWith("+100", "Root reply");

    sendText.mockImplementation(async () => {
      throw new Error("offline");
    });
    await expect(
      bus.publish({ ...reply, payload: { chatId: "signal:+100", text: "again" } }),
    ).resolves.toBeUndefined();
    await bus.idle();
    expect((await deliveries()).map((row) => row.status)).toEqual(["done", "dead"]);
  });

  test("a failed send does not publish message.sent", async () => {
    const sendText = mock(async () => {
      throw new Error("offline");
    });
    const adapter = MessagingAdapter.instance;
    Object.assign(adapter, { outboundBackoffMs: [] });
    adapter.registerTransport({ platform: EMessagePlatform.Signal, sendText });
    adapter.setup();
    await bus.start();

    await bus.publish(notice());
    await bus.idle();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect((await deliveries()).map((row) => [row.consumer, row.status])).toEqual([
      ["outbound", "dead"],
    ]);
    expect(await sentEvents()).toEqual([]);
  });
});
