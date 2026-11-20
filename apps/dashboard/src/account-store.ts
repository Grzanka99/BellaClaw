import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { TDashboardLinkToken, TOption } from "@bellaclaw/shared";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// id: the row id, which never leaves the dashboard; publicId: the account's id for the assistant
export type TAccount = { id: number; publicId: string; username: string };

// the new account, or why none was created
export type TRegistration = { account: TAccount } | { failure: "usernameTaken" | "linkUsed" };

// cookie: a session of the web client, which ends SESSION_TTL_MS after its last request; bearer: a
// session of the app, which lasts until logout or a new password
export type TSessionKind = "cookie" | "bearer";

// a row of account_chats: its chat, and its account's row id and public id
export type TImportRow = { chatId: string; accountId: number; publicId: string };

// only the hash of a session token is stored
function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createPublicId(): string {
  return randomBytes(16).toString("base64url");
}

// Accounts, sessions of both kinds and used link tokens. Every `now` is epoch ms.
export class AccountStore {
  private db: Database;

  // path: a database file, or ":memory:". An account without a public id gets one here.
  constructor(path: string) {
    this.db = new Database(path);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        passwordHash TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        publicId TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        tokenHash TEXT PRIMARY KEY,
        accountId INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_sessions (
        tokenHash TEXT PRIMARY KEY,
        accountId INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS used_link_tokens (
        nonce TEXT PRIMARY KEY,
        expiresAt INTEGER NOT NULL
      );
    `);

    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(accounts)").all();

    if (!columns.some((column) => column.name === "publicId")) {
      this.db.run("ALTER TABLE accounts ADD COLUMN publicId TEXT");
    }

    const missing = this.db
      .query<{ id: number }, []>("SELECT id FROM accounts WHERE publicId IS NULL")
      .all();

    for (const { id } of missing) {
      this.db.query("UPDATE accounts SET publicId = ? WHERE id = ?").run(createPublicId(), id);
    }

    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS accounts_public_id ON accounts (publicId)");
  }

  // username matches in any letter case; the answer carries it as stored
  public findCredentials(username: string): TOption<TAccount & { passwordHash: string }> {
    return (
      this.db
        .query<TAccount & { passwordHash: string }, [string]>(
          "SELECT id, publicId, username, passwordHash FROM accounts WHERE username = ?",
        )
        .get(username) ?? undefined
    );
  }

  public findByPublicId(publicId: string): TOption<TAccount> {
    return (
      this.db
        .query<TAccount, [string]>("SELECT id, publicId, username FROM accounts WHERE publicId = ?")
        .get(publicId) ?? undefined
    );
  }

  // Creates the account and uses up its link, when it has one, in one transaction, so a failure
  // consumes nothing. Without a link the account has no chat until one is linked.
  public createAccount(
    username: string,
    passwordHash: string,
    link: TOption<TDashboardLinkToken>,
    now: number,
  ): TRegistration {
    return this.db.transaction((): TRegistration => {
      if (link !== undefined && (link.expiresAt <= now || this.isLinkUsed(link.nonce))) {
        return { failure: "linkUsed" };
      }

      if (this.findCredentials(username) !== undefined) {
        return { failure: "usernameTaken" };
      }

      const publicId = createPublicId();
      const id = Number(
        this.db
          .query(
            "INSERT INTO accounts (username, passwordHash, createdAt, publicId) VALUES (?, ?, ?, ?)",
          )
          .run(username, passwordHash, now, publicId).lastInsertRowid,
      );

      if (link !== undefined) {
        this.useLink(link, now);
      }

      return { account: { id, publicId, username } };
    })();
  }

  public isLinkUsed(nonce: string): boolean {
    return this.db.query("SELECT 1 FROM used_link_tokens WHERE nonce = ?").get(nonce) !== null;
  }

  // False when the link was already used or has expired.
  public consumeLink(link: TDashboardLinkToken, now: number): boolean {
    return this.db.transaction(() => this.useLink(link, now))();
  }

  // Uses up the link, sets the password hash when one is given (ending the account's other
  // sessions of both kinds), and returns a new session token of the kind, all in one transaction.
  // Undefined, with nothing changed, when the link was already used or has expired.
  public redeemLoginLink(
    accountId: number,
    link: TDashboardLinkToken,
    passwordHash: TOption<string>,
    kind: TSessionKind,
    now: number,
  ): TOption<string> {
    return this.db.transaction((): TOption<string> => {
      if (!this.useLink(link, now)) {
        return undefined;
      }

      if (passwordHash !== undefined) {
        this.db
          .query("UPDATE accounts SET passwordHash = ? WHERE id = ?")
          .run(passwordHash, accountId);
        this.db.query("DELETE FROM sessions WHERE accountId = ?").run(accountId);
        this.db.query("DELETE FROM app_sessions WHERE accountId = ?").run(accountId);
      }

      if (kind === "bearer") {
        return this.createAppSession(accountId, now);
      }

      return this.createSession(accountId, now);
    })();
  }

  // The row of account_chats for the chat, while the import still holds one whose account exists.
  public findImportRow(chatId: string): TOption<TImportRow> {
    if (!this.hasImportTable()) {
      return undefined;
    }

    return (
      this.db
        .query<TImportRow, [string]>(
          `SELECT account_chats.chatId, account_chats.accountId, accounts.publicId FROM account_chats
           JOIN accounts ON accounts.id = account_chats.accountId
           WHERE account_chats.chatId = ?`,
        )
        .get(chatId) ?? undefined
    );
  }

  // The oldest row of account_chats whose account exists, skipping the given chat ids. Undefined
  // once none is left or the table is gone.
  public nextImportRow(skipped: Set<string>): TOption<TImportRow> {
    if (!this.hasImportTable()) {
      return undefined;
    }

    const rows = this.db
      .query<TImportRow, []>(
        `SELECT account_chats.chatId, account_chats.accountId, accounts.publicId FROM account_chats
         JOIN accounts ON accounts.id = account_chats.accountId
         ORDER BY account_chats.linkedAt, account_chats.chatId`,
      )
      .all();

    return rows.find((row) => !skipped.has(row.chatId));
  }

  public deleteImportRow(chatId: string): void {
    this.db.query("DELETE FROM account_chats WHERE chatId = ?").run(chatId);
  }

  // Drops account_chats when it holds no row. Otherwise keeps it and answers the account row ids of
  // its rows whose account does not exist.
  public finishImport(): { orphanAccountIds: number[] } {
    return this.db.transaction(() => {
      if (!this.hasImportTable()) {
        return { orphanAccountIds: [] };
      }

      if (this.db.query("SELECT 1 FROM account_chats").get() === null) {
        this.db.run("DROP TABLE account_chats");

        return { orphanAccountIds: [] };
      }

      const orphans = this.db
        .query<{ accountId: number }, []>(
          `SELECT DISTINCT account_chats.accountId FROM account_chats
           LEFT JOIN accounts ON accounts.id = account_chats.accountId
           WHERE accounts.id IS NULL`,
        )
        .all();

      return { orphanAccountIds: orphans.map((orphan) => orphan.accountId) };
    })();
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

  // The account of a live session; its expiry stays as it is.
  public findSession(token: string, now: number): TOption<TAccount> {
    return (
      this.db
        .query<TAccount, [string, number]>(
          `SELECT accounts.id, accounts.publicId, accounts.username FROM sessions
           JOIN accounts ON accounts.id = sessions.accountId
           WHERE sessions.tokenHash = ? AND sessions.expiresAt > ?`,
        )
        .get(hashSessionToken(token), now) ?? undefined
    );
  }

  // The account of a live session, whose expiry moves a full lifetime ahead.
  public touchSession(token: string, now: number): TOption<TAccount> {
    const account = this.findSession(token, now);

    if (account === undefined) {
      return undefined;
    }

    this.db
      .query("UPDATE sessions SET expiresAt = ? WHERE tokenHash = ?")
      .run(now + SESSION_TTL_MS, hashSessionToken(token));

    return account;
  }

  public deleteSession(token: string): void {
    this.db.query("DELETE FROM sessions WHERE tokenHash = ?").run(hashSessionToken(token));
  }

  // Returns the bearer token of a new app session, which has no expiry.
  public createAppSession(accountId: number, now: number): string {
    const token = randomBytes(32).toString("base64url");

    this.db
      .query("INSERT INTO app_sessions (tokenHash, accountId, createdAt) VALUES (?, ?, ?)")
      .run(hashSessionToken(token), accountId, now);

    return token;
  }

  // The account of an app session that has not been ended.
  public findAppSession(token: string): TOption<TAccount> {
    return (
      this.db
        .query<TAccount, [string]>(
          `SELECT accounts.id, accounts.publicId, accounts.username FROM app_sessions
           JOIN accounts ON accounts.id = app_sessions.accountId
           WHERE app_sessions.tokenHash = ?`,
        )
        .get(hashSessionToken(token)) ?? undefined
    );
  }

  public deleteAppSession(token: string): void {
    this.db.query("DELETE FROM app_sessions WHERE tokenHash = ?").run(hashSessionToken(token));
  }

  private hasImportTable(): boolean {
    return (
      this.db
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'account_chats'")
        .get() !== null
    );
  }

  // NOTE: runs inside the caller's transaction. False when the link was already used or has
  // expired.
  private useLink(link: TDashboardLinkToken, now: number): boolean {
    // NOTE: the rows of expired tokens go below, so an expired token is refused here and never
    // reaches the insert
    if (link.expiresAt <= now) {
      return false;
    }

    this.db.query("DELETE FROM used_link_tokens WHERE expiresAt <= ?").run(now);

    return (
      this.db
        .query(
          "INSERT INTO used_link_tokens (nonce, expiresAt) VALUES (?, ?) ON CONFLICT DO NOTHING",
        )
        .run(link.nonce, link.expiresAt).changes > 0
    );
  }
}
