import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TOption } from "@bellaclaw/shared";
import type { TEvent, TEventAttachment, TEventDirection, TEventKind } from "./control-schema";

type TEventRow = {
  id: number;
  at: number;
  chat: string;
  kind: TEventKind;
  direction: TEventDirection;
  text: string | null;
  attachments: string;
  signal_ts: number | null;
  returned: number;
};

export type TNewEvent = {
  chat: string;
  kind: TEventKind;
  direction: TEventDirection;
  text: TOption<string>;
  attachments: TEventAttachment[];
  signalTs: TOption<number>;
  payload: TOption<string>;
};

function toEvent(row: TEventRow): TEvent {
  const attachments: TEventAttachment[] = JSON.parse(row.attachments);
  return {
    id: row.id,
    at: row.at,
    chat: row.chat,
    kind: row.kind,
    direction: row.direction,
    text: row.text,
    attachments,
    signalTimestamp: row.signal_ts,
  };
}

export class TranscriptStore {
  private db: Database;

  public constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      chat TEXT NOT NULL,
      kind TEXT NOT NULL,
      direction TEXT NOT NULL,
      text TEXT,
      attachments TEXT NOT NULL DEFAULT '[]',
      signal_ts INTEGER,
      payload TEXT,
      returned INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS events_chat ON events (chat, id)");
    this.db.run(`CREATE TABLE IF NOT EXISTS pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL
    )`);
  }

  public close() {
    this.db.close();
  }

  public addEvent(event: TNewEvent): number {
    const result = this.db
      .query(
        "INSERT INTO events (at, chat, kind, direction, text, attachments, signal_ts, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        Date.now(),
        event.chat,
        event.kind,
        event.direction,
        event.text ?? null,
        JSON.stringify(event.attachments),
        event.signalTs ?? null,
        event.payload ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  public events(chat: string, limit: number, includeEvents: boolean): TEvent[] {
    let kinds = "('message')";
    if (includeEvents) {
      kinds = "('message', 'typing', 'receipt', 'noise')";
    }

    const rows = this.db
      .query<TEventRow, [string, number]>(
        `SELECT * FROM (SELECT * FROM events WHERE chat = ? AND kind IN ${kinds} ORDER BY id DESC LIMIT ?) ORDER BY id`,
      )
      .all(chat, limit);
    return rows.map(toEvent);
  }

  public chats(): { number: string; inbound: number; outbound: number; lastAt: number }[] {
    return this.db
      .query<{ number: string; inbound: number; outbound: number; lastAt: number }, []>(
        `SELECT chat AS number,
          SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS inbound,
          SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS outbound,
          MAX(at) AS lastAt
        FROM events WHERE kind = 'message' GROUP BY chat ORDER BY lastAt DESC`,
      )
      .all();
  }

  public lastInbound(chat: string): TOption<{ payload: string; signal_ts: number }> {
    const row = this.db
      .query<{ payload: string; signal_ts: number }, [string]>(
        "SELECT payload, signal_ts FROM events WHERE chat = ? AND kind = 'message' AND direction = 'in' AND payload IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get(chat);
    return row ?? undefined;
  }

  public lastOutboundTimestamp(chat: string): TOption<number> {
    const row = this.db
      .query<{ signal_ts: number }, [string]>(
        "SELECT signal_ts FROM events WHERE chat = ? AND kind = 'message' AND direction = 'out' AND signal_ts IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get(chat);
    return row?.signal_ts;
  }

  // NOTE: ready means unreturned assistant messages exist, the assistant's typing indicator for
  // the chat is off, and no assistant activity happened in the last `settleMs`.
  // `after` holds the turn open until a reply newer than that timestamp exists, so a reply left
  // unread from an earlier turn cannot answer a new message.
  public takeReplies(chat: string, settleMs: number, after: TOption<number>): TOption<TEvent[]> {
    return this.db.transaction(() => {
      const rows = this.db
        .query<TEventRow, [string]>(
          "SELECT * FROM events WHERE chat = ? AND kind = 'message' AND direction = 'out' AND returned = 0 ORDER BY id",
        )
        .all(chat);
      if (rows.length === 0) {
        return undefined;
      }

      if (after !== undefined && !rows.some((row) => row.at > after)) {
        return undefined;
      }

      const typing = this.db
        .query<{ text: string }, [string]>(
          "SELECT text FROM events WHERE chat = ? AND kind = 'typing' AND direction = 'out' ORDER BY id DESC LIMIT 1",
        )
        .get(chat);
      if (typing?.text === "on") {
        return undefined;
      }

      const last = this.db
        .query<{ at: number }, [string]>(
          "SELECT MAX(at) AS at FROM events WHERE chat = ? AND kind IN ('message', 'typing') AND direction = 'out'",
        )
        .get(chat);
      if (last !== null && Date.now() - last.at < settleMs) {
        return undefined;
      }

      const lastRow = rows.at(-1);
      if (lastRow !== undefined) {
        this.db
          .query(
            "UPDATE events SET returned = 1 WHERE chat = ? AND kind = 'message' AND direction = 'out' AND id <= ?",
          )
          .run(chat, lastRow.id);
      }

      return rows.map(toEvent);
    })();
  }

  public enqueue(payload: string) {
    this.db.query("INSERT INTO pending (payload) VALUES (?)").run(payload);
  }

  public drainQueue(): string[] {
    return this.db.transaction(() => {
      const rows = this.db
        .query<{ payload: string }, []>("SELECT payload FROM pending ORDER BY id")
        .all();
      this.db.run("DELETE FROM pending");
      return rows.map((row) => row.payload);
    })();
  }

  public pendingCount(): number {
    const row = this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending").get();
    return row?.count ?? 0;
  }
}
