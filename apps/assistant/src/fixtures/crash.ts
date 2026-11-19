// Boots the app with a stub transport and a stub model, and dies with SIGKILL at a named point.
// usage: crash.ts <directory> <point> [message...]
// The directory holds the sends and model logs; the cwd holds the test database.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { AppLogger } from "@bellaclaw/behavior-logs";
import {
  EEventType,
  eventDeliveriesTable,
  eventsTable,
  type TSelectEvent,
} from "@bellaclaw/database";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { AgentHarness } from "../services/ai/agent-harness";
import { DatabaseConnector } from "../services/database";
import { ESubscriptionMode, EventBus, type TEventDraft } from "../services/events";
import { EIdentityLinkOwner } from "../services/identity/schema";
import { McpAuthCredentialStore } from "../services/mcp/auth/store";
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
  // after identity.link.started commits, before it is dispatched
  LinkStarted = "link-started",
  // after identity.link.quiet, the barrier's fact, commits, before it is dispatched
  LinkQuiet = "link-quiet",
  // inside Identity's transaction that would activate the link
  LinkActivation = "link-activation",
  None = "none",
}

// after the identity.link.moved of an owner commits, before it is dispatched; for MCP auth, after
// its credentials file is written, before the move's ack commits
const LINK_MOVED_POINT = "link-moved-";

const CRASH_CHAT_ID = "signal:+100";
const CRASH_ACCOUNT_ID = "acct-crash";
const SIdentityLinkMovedOwner = z.object({ owner: z.string() });

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

    if (
      point === ECrashPoint.LinkStarted &&
      appended.some((row) => row.type === EEventType.IdentityLinkStarted)
    ) {
      kill();
    }

    if (
      point === ECrashPoint.LinkQuiet &&
      appended.some((row) => row.type === EEventType.IdentityLinkQuiet)
    ) {
      kill();
    }

    if (
      appended.some(
        (row) =>
          row.type === EEventType.IdentityLinkMoved &&
          point !== `${LINK_MOVED_POINT}${EIdentityLinkOwner.McpAuth}` &&
          point ===
            `${LINK_MOVED_POINT}${SIdentityLinkMovedOwner.safeParse(row.payload).data?.owner}`,
      )
    ) {
      kill();
    }

    afterCommit(appended);
  },
});
// biome-ignore lint/complexity/useLiteralKeys: a private method, reached for the crash point
const append = bus["append"].bind(bus);
Object.assign(bus, {
  append: (...args: Parameters<typeof append>) => {
    if (
      point === ECrashPoint.LinkActivation &&
      args[1].some((draft: TEventDraft) => draft.type === EEventType.IdentityLinked)
    ) {
      kill();
    }

    return append(...args);
  },
});
const moveAll = McpAuthCredentialStore.prototype.moveAll;
Object.assign(McpAuthCredentialStore.prototype, {
  moveAll: async function (this: McpAuthCredentialStore, from: string, to: string) {
    const moved = await moveAll.call(this, from, to);

    if (point === `${LINK_MOVED_POINT}${EIdentityLinkOwner.McpAuth}`) {
      kill();
    }

    return moved;
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

// the first boot of a link point runs one turn, then links its chat to an account
if (point.startsWith("link-")) {
  messages.push("hello");
}

for (const content of messages) {
  await bus.publish({
    type: EEventType.TurnRequested,
    source: "crash",
    key: CRASH_CHAT_ID,
    trace,
    payload: {
      conversationKey: CRASH_CHAT_ID,
      ownerKey: CRASH_CHAT_ID,
      channel: EMessagePlatform.Signal,
      replyAddress: "+100",
      content,
      attachments: [],
      receivedAt: Date.now(),
    },
    causationId: undefined,
    dedupeKey: undefined,
  });
  // one turn after the other, as a user would send them
  await bus.idle();
}

if (point.startsWith("link-")) {
  await bus.publish({
    type: EEventType.IdentityLinkRequested,
    source: "crash",
    key: CRASH_CHAT_ID,
    trace,
    payload: { accountId: CRASH_ACCOUNT_ID, channel: EMessagePlatform.Signal, address: "+100" },
    causationId: undefined,
    dedupeKey: undefined,
  });
}

await bus.idle();
process.exit(0);
