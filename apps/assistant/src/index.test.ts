import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EEventType,
  eventDeliveriesTable,
  eventsTable,
  MIGRATIONS_FOLDER,
} from "@bellaclaw/database";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

test.each([
  "SIGINT",
  "SIGTERM",
])("%s shutdown persists every queued behavior event", async (signal) => {
  const directory = await mkdtemp(join(tmpdir(), "bellaclaw-shutdown-"));
  const dbPath = join(directory, "behavior.db");
  try {
    const child = Bun.spawn(["bun", "--no-env-file", "src/fixtures/shutdown.ts", dbPath, signal], {
      cwd: join(import.meta.dir, ".."),
      env: { ...Bun.env, BELLACLAW_LOG_DB_PATH: dbPath, BELLACLAW_MCP_PUBLIC_URL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    await new Response(child.stdout).text();
    if ((await child.exited) !== 0) {
      throw new Error(`Shutdown fixture failed: ${stderr}`);
    }
    const database = new Database(dbPath, { readonly: true });
    try {
      const rows = database
        .query<{ metadataJson: string }, []>(
          "SELECT metadataJson FROM app_event_logs WHERE event = 'shutdown.regression' ORDER BY id",
        )
        .all();
      expect(rows.map((row) => JSON.parse(row.metadataJson))).toEqual(
        Array.from({ length: 8 }, (_, sequence) => ({ sequence })),
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("crash recovery", () => {
  const chatId = "signal:+100";
  const interrupted =
    "I was restarted while answering, so that reply is lost. Some actions may already be done. Check before asking again.";
  let directory: string;
  let db: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "bellaclaw-crash-"));
    // the fixture runs in this directory, so its test database lives here
    db = drizzle({ connection: { url: `file:${join(directory, "test.db")}` } });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterEach(async () => {
    db.$client.close();
    await rm(directory, { recursive: true, force: true });
  });

  // returns the exit signal: "SIGKILL" when the fixture died at its point
  async function boot(point: string, messages: string[]) {
    const child = Bun.spawn(
      [
        "bun",
        "--no-env-file",
        join(import.meta.dir, "fixtures/crash.ts"),
        directory,
        point,
        ...messages,
      ],
      {
        cwd: directory,
        env: {
          ...Bun.env,
          BELLACLAW_DATABASE_MODE: "test",
          BELLACLAW_LOG_DB_PATH: join(directory, "behavior.db"),
          BELLACLAW_MCP_PUBLIC_URL: "",
          SIGNAL_ENABLED: "false",
          DISCORD_TOKEN: "",
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const stderr = await new Response(child.stderr).text();
    const code = await child.exited;

    if (child.signalCode !== "SIGKILL" && code !== 0) {
      throw new Error(`Crash fixture failed at ${point}: ${stderr}`);
    }

    return child.signalCode;
  }

  async function lines(file: string): Promise<unknown[]> {
    const log = Bun.file(join(directory, file));

    if (!(await log.exists())) {
      return [];
    }

    return (await log.text())
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  }

  async function deliveries(type: EEventType) {
    return db
      .select({
        consumer: eventDeliveriesTable.consumer,
        status: eventDeliveriesTable.status,
        attempts: eventDeliveriesTable.attempts,
        lastError: eventDeliveriesTable.lastError,
      })
      .from(eventDeliveriesTable)
      .innerJoin(eventsTable, eq(eventsTable.seq, eventDeliveriesTable.eventSeq))
      .where(eq(eventsTable.type, type))
      .orderBy(asc(eventDeliveriesTable.eventSeq));
  }

  async function pending() {
    return db.select().from(eventDeliveriesTable).where(eq(eventDeliveriesTable.status, "pending"));
  }

  test("after the append, before dispatch: the delivery replays once", async () => {
    expect(await boot("append", ["hello"])).toBe("SIGKILL");
    expect(await lines("model.log")).toEqual([]);

    expect(await boot("none", [])).toBeNull();

    expect(await lines("model.log")).toEqual(["hello"]);
    expect(await lines("sends.log")).toEqual([["+100", "Reply to hello"]]);
    expect(await deliveries(EEventType.TurnRequested)).toEqual([
      { consumer: "conversation", status: "done", attempts: 1, lastError: null },
    ]);
    expect(await pending()).toEqual([]);
  }, 30_000);

  test("inside the outbound handler, before the send: exactly one send", async () => {
    expect(await boot("send", ["hello"])).toBe("SIGKILL");
    expect(await lines("sends.log")).toEqual([]);

    expect(await boot("none", [])).toBeNull();

    expect(await lines("model.log")).toEqual(["hello"]);
    expect(await lines("sends.log")).toEqual([["+100", "Reply to hello"]]);
    expect(await deliveries(EEventType.ReplyReady)).toEqual([
      { consumer: "outbound", status: "done", attempts: 1, lastError: null },
    ]);
    expect(await pending()).toEqual([]);
  }, 30_000);

  test("after turn.started, during the model call: one interrupted reply, no model call on restart", async () => {
    expect(await boot("model", ["hello"])).toBe("SIGKILL");
    expect(await lines("model.log")).toEqual(["hello"]);

    expect(await boot("none", [])).toBeNull();

    expect(await lines("model.log")).toEqual(["hello"]);
    expect(await lines("sends.log")).toEqual([["+100", interrupted]]);
    const failed = await db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.type, EEventType.TurnFailed));
    expect(failed.map((row) => row.payload)).toEqual([{ chatId, reason: "interrupted" }]);
    expect(await pending()).toEqual([]);
  }, 30_000);

  test("during post-turn compaction: the reply is sent once and the next turn runs", async () => {
    expect(await boot("compaction", ["first"])).toBe("SIGKILL");
    expect(await lines("sends.log")).toEqual([["+100", "Reply to first"]]);

    expect(await boot("none", ["second"])).toBeNull();

    expect(await lines("model.log")).toEqual(["first", "second"]);
    expect(await lines("sends.log")).toEqual([
      ["+100", "Reply to first"],
      ["+100", "Reply to second"],
    ]);
    expect(await pending()).toEqual([]);
  }, 30_000);

  test("a handler that kills the process on every attempt: dead after its attempts, one notice", async () => {
    // the first run is uncounted: dispatch writes no attempt
    expect(await boot("poison", [])).toBe("SIGKILL");
    // boot costs the one attempt, and the replay dies
    expect(await boot("none", [])).toBe("SIGKILL");
    // at its limit: dead without running
    expect(await boot("none", [])).toBeNull();

    expect(await deliveries(EEventType.TestNoted)).toEqual([
      { consumer: "crash-poison", status: "dead", attempts: 1, lastError: "interrupted" },
    ]);
    expect(await lines("sends.log")).toEqual([
      ["+100", "Something I was doing failed and was dropped. Try again."],
    ]);

    // a later boot sends nothing more
    expect(await boot("none", [])).toBeNull();
    expect(await lines("sends.log")).toHaveLength(1);
    expect(await pending()).toEqual([]);
  }, 30_000);
});
