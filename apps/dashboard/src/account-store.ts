import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { TDashboardLinkToken, TOption } from "@bellaclaw/shared";
import type { TLinkedChat } from "./api-types";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type TAccount = { id: number; username: string };

// the new account's id, or why none was created
export type TRegistration = { accountId: number } | { failure: "usernameTaken" | "linkUsed" };

// only the hash of a session token is stored
function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Accounts, sessions, linked chats and used link tokens. Every `now` is epoch ms.
export class AccountStore {
  private db: Database;

  // path: a database file, or ":memory:"
  constructor(path: string) {
    this.db = new Database(path);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        passwordHash TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        tokenHash TEXT PRIMARY KEY,
        accountId INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_chats (
        chatId TEXT PRIMARY KEY,
        accountId INTEGER NOT NULL,
        linkedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS used_link_tokens (
        nonce TEXT PRIMARY KEY,
        expiresAt INTEGER NOT NULL
      );
    `);
  }

  // username matches in any letter case; the answer carries it as stored
  public findCredentials(username: string): TOption<TAccount & { passwordHash: string }> {
    return (
      this.db
        .query<TAccount & { passwordHash: string }, [string]>(
          "SELECT id, username, passwordHash FROM accounts WHERE username = ?",
        )
        .get(username) ?? undefined
    );
  }

  // Creates the account and redeems its link in one transaction, so a failure consumes nothing.
  public createAccount(
    username: string,
    passwordHash: string,
    link: TDashboardLinkToken,
    now: number,
  ): TRegistration {
    return this.db.transaction((): TRegistration => {
      if (this.isLinkUsed(link.nonce)) {
        return { failure: "linkUsed" };
      }

      if (this.findCredentials(username) !== undefined) {
        return { failure: "usernameTaken" };
      }

      const accountId = Number(
        this.db
          .query("INSERT INTO accounts (username, passwordHash, createdAt) VALUES (?, ?, ?)")
          .run(username, passwordHash, now).lastInsertRowid,
      );
      this.redeem(accountId, link, now);

      return { accountId };
    })();
  }

  public isLinkUsed(nonce: string): boolean {
    return this.db.query("SELECT 1 FROM used_link_tokens WHERE nonce = ?").get(nonce) !== null;
  }

  // False when the link was already used. A chat linked to another account moves to this one.
  public redeemLink(accountId: number, link: TDashboardLinkToken, now: number): boolean {
    return this.db.transaction(() => this.redeem(accountId, link, now))();
  }

  public listChats(accountId: number): TLinkedChat[] {
    return this.db
      .query<TLinkedChat, [number]>(
        "SELECT chatId, linkedAt FROM account_chats WHERE accountId = ? ORDER BY linkedAt DESC",
      )
      .all(accountId);
  }

  public isChatLinked(accountId: number, chatId: string): boolean {
    return (
      this.db
        .query("SELECT 1 FROM account_chats WHERE chatId = ? AND accountId = ?")
        .get(chatId, accountId) !== null
    );
  }

  // Returns the session token for the cookie.
  public createSession(accountId: number, now: number): string {
    const token = randomBytes(32).toString("base64url");

    this.db.query("DELETE FROM sessions WHERE expiresAt <= ?").run(now);
    this.db
      .query("INSERT INTO sessions (tokenHash, accountId, expiresAt) VALUES (?, ?, ?)")
      .run(hashSessionToken(token), accountId, now + SESSION_TTL_MS);

    return token;
  }

  // The account of a live session, whose expiry moves a full lifetime ahead.
  public touchSession(token: string, now: number): TOption<TAccount> {
    const tokenHash = hashSessionToken(token);
    const account = this.db
      .query<TAccount, [string, number]>(
        `SELECT accounts.id, accounts.username FROM sessions
         JOIN accounts ON accounts.id = sessions.accountId
         WHERE sessions.tokenHash = ? AND sessions.expiresAt > ?`,
      )
      .get(tokenHash, now);

    if (account === null) {
      return undefined;
    }

    this.db
      .query("UPDATE sessions SET expiresAt = ? WHERE tokenHash = ?")
      .run(now + SESSION_TTL_MS, tokenHash);

    return account;
  }

  public deleteSession(token: string): void {
    this.db.query("DELETE FROM sessions WHERE tokenHash = ?").run(hashSessionToken(token));
  }

  // NOTE: runs inside the caller's transaction
  private redeem(accountId: number, link: TDashboardLinkToken, now: number): boolean {
    // an expired token fails verification, so its nonce needs no row
    this.db.query("DELETE FROM used_link_tokens WHERE expiresAt <= ?").run(now);

    const used = this.db
      .query("INSERT INTO used_link_tokens (nonce, expiresAt) VALUES (?, ?) ON CONFLICT DO NOTHING")
      .run(link.nonce, link.expiresAt);

    if (used.changes === 0) {
      return false;
    }

    this.db
      .query(
        `INSERT INTO account_chats (chatId, accountId, linkedAt) VALUES (?, ?, ?)
         ON CONFLICT (chatId) DO UPDATE SET
           accountId = excluded.accountId,
           linkedAt = excluded.linkedAt`,
      )
      .run(link.chatId, accountId, now);

    return true;
  }
}
