// Boots the app with a stub transport and a stub model, and dies with SIGKILL at a named point.
// usage: crash.ts <directory> <point> [message...]
// The directory holds the sends and model logs; the cwd holds the test database.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { AppLogger } from "@bellaclaw/behavior-logs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { and, eq } from "drizzle-orm";
import { AgentHarness } from "../services/ai/agent-harness";
import { DatabaseConnector } from "../services/database";
import { eventDeliveriesTable, eventsTable, type TSelectEvent } from "../services/database/schema";
import { ESubscriptionMode, EventBus } from "../services/events";
import { EEventType } from "../services/events/catalog";
import { FactDistiller } from "../services/memory/distill";
import { MessagingAdapter } from "../services/messaging";
import { EMessagePlatform } from "../services/messaging/types";

enum ECrashPoint {
  // after turn.requested commits, before it is dispatched
  Append = "append",
  // inside the outbound handler, before the transport send
  Send = "send",
  // after turn.started, during the model call
  Model = "model",
  // during post-turn compaction, once the reply is sent
  Compaction = "compaction",
  // publishes test.noted, whose handler kills the process on every attempt
  Poison = "poison",
  None = "none",
}

const CRASH_CHAT_ID = "signal:+100";

const [directory, point, ...messages] = Bun.argv.slice(2);

if (directory === undefined || point === undefined) {
  throw new Error("usage: crash.ts <directory> <point> [message...]");
}

function kill(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
}

function record(file: string, line: unknown): void {
  appendFileSync(join(directory ?? "", file), `${JSON.stringify(line)}\n`);
}

const trace = { turnId: "crash:test", chatId: CRASH_CHAT_ID, platform: EMessagePlatform.Signal };
const bus = EventBus.instance;

MessagingAdapter.instance.registerTransport({
  platform: EMessagePlatform.Signal,
  sendText: async (chatId, text) => {
    if (point === ECrashPoint.Send) {
      kill();
    }

    record("sends.log", [chatId, text]);
  },
  fetchAttachment: async () => new Uint8Array(),
  deleteAttachment: async () => undefined,
});

let compactions = 0;
Object.assign(AgentHarness.instance, {
  runMain: async (
    args: Parameters<AgentHarness["runMain"]>[0],
  ): ReturnType<AgentHarness["runMain"]> => {
    record("model.log", args.prompt);

    if (point === ECrashPoint.Model) {
      kill();
    }

    const text = `Reply to ${args.prompt}`;

    return {
      text,
      iterations: 1,
      toolCallCount: 0,
      stopReason: "stop",
      messages: [
        { role: "user", content: args.prompt, timestamp: Date.now() },
        fauxAssistantMessage(text),
      ],
    };
  },
  compactConversation: async () => {
    compactions += 1;

    // the first compaction of a fresh chat is the post-turn one
    if (point === ECrashPoint.Compaction && compactions === 1) {
      // dies only after the reply's send is acked, so the send is not repeated
      while (true) {
        const sent = await DatabaseConnector.instance.run((db) =>
          db
            .select()
            .from(eventDeliveriesTable)
            .innerJoin(eventsTable, eq(eventsTable.seq, eventDeliveriesTable.eventSeq))
            .where(
              and(
                eq(eventsTable.type, EEventType.ReplyReady),
                eq(eventDeliveriesTable.consumer, "outbound"),
                eq(eventDeliveriesTable.status, "done"),
              ),
            ),
        );

        if (sent.length > 0) {
          kill();
        }

        await Bun.sleep(10);
      }
    }

    return undefined;
  },
});
// the fact drain is a model call
Object.assign(FactDistiller.instance, { drainLiveFactWindows: async () => true });

// biome-ignore lint/complexity/useLiteralKeys: a private method, reached for the crash point
const afterCommit = bus["afterCommit"].bind(bus);
Object.assign(bus, {
  afterCommit: (appended: TSelectEvent[]) => {
    if (
      point === ECrashPoint.Append &&
      appended.some((row) => row.type === EEventType.TurnRequested)
    ) {
      kill();
    }

    afterCommit(appended);
  },
});

bus.subscribe({
  consumer: "crash-poison",
  type: EEventType.TestNoted,
  mode: ESubscriptionMode.Durable,
  backoffMs: [],
  handler: async () => kill(),
});

const booted = Promise.withResolvers<void>();
Object.assign(AppLogger, {
  _instance: new AppLogger({
    dbPath: Bun.env.BELLACLAW_LOG_DB_PATH,
    stdout(event) {
      if (event.event === "app.boot.complete") {
        booted.resolve();
      }
    },
  }),
});
await import("../index");
await booted.promise;

if (point === ECrashPoint.Poison) {
  await bus.publish({
    type: EEventType.TestNoted,
    source: "crash",
    key: CRASH_CHAT_ID,
    trace,
    payload: { text: "poison", count: 1 },
    causationId: undefined,
    dedupeKey: undefined,
  });
}

for (const content of messages) {
  await bus.publish({
    type: EEventType.TurnRequested,
    source: "crash",
    key: CRASH_CHAT_ID,
    trace,
    payload: {
      chatId: CRASH_CHAT_ID,
      content,
      attachments: [],
      receivedAt: Date.now(),
      platform: EMessagePlatform.Signal,
    },
    causationId: undefined,
    dedupeKey: undefined,
  });
  // one turn after the other, as a user would send them
  await bus.idle();
}

await bus.idle();
process.exit(0);
