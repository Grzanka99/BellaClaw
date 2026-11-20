import { randomBytes } from "node:crypto";
import {
  ADDRESS_LINKED_ELSEWHERE,
  createLogger,
  SDashboardModelUpdate,
  type TDashboardLinkToken,
  type TOption,
  verifyDashboardLinkToken,
} from "@bellaclaw/shared";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { CookieOptions } from "hono/utils/cookie";
import { z } from "zod";
import { ACCOUNT_HEADER } from "./account-header";
import {
  type AccountStore,
  SESSION_TTL_MS,
  type TAccount,
  type TSessionKind,
} from "./account-store";
import type {
  TApiError,
  TAppSessionResponse,
  TLinkCheckResponse,
  TLinkConfirmRequest,
  TLinkLoginRequest,
  TLinkRequest,
  TLoginRequest,
  TLogoutResponse,
  TMeResponse,
  TMessagesResponse,
  TRegisterRequest,
} from "./api-types";
import type { TChatReader } from "./chat-reader";
import { buildFactGraph } from "./fact-graph";
import type { TInternalApi, TInternalApiResult } from "./internal-api";

export const SESSION_COOKIE = "bellaclaw_dashboard_session";
// "app" on a request that starts a session asks for a bearer token instead of the cookie
export const CLIENT_HEADER = "X-BellaClaw-Client";

const SESSION_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
  maxAge: SESSION_TTL_MS / 1000,
};
const MESSAGES_PAGE_SIZE = 50;
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
// wrong activation codes, counted for every registration together: an anonymous registration has
// nothing else to count by
const MAX_ACTIVATION_FAILURES = 5;
const ACTIVATION_LOCK_MS = 15 * 60 * 1000;
const INVALID_LINK = "The link is invalid, expired or already used";
const LINKED_ELSEWHERE = "This chat is linked to another account";
const WRONG_CREDENTIALS = "Wrong username or password";
const OTHER_ACCOUNT = "You are signed in to another account now";

const SLinkBody: z.ZodType<TLinkRequest> = z.object({ token: z.string() });
const SLinkConfirmBody: z.ZodType<TLinkConfirmRequest> = z.object({ token: z.string() });
const SNewPassword = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(256, "Password must be at most 256 characters");
const SRegisterBody: z.ZodType<TRegisterRequest> = z
  .object({
    token: z.string().optional(),
    activationCode: z.string().optional(),
    username: z
      .string()
      .regex(
        /^[A-Za-z0-9_.-]{3,32}$/,
        "Username must be 3 to 32 characters: letters, digits, _ . -",
      ),
    password: SNewPassword,
  })
  .refine(
    (body) => (body.token === undefined) !== (body.activationCode === undefined),
    "Send either a link token or an activation code",
  );
const SLinkLoginBody: z.ZodType<TLinkLoginRequest> = z.object({
  token: z.string(),
  password: SNewPassword.optional(),
});
// NOTE: only bounds here. Anything more precise would answer differently for names that cannot
// exist.
const SLoginBody: z.ZodType<TLoginRequest> = z.object({
  username: z.string().min(1).max(32),
  password: z.string().min(1).max(256),
  token: z.string().optional(),
});
const SMessageId = z.coerce.number().int().positive();

export type TDashboardConfig = {
  // the origin of BELLACLAW_DASHBOARD_PUBLIC_URL
  publicOrigin: string;
  // BELLACLAW_DASHBOARD_SECRET, trimmed
  secret: string;
};

export type TDashboardDependencies = {
  config: TDashboardConfig;
  store: AccountStore;
  reader: TChatReader;
  internalApi: TInternalApi;
  // answers a path outside /api with the client: its page, or one of its assets
  serveClient: (request: Request) => Promise<Response>;
};

type TEnv = { Variables: { account: TAccount } };

const logger = createLogger("DASHBOARD");

async function parseBody<T>(request: Request, schema: z.ZodType<T>) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    // no JSON fails the schema
  }

  return schema.safeParse(body);
}

function invalidBody(error: z.ZodError): TApiError {
  return { error: error.issues[0]?.message ?? "Invalid request" };
}

// the token of an Authorization header of the Bearer scheme
function bearerToken(c: Context): TOption<string> {
  return /^Bearer (\S+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
}

// NOTE: a request of the app carries a bearer token or the client header, and never uses the
// cookie. A browser sends neither header across sites without a preflight, which the dashboard
// does not answer, so app requests are exempt from the Origin rule.
function isAppRequest(c: Context): boolean {
  return bearerToken(c) !== undefined || c.req.header(CLIENT_HEADER) === "app";
}

export function createApp({
  config,
  store,
  reader,
  internalApi,
  serveClient,
}: TDashboardDependencies) {
  const app = new Hono<TEnv>();
  // verified for an unknown username, so the answer takes as long as for a wrong password
  const dummyPasswordHash = Bun.password.hash(randomBytes(16).toString("hex"));
  // login attempts since the last success, by lowercase username
  const loginAttempts = new Map<string, { count: number; lastAt: number }>();
  // registrations with a wrong activation code, counted until ACTIVATION_LOCK_MS pass with no
  // attempt
  const activationFailures = { count: 0, lastAt: 0 };

  // now: epoch ms. Consumes nothing.
  function findUnusedLink(token: string, now: number): TOption<TDashboardLinkToken> {
    const link = verifyDashboardLinkToken(config.secret, token, now);

    if (link === undefined || store.isLinkUsed(link.nonce)) {
      return undefined;
    }

    return link;
  }

  // NOTE: the account is read first, so a failed read starts no session. verifiedHash: the password
  // hash a login verified; when the stored hash is another one by then, the login is refused. An
  // app request gets a bearer token in the answer, the web client the cookie.
  async function startSession(
    c: Context,
    account: TAccount,
    verifiedHash: TOption<string>,
  ): Promise<Response> {
    const result = await internalApi.getAccount(account.publicId);

    if ("error" in result) {
      return c.json<TApiError>({ error: result.error }, result.status);
    }

    // NOTE: no await between this check and the session, so a password reset meanwhile is seen
    if (
      verifiedHash !== undefined &&
      store.findCredentials(account.username)?.passwordHash !== verifiedHash
    ) {
      return c.json<TApiError>({ error: WRONG_CREDENTIALS }, 401);
    }

    if (isAppRequest(c)) {
      return c.json<TAppSessionResponse>({
        username: account.username,
        chats: result.data.links,
        token: store.createAppSession(account.id, Date.now()),
      });
    }

    setCookie(
      c,
      SESSION_COOKIE,
      store.createSession(account.id, Date.now()),
      SESSION_COOKIE_OPTIONS,
    );

    return c.json<TMeResponse>({ username: account.username, chats: result.data.links });
  }

  // the account's name and linked chats, which the assistant knows
  async function describeAccount(c: Context, account: TAccount): Promise<Response> {
    const result = await internalApi.getAccount(account.publicId);

    if ("error" in result) {
      return c.json<TApiError>({ error: result.error }, result.status);
    }

    return c.json<TMeResponse>({ username: account.username, chats: result.data.links });
  }

  // The public id of the account the chat is linked to, or undefined for an unlinked chat. A row of
  // account_chats the import still holds counts as its account's link.
  // NOTE: the row is read before the assistant: the import removes it only once the assistant's
  // link is active, so no moment answers neither.
  async function findLinkedAccountId(chatId: string): Promise<TInternalApiResult<TOption<string>>> {
    const row = store.findImportRow(chatId);

    if (row !== undefined) {
      return { data: row.publicId };
    }

    const chatLink = await internalApi.getChatLink(chatId);

    if ("error" in chatLink) {
      return chatLink;
    }

    return { data: chatLink.data.link?.accountId };
  }

  // the answer to a failed link request; an address of another account says so
  function linkFailed(c: Context, result: Exclude<TInternalApiResult<unknown>, { data: unknown }>) {
    if (result.code === ADDRESS_LINKED_ELSEWHERE) {
      return c.json<TApiError>({ error: LINKED_ELSEWHERE }, 409);
    }

    return c.json<TApiError>({ error: result.error }, result.status);
  }

  // NOTE: an app request is served by its bearer token alone, and names no account: the account
  // header guards pages of the browser, which share one cookie
  const requireSession = createMiddleware<TEnv>(async (c, next) => {
    if (isAppRequest(c)) {
      const bearer = bearerToken(c);
      let appAccount: TOption<TAccount>;

      if (bearer !== undefined) {
        appAccount = store.findAppSession(bearer);
      }

      if (appAccount === undefined) {
        return c.json<TApiError>({ error: "Unauthorized" }, 401);
      }

      c.set("account", appAccount);
      await next();
      return;
    }

    const token = getCookie(c, SESSION_COOKIE);
    let account: TOption<TAccount>;

    if (token !== undefined) {
      account = store.touchSession(token, Date.now());
    }

    if (token === undefined || account === undefined) {
      return c.json<TApiError>({ error: "Unauthorized" }, 401);
    }

    // a page names the account it shows; a session of another account is refused for it
    const shownAccount = c.req.header(ACCOUNT_HEADER);

    if (shownAccount !== undefined && shownAccount !== account.username) {
      return c.json<TApiError>({ error: OTHER_ACCOUNT, code: "otherAccount" }, 409);
    }

    // the session slides: the cookie lives as long as its row
    setCookie(c, SESSION_COOKIE, token, SESSION_COOKIE_OPTIONS);
    c.set("account", account);
    await next();
  });

  app.use(async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    // the link token sits in the URL of the page
    c.header("Referrer-Policy", "no-referrer");
  });

  app.use(async (c, next) => {
    const reads = c.req.method === "GET" || c.req.method === "HEAD";

    if (!reads && !isAppRequest(c) && c.req.header("Origin") !== config.publicOrigin) {
      return c.json<TApiError>({ error: "Forbidden" }, 403);
    }

    await next();
  });

  app.onError((error, c) => {
    logger.error(`${c.req.method} request failed: ${error}`);

    return c.json<TApiError>({ error: "Internal error" }, 500);
  });

  app.post("/api/link/check", async (c) => {
    const body = await parseBody(c.req.raw, SLinkBody);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    const link = findUnusedLink(body.data.token, Date.now());

    if (link === undefined) {
      return c.json<TLinkCheckResponse>({ valid: false });
    }

    const linked = await findLinkedAccountId(link.chatId);

    if ("error" in linked) {
      return c.json<TApiError>({ error: linked.error }, linked.status);
    }

    const response: TLinkCheckResponse = { valid: true, chatKey: link.chatId };

    if (linked.data !== undefined) {
      response.username = store.findByPublicId(linked.data)?.username;
    }

    return c.json(response);
  });

  // NOTE: a link of a chat linked already logs into its account, once, without the password. Every
  // assistant read comes first; the use of the link, the new password and the session then commit
  // together, so a failed read changes nothing.
  app.post("/api/link/login", async (c) => {
    const body = await parseBody(c.req.raw, SLinkLoginBody);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    const link = findUnusedLink(body.data.token, Date.now());

    if (link === undefined) {
      return c.json<TApiError>({ error: INVALID_LINK }, 400);
    }

    const linked = await findLinkedAccountId(link.chatId);

    if ("error" in linked) {
      return c.json<TApiError>({ error: linked.error }, linked.status);
    }

    let account: TOption<TAccount>;

    if (linked.data !== undefined) {
      account = store.findByPublicId(linked.data);
    }

    if (account === undefined) {
      return c.json<TApiError>({ error: "This chat is not linked to an account" }, 400);
    }

    const described = await internalApi.getAccount(account.publicId);

    if ("error" in described) {
      return c.json<TApiError>({ error: described.error }, described.status);
    }

    let passwordHash: TOption<string>;

    if (body.data.password !== undefined) {
      passwordHash = await Bun.password.hash(body.data.password);
    }

    let kind: TSessionKind = "cookie";

    if (isAppRequest(c)) {
      kind = "bearer";
    }

    const session = store.redeemLoginLink(account.id, link, passwordHash, kind, Date.now());

    if (session === undefined) {
      return c.json<TApiError>({ error: INVALID_LINK }, 400);
    }

    if (kind === "bearer") {
      return c.json<TAppSessionResponse>({
        username: account.username,
        chats: described.data.links,
        token: session,
      });
    }

    setCookie(c, SESSION_COOKIE, session, SESSION_COOKIE_OPTIONS);

    return c.json<TMeResponse>({ username: account.username, chats: described.data.links });
  });

  // NOTE: a registration proves itself with a link of an unlinked chat, or with the activation
  // code, which only the assistant knows; an account of a code has no chat. The account and the
  // use of its link commit first and the link request follows, so a link never names an account
  // that does not exist. A failed request leaves the account, which logs in with its password.
  app.post("/api/register", async (c) => {
    const body = await parseBody(c.req.raw, SRegisterBody);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    const { token, activationCode } = body.data;
    let link: TOption<TDashboardLinkToken>;

    // nothing is hashed or created without a right code or a usable link of an unlinked chat
    if (activationCode !== undefined) {
      const now = Date.now();

      if (now - activationFailures.lastAt >= ACTIVATION_LOCK_MS) {
        activationFailures.count = 0;
      }

      if (activationFailures.count >= MAX_ACTIVATION_FAILURES) {
        return c.json<TApiError>(
          { error: "Too many wrong activation codes. Try again in 15 minutes" },
          429,
        );
      }

      // NOTE: counted before the check, so parallel guesses cannot outrun the limit
      activationFailures.count += 1;
      activationFailures.lastAt = now;
      const check = await internalApi.checkActivationCode(activationCode);

      // only a wrong code stays counted
      if ("error" in check || check.data.result !== "invalid") {
        activationFailures.count -= 1;
      }

      if ("error" in check) {
        return c.json<TApiError>({ error: check.error }, check.status);
      }

      if (check.data.result === "unset") {
        return c.json<TApiError>({ error: "Registration with an activation code is closed" }, 403);
      }

      if (check.data.result === "invalid") {
        return c.json<TApiError>({ error: "Wrong activation code" }, 400);
      }
    } else {
      if (token !== undefined) {
        link = findUnusedLink(token, Date.now());
      }

      if (link === undefined) {
        return c.json<TApiError>({ error: INVALID_LINK }, 400);
      }

      const linked = await findLinkedAccountId(link.chatId);

      if ("error" in linked) {
        return c.json<TApiError>({ error: linked.error }, linked.status);
      }

      if (linked.data !== undefined) {
        return c.json<TApiError>({ error: LINKED_ELSEWHERE }, 409);
      }
    }

    const registration = store.createAccount(
      body.data.username,
      await Bun.password.hash(body.data.password),
      link,
      Date.now(),
    );

    if ("failure" in registration) {
      if (registration.failure === "usernameTaken") {
        return c.json<TApiError>({ error: "This username is taken" }, 409);
      }

      return c.json<TApiError>({ error: INVALID_LINK }, 400);
    }

    if (link !== undefined) {
      const requested = await internalApi.requestLink(registration.account.publicId, link.chatId);

      if ("error" in requested) {
        return linkFailed(c, requested);
      }
    }

    return startSession(c, registration.account, undefined);
  });

  app.post("/api/login", async (c) => {
    const body = await parseBody(c.req.raw, SLoginBody);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    const now = Date.now();
    let link: TOption<TDashboardLinkToken>;

    if (body.data.token !== undefined) {
      link = findUnusedLink(body.data.token, now);

      if (link === undefined) {
        return c.json<TApiError>({ error: INVALID_LINK }, 400);
      }
    }

    for (const [name, attempts] of loginAttempts) {
      if (now - attempts.lastAt >= LOGIN_LOCK_MS) {
        loginAttempts.delete(name);
      }
    }

    const name = body.data.username.toLowerCase();
    const count = loginAttempts.get(name)?.count ?? 0;

    if (count >= MAX_LOGIN_FAILURES) {
      return c.json<TApiError>({ error: "Too many failed logins. Try again in 15 minutes" }, 429);
    }

    // NOTE: counted before the password check, so parallel guesses cannot outrun the lock
    loginAttempts.set(name, { count: count + 1, lastAt: now });

    const credentials = store.findCredentials(body.data.username);
    let passwordHash = await dummyPasswordHash;

    if (credentials !== undefined) {
      passwordHash = credentials.passwordHash;
    }

    const passwordMatches = await Bun.password.verify(body.data.password, passwordHash);

    // the same answer for an unknown username and a wrong password
    if (credentials === undefined || !passwordMatches) {
      return c.json<TApiError>({ error: WRONG_CREDENTIALS }, 401);
    }

    loginAttempts.delete(name);
    const account: TAccount = {
      id: credentials.id,
      publicId: credentials.publicId,
      username: credentials.username,
    };

    if (link !== undefined) {
      // a link of another account's chat is refused unused, so it still logs into that account
      const linked = await findLinkedAccountId(link.chatId);

      if ("error" in linked) {
        return c.json<TApiError>({ error: linked.error }, linked.status);
      }

      if (linked.data !== undefined && linked.data !== account.publicId) {
        return c.json<TApiError>({ error: LINKED_ELSEWHERE }, 409);
      }

      // NOTE: no await between this check and the use of the link
      if (store.findCredentials(account.username)?.passwordHash !== credentials.passwordHash) {
        return c.json<TApiError>({ error: WRONG_CREDENTIALS }, 401);
      }

      if (!store.consumeLink(link, Date.now())) {
        return c.json<TApiError>({ error: INVALID_LINK }, 400);
      }

      const requested = await internalApi.requestLink(account.publicId, link.chatId);

      if ("error" in requested) {
        return linkFailed(c, requested);
      }
    }

    return startSession(c, account, credentials.passwordHash);
  });

  // NOTE: the confirmation names its account in the account header, so another signed-in account
  // is refused before the link is used. So is a link of another account's chat, which still logs
  // into it.
  app.post("/api/link", requireSession, async (c) => {
    const body = await parseBody(c.req.raw, SLinkConfirmBody);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    const link = findUnusedLink(body.data.token, Date.now());

    if (link === undefined) {
      return c.json<TApiError>({ error: INVALID_LINK }, 400);
    }

    const linked = await findLinkedAccountId(link.chatId);

    if ("error" in linked) {
      return c.json<TApiError>({ error: linked.error }, linked.status);
    }

    if (linked.data !== undefined && linked.data !== c.var.account.publicId) {
      return c.json<TApiError>({ error: LINKED_ELSEWHERE }, 409);
    }

    if (!store.consumeLink(link, Date.now())) {
      return c.json<TApiError>({ error: INVALID_LINK }, 400);
    }

    const requested = await internalApi.requestLink(c.var.account.publicId, link.chatId);

    if ("error" in requested) {
      return linkFailed(c, requested);
    }

    return describeAccount(c, c.var.account);
  });

  app.post("/api/logout", (c) => {
    if (isAppRequest(c)) {
      const bearer = bearerToken(c);

      if (bearer !== undefined) {
        store.deleteAppSession(bearer);
      }

      return c.json<TLogoutResponse>({ ok: true });
    }

    const token = getCookie(c, SESSION_COOKIE);

    if (token !== undefined) {
      // a page that shows another account leaves this account's session alone
      const account = store.touchSession(token, Date.now());
      const shownAccount = c.req.header(ACCOUNT_HEADER);

      if (
        account !== undefined &&
        shownAccount !== undefined &&
        shownAccount !== account.username
      ) {
        return c.json<TApiError>({ error: OTHER_ACCOUNT, code: "otherAccount" }, 409);
      }

      store.deleteSession(token);
    }

    deleteCookie(c, SESSION_COOKIE, SESSION_COOKIE_OPTIONS);

    return c.json<TLogoutResponse>({ ok: true });
  });

  app.get("/api/me", requireSession, (c) => describeAccount(c, c.var.account));

  // NOTE: every account route reaches only the signed-in account's data, by the keys the
  // assistant names for its public id
  app.get("/api/messages", requireSession, async (c) => {
    const before = SMessageId.optional().safeParse(c.req.query("before"));

    if (!before.success) {
      return c.json<TApiError>({ error: "Invalid before" }, 400);
    }

    const account = await internalApi.getAccount(c.var.account.publicId);

    if ("error" in account) {
      return c.json<TApiError>({ error: account.error }, account.status);
    }

    // one row more than a page tells whether another page follows
    const messages = await reader.listMessages(
      account.data.conversationKey,
      before.data,
      MESSAGES_PAGE_SIZE + 1,
    );
    const response: TMessagesResponse = { messages: messages.slice(0, MESSAGES_PAGE_SIZE) };

    if (messages.length > MESSAGES_PAGE_SIZE) {
      response.nextBefore = response.messages.at(-1)?.id;
    }

    return c.json(response);
  });

  app.delete("/api/messages/:messageId", requireSession, async (c) => {
    const messageId = SMessageId.safeParse(c.req.param("messageId"));

    if (!messageId.success) {
      return c.json<TApiError>({ error: "Invalid message id" }, 400);
    }

    const result = await internalApi.deleteMessage(c.var.account.publicId, messageId.data);

    if ("error" in result) {
      return c.json<TApiError>({ error: result.error }, result.status);
    }

    return c.json(result.data);
  });

  app.get("/api/facts", requireSession, async (c) => {
    const account = await internalApi.getAccount(c.var.account.publicId);

    if ("error" in account) {
      return c.json<TApiError>({ error: account.error }, account.status);
    }

    return c.json(buildFactGraph(await reader.listFacts(account.data.ownerKey)));
  });

  app.get("/api/model", requireSession, async (c) => {
    const result = await internalApi.getModel(c.var.account.publicId);

    if ("error" in result) {
      return c.json<TApiError>({ error: result.error }, result.status);
    }

    return c.json(result.data);
  });

  app.put("/api/model", requireSession, async (c) => {
    const body = await parseBody(c.req.raw, SDashboardModelUpdate);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    const result = await internalApi.updateModel(c.var.account.publicId, body.data);

    if ("error" in result) {
      return c.json<TApiError>({ error: result.error }, result.status);
    }

    return c.json(result.data);
  });

  app.all("/api/*", (c) => c.json<TApiError>({ error: "Not found" }, 404));

  // every other path is the single-page client
  app.get("*", (c) => serveClient(c.req.raw));

  return app;
}
