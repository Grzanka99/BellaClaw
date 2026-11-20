import { randomBytes } from "node:crypto";
import type { THistoryCursor, TOwnedConversation } from "@bellaclaw/database";
import {
  ADDRESS_LINKED_ELSEWHERE,
  createLogger,
  isP256PublicKey,
  SGatewayAppMessage,
  SGatewayDeviceRegistration,
  SGatewayModelUpdate,
  SGatewayPersonalityUpdate,
  type TGatewayLinkToken,
  type TOption,
  verifyGatewayLinkToken,
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
  TAppStreamEvent,
  TConversationDeletedResponse,
  TConversationsResponse,
  TDeviceResponse,
  THistoryResponse,
  TLinkCheckResponse,
  TLinkConfirmRequest,
  TLinkLoginRequest,
  TLinkRequest,
  TLoginRequest,
  TLogoutResponse,
  TMediaUploadedResponse,
  TMeResponse,
  TMessagesResponse,
  TRegisterRequest,
} from "./api-types";
import type { TChatReader } from "./chat-reader";
import { buildFactGraph } from "./fact-graph";
import type { TInternalApi, TInternalApiResult } from "./internal-api";
import type { TLiveStream } from "./live-stream";

const SESSION_COOKIE = "bellaclaw_dashboard_session";
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
// every body but an image upload is a small JSON object
const MAX_JSON_BODY_BYTES = 65_536;
const MEDIA_UPLOAD_PATH = /^\/api\/conversations\/[^/]+\/media$/;
// NOTE: well under the 255 s idle timeout, and the usual idle limits of a proxy
const STREAM_KEEP_ALIVE_MS = 25_000;
const MAX_ACCOUNT_STREAMS = 4;
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
const SHistoryQuery = z
  .object({ after: SMessageId.optional(), before: SMessageId.optional() })
  .refine(
    (query) => query.after === undefined || query.before === undefined,
    "Send after or before, not both",
  );

export type TGatewayConfig = {
  // the origin of BELLACLAW_GATEWAY_PUBLIC_URL
  publicOrigin: string;
  // BELLACLAW_GATEWAY_SECRET, trimmed
  secret: string;
};

export type TGatewayDependencies = {
  config: TGatewayConfig;
  store: AccountStore;
  reader: TChatReader;
  internalApi: TInternalApi;
  liveStream: TLiveStream;
  // answers a path outside /api with the client: its page, or one of its assets
  serveClient: (request: Request) => Promise<Response>;
};

type TEnv = { Variables: { account: TAccount } };

const logger = createLogger("GATEWAY");

async function parseBody<T>(request: Request, schema: z.ZodType<T>) {
  let body: unknown;

  try {
    const chunks: Uint8Array[] = [];
    let size = 0;

    // NOTE: read to the JSON limit whatever length the request declares: a chunked body declares
    // none
    if (request.body !== null) {
      const reader = request.body.getReader();
      let part = await reader.read();

      while (!part.done) {
        size += part.value.byteLength;

        if (size > MAX_JSON_BODY_BYTES) {
          await reader.cancel();
          throw new Error("Request body too large");
        }

        chunks.push(part.value);
        part = await reader.read();
      }
    }

    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
// cookie. A browser sends neither header across sites without a preflight, which the gateway
// does not answer, so app requests are exempt from the Origin rule.
function isAppRequest(c: Context): boolean {
  return bearerToken(c) !== undefined || c.req.header(CLIENT_HEADER) === "app";
}

// the answer to a failed assistant request, passed on
function apiFailed(c: Context, result: Exclude<TInternalApiResult<unknown>, { data: unknown }>) {
  return c.json<TApiError>({ error: result.error }, result.status);
}

// the answer to a failed link request; an address of another account says so
function linkFailed(c: Context, result: Exclude<TInternalApiResult<unknown>, { data: unknown }>) {
  if (result.code === ADDRESS_LINKED_ELSEWHERE) {
    return c.json<TApiError>({ error: LINKED_ELSEWHERE }, 409);
  }

  return c.json<TApiError>({ error: result.error }, result.status);
}

// the assistant's answer, passed on
function respond<T>(c: Context, result: TInternalApiResult<T>) {
  if ("error" in result) {
    return apiFailed(c, result);
  } else {
    return c.json(result.data);
  }
}

export function createApp({
  config,
  store,
  reader,
  internalApi,
  liveStream,
  serveClient,
}: TGatewayDependencies) {
  const app = new Hono<TEnv>();
  // verified for an unknown username, so the answer takes as long as for a wrong password
  const dummyPasswordHash = Bun.password.hash(randomBytes(16).toString("hex"));
  // login attempts since the last success, by lowercase username
  const loginAttempts = new Map<string, { count: number; lastAt: number }>();
  // what ends each open app stream, by account public id, oldest first
  const streamEnds = new Map<string, (() => void)[]>();
  // registrations with a wrong activation code, counted until ACTIVATION_LOCK_MS pass with no
  // attempt
  const activationFailures = { count: 0, lastAt: 0 };

  // now: epoch ms. Consumes nothing.
  function findUnusedLink(token: string, now: number): TOption<TGatewayLinkToken> {
    const link = verifyGatewayLinkToken(config.secret, token, now);

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
      return apiFailed(c, result);
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
      return apiFailed(c, result);
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

  // The token's link when it is unused, with the public id of the account its chat is linked to;
  // else the answer.
  async function resolveLink(
    c: Context,
    token: TOption<string>,
  ): Promise<Response | { link: TGatewayLinkToken; linkedAccountId: TOption<string> }> {
    let link: TOption<TGatewayLinkToken>;

    if (token !== undefined) {
      link = findUnusedLink(token, Date.now());
    }

    if (link === undefined) {
      return c.json<TApiError>({ error: INVALID_LINK }, 400);
    }

    const linked = await findLinkedAccountId(link.chatId);

    if ("error" in linked) {
      return apiFailed(c, linked);
    }

    return { link, linkedAccountId: linked.data };
  }

  // Uses the link for the account and asks the assistant to link its chat; the answer when that
  // fails, else undefined. A link of another account's chat is refused unused. verifiedHash: the
  // password hash a login verified; when the stored hash is another one by then, the link is
  // refused unused.
  // NOTE: no await between the checks and the use of the link
  async function linkChat(
    c: Context,
    link: TGatewayLinkToken,
    linkedAccountId: TOption<string>,
    account: TAccount,
    verifiedHash: TOption<string>,
  ): Promise<TOption<Response>> {
    if (linkedAccountId !== undefined && linkedAccountId !== account.publicId) {
      return c.json<TApiError>({ error: LINKED_ELSEWHERE }, 409);
    }

    if (
      verifiedHash !== undefined &&
      store.findCredentials(account.username)?.passwordHash !== verifiedHash
    ) {
      return c.json<TApiError>({ error: WRONG_CREDENTIALS }, 401);
    }

    if (!store.consumeLink(link, Date.now())) {
      return c.json<TApiError>({ error: INVALID_LINK }, 400);
    }

    const requested = await internalApi.requestLink(account.publicId, link.chatId);

    if ("error" in requested) {
      return linkFailed(c, requested);
    }

    return undefined;
  }

  // The conversation's revisions when the signed-in account owns it, by the keys the assistant
  // names for the account; else the answer, 404 for a conversation of another account or one that
  // does not exist, alike
  async function findConversation(
    c: Context<TEnv>,
    conversationKey: string,
  ): Promise<Response | TOwnedConversation> {
    const account = await internalApi.getAccount(c.var.account.publicId);

    if ("error" in account) {
      return apiFailed(c, account);
    }

    const owned = await reader.findConversation(conversationKey, account.data);

    if (owned === undefined) {
      return c.json<TApiError>({ error: "Not found" }, 404);
    }

    return owned;
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

  // NOTE: the server takes a body as large as an image, for the upload
  app.use(async (c, next) => {
    const upload = c.req.method === "POST" && MEDIA_UPLOAD_PATH.test(c.req.path);

    if (!upload && Number(c.req.header("Content-Length")) > MAX_JSON_BODY_BYTES) {
      return c.json<TApiError>({ error: "Request body too large" }, 413);
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
      return apiFailed(c, linked);
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

    const resolved = await resolveLink(c, body.data.token);

    if (resolved instanceof Response) {
      return resolved;
    }

    const { link, linkedAccountId } = resolved;
    let account: TOption<TAccount>;

    if (linkedAccountId !== undefined) {
      account = store.findByPublicId(linkedAccountId);
    }

    if (account === undefined) {
      return c.json<TApiError>({ error: "This chat is not linked to an account" }, 400);
    }

    const described = await internalApi.getAccount(account.publicId);

    if ("error" in described) {
      return apiFailed(c, described);
    }

    let passwordHash: TOption<string>;

    if (body.data.password !== undefined) {
      passwordHash = await Bun.password.hash(body.data.password);
    }

    let kind: TSessionKind = "cookie";

    if (isAppRequest(c)) {
      kind = "bearer";
    }

    // a new password ends every app session, so the account's devices go first: when the
    // assistant cannot remove them nothing changes, and the reset can be tried again
    if (passwordHash !== undefined) {
      const unregistered = await internalApi.unregisterAccountDevices(account.publicId);

      if ("error" in unregistered) {
        return apiFailed(c, unregistered);
      }
    }

    const session = store.redeemLoginLink(account.id, link, passwordHash, kind, Date.now());

    if (session === undefined) {
      return c.json<TApiError>({ error: INVALID_LINK }, 400);
    }

    // NOTE: a device that registered between the removal above and the end of its session goes
    // now: an ended session registers no more
    if (passwordHash !== undefined) {
      const swept = await internalApi.unregisterAccountDevices(account.publicId);

      if ("error" in swept) {
        logger.error(`Devices of ended sessions not removed: ${swept.error}`);
      }
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
    let link: TOption<TGatewayLinkToken>;

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
        return apiFailed(c, check);
      }

      if (check.data.result === "unset") {
        return c.json<TApiError>({ error: "Registration with an activation code is closed" }, 403);
      }

      if (check.data.result === "invalid") {
        return c.json<TApiError>({ error: "Wrong activation code" }, 400);
      }
    } else {
      const resolved = await resolveLink(c, token);

      if (resolved instanceof Response) {
        return resolved;
      }

      if (resolved.linkedAccountId !== undefined) {
        return c.json<TApiError>({ error: LINKED_ELSEWHERE }, 409);
      }

      link = resolved.link;
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
    let link: TOption<TGatewayLinkToken>;

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
        return apiFailed(c, linked);
      }

      const failed = await linkChat(c, link, linked.data, account, credentials.passwordHash);

      if (failed !== undefined) {
        return failed;
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

    const resolved = await resolveLink(c, body.data.token);

    if (resolved instanceof Response) {
      return resolved;
    }

    const failed = await linkChat(
      c,
      resolved.link,
      resolved.linkedAccountId,
      c.var.account,
      undefined,
    );

    if (failed !== undefined) {
      return failed;
    }

    return describeAccount(c, c.var.account);
  });

  // NOTE: an app session's device is unregistered first, so the main channel is back on the linked
  // chat once logout answers. When the assistant cannot do it the session stays, and the app can
  // log out again
  app.post("/api/logout", async (c) => {
    if (isAppRequest(c)) {
      const bearer = bearerToken(c);
      let deviceId: TOption<string>;
      let account: TOption<TAccount>;

      if (bearer !== undefined) {
        deviceId = store.findAppSessionDevice(bearer);
        account = store.findAppSession(bearer);
      }

      if (deviceId !== undefined && account !== undefined) {
        const unregistered = await internalApi.unregisterDevice(account.publicId, deviceId);

        // 404: the assistant holds no device of this session
        if ("error" in unregistered && unregistered.status !== 404) {
          return apiFailed(c, unregistered);
        }
      }

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

  // NOTE: the device of the app session, by the id the session was made with: registering again
  // replaces its token and keys, and logout unregisters it. The web client has no device
  app.put("/api/device", requireSession, async (c) => {
    const bearer = bearerToken(c);

    if (bearer === undefined) {
      return c.json<TApiError>({ error: "Only the app registers a device" }, 403);
    }

    const deviceId = store.findAppSessionDevice(bearer);

    if (deviceId === undefined) {
      return c.json<TApiError>({ error: "Unauthorized" }, 401);
    }

    const body = await parseBody(c.req.raw, SGatewayDeviceRegistration);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    if (!(await isP256PublicKey(body.data.publicKey))) {
      return c.json<TApiError>({ error: "Expected a P-256 public key" }, 400);
    }

    const result = await internalApi.registerDevice(c.var.account.publicId, deviceId, body.data);

    if ("error" in result) {
      return apiFailed(c, result);
    }

    // a logout or a new password that ended the session meanwhile may have run before this
    // register reached the assistant
    if (store.findAppSession(bearer) === undefined) {
      const removed = await internalApi.unregisterDevice(c.var.account.publicId, deviceId);

      if ("error" in removed) {
        logger.error(`Device of an ended session not removed: ${removed.error}`);
      }

      return c.json<TApiError>({ error: "Unauthorized" }, 401);
    }

    return c.json<TDeviceResponse>({ ok: true });
  });

  // 404 when the session's device is not registered
  app.delete("/api/device", requireSession, async (c) => {
    const bearer = bearerToken(c);

    if (bearer === undefined) {
      return c.json<TApiError>({ error: "Only the app registers a device" }, 403);
    }

    const deviceId = store.findAppSessionDevice(bearer);

    if (deviceId === undefined) {
      return c.json<TApiError>({ error: "Unauthorized" }, 401);
    }

    const result = await internalApi.unregisterDevice(c.var.account.publicId, deviceId);

    if ("error" in result) {
      return apiFailed(c, result);
    }

    return c.json<TDeviceResponse>({ ok: true });
  });

  // NOTE: every account route reaches only the signed-in account's data, by the keys the
  // assistant names for its public id
  app.get("/api/messages", requireSession, async (c) => {
    const before = SMessageId.optional().safeParse(c.req.query("before"));

    if (!before.success) {
      return c.json<TApiError>({ error: "Invalid before" }, 400);
    }

    const account = await internalApi.getAccount(c.var.account.publicId);

    if ("error" in account) {
      return apiFailed(c, account);
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

    return respond(c, await internalApi.deleteMessage(c.var.account.publicId, messageId.data));
  });

  app.get("/api/facts", requireSession, async (c) => {
    const account = await internalApi.getAccount(c.var.account.publicId);

    if ("error" in account) {
      return apiFailed(c, account);
    }

    return c.json(buildFactGraph(await reader.listFacts(account.data.ownerKey)));
  });

  // NOTE: the conversations of the app. A conversation key from the client is used only after the
  // registry's rule says the signed-in account owns it; any other key is answered like one that
  // does not exist. The assistant checks a send again
  app.get("/api/conversations", requireSession, async (c) => {
    const account = await internalApi.getAccount(c.var.account.publicId);

    if ("error" in account) {
      return apiFailed(c, account);
    }

    return c.json<TConversationsResponse>({
      conversations: await reader.listConversations(account.data),
    });
  });

  // a new plain chat of the signed-in account; the assistant builds its key
  app.post("/api/conversations", requireSession, async (c) =>
    respond(c, await internalApi.createConversation(c.var.account.publicId)),
  );

  // NOTE: only a plain chat is deleted; the assistant answers 404 for the Bella conversation, as
  // for a conversation of another account
  app.delete("/api/conversations/:conversationKey", requireSession, async (c) => {
    const conversationKey = c.req.param("conversationKey");
    const owned = await findConversation(c, conversationKey);

    if (owned instanceof Response) {
      return owned;
    }

    const result = await internalApi.deleteConversation(c.var.account.publicId, conversationKey);

    if ("error" in result) {
      return apiFailed(c, result);
    }

    return c.json<TConversationDeletedResponse>(result.data);
  });

  app.get("/api/conversations/:conversationKey/messages", requireSession, async (c) => {
    const query = SHistoryQuery.safeParse({
      after: c.req.query("after"),
      before: c.req.query("before"),
    });

    if (!query.success) {
      return c.json(invalidBody(query.error), 400);
    }

    const conversationKey = c.req.param("conversationKey");
    // NOTE: the revisions are read before the rows, so a change between the two reads leaves the
    // client behind the rows it got, never ahead of them
    const owned = await findConversation(c, conversationKey);

    if (owned instanceof Response) {
      return owned;
    }

    let cursor: TOption<THistoryCursor>;

    if (query.data.after !== undefined) {
      cursor = { direction: "after", id: query.data.after };
    } else if (query.data.before !== undefined) {
      cursor = { direction: "before", id: query.data.before };
    }

    // one row more than a page tells whether another page follows
    const messages = await reader.listHistory(conversationKey, cursor, MESSAGES_PAGE_SIZE + 1);
    const response: THistoryResponse = { ...owned, messages };

    if (messages.length > MESSAGES_PAGE_SIZE) {
      if (cursor?.direction === "after") {
        response.messages = messages.slice(0, MESSAGES_PAGE_SIZE);
        response.nextAfter = response.messages.at(-1)?.id;
      } else {
        response.messages = messages.slice(1);
        response.nextBefore = response.messages[0]?.id;
      }
    }

    return c.json(response);
  });

  app.post("/api/conversations/:conversationKey/messages", requireSession, async (c) => {
    const conversationKey = c.req.param("conversationKey");
    const owned = await findConversation(c, conversationKey);

    if (owned instanceof Response) {
      return owned;
    }

    const body = await parseBody(c.req.raw, SGatewayAppMessage);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    const result = await internalApi.sendMessage(
      c.var.account.publicId,
      conversationKey,
      body.data,
    );

    if ("error" in result) {
      return apiFailed(c, result);
    }

    return c.json(result.data);
  });

  // NOTE: the image's bytes stream on to the assistant, which checks the declared type
  // (Content-Type), the size and the format before it stores anything. The answer names the image
  // for a send to this conversation: 413 for a file over 5 MB, 415 for another type or content
  app.post("/api/conversations/:conversationKey/media", requireSession, async (c) => {
    const conversationKey = c.req.param("conversationKey");
    const owned = await findConversation(c, conversationKey);

    if (owned instanceof Response) {
      return owned;
    }

    const result = await internalApi.uploadMedia(
      c.var.account.publicId,
      conversationKey,
      c.req.header("Content-Type") ?? "",
      c.req.raw.body,
    );

    if ("error" in result) {
      return apiFailed(c, result);
    }

    return c.json<TMediaUploadedResponse>(result.data);
  });

  // the image's bytes: 404 for a conversation that is not the account's, 410 for an image this
  // conversation does not keep
  app.get("/api/conversations/:conversationKey/media/:mediaId", requireSession, async (c) => {
    const conversationKey = c.req.param("conversationKey");
    const owned = await findConversation(c, conversationKey);

    if (owned instanceof Response) {
      return owned;
    }

    const result = await internalApi.downloadMedia(
      c.var.account.publicId,
      conversationKey,
      c.req.param("mediaId"),
    );

    if ("error" in result) {
      return apiFailed(c, result);
    }

    return new Response(result.data.body, {
      headers: {
        "Content-Type": result.data.headers.get("Content-Type") ?? "",
        "Cache-Control": "no-store",
      },
    });
  });

  // NOTE: the app's live stream: nudges and typing of the signed-in account only, keys and
  // revisions, and to an app session the account's confidential replies. It opens with a check,
  // so the client compares revisions for whatever changed before it connected. It belongs to the
  // session that opened it: before each event and keep-alive the session is read, without sliding
  // it, and a session that ended closes the stream. Closing the connection releases the listener
  // and the timer. HEAD opens no stream. An account holds MAX_ACCOUNT_STREAMS at most: one more
  // ends its oldest, so a phone that reconnects past dead connections is served and no account
  // holds connections without bound
  app.get("/api/stream", requireSession, (c) => {
    const headers = { "Content-Type": "text/event-stream", "Cache-Control": "no-store" };

    if (c.req.method === "HEAD") {
      return new Response(null, { headers });
    }

    let sessionLive: () => boolean;

    if (isAppRequest(c)) {
      const bearer = bearerToken(c) ?? "";
      sessionLive = () => store.findAppSession(bearer) !== undefined;
    } else {
      const token = getCookie(c, SESSION_COOKIE) ?? "";
      sessionLive = () => store.findSession(token, Date.now()) !== undefined;
    }

    const accountId = c.var.account.publicId;
    let ends = streamEnds.get(accountId);

    if (ends === undefined) {
      ends = [];
      streamEnds.set(accountId, ends);
    }

    const accountEnds = ends;
    const encoder = new TextEncoder();
    let release = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const end = () => {
          release();
          controller.close();
        };
        const write = (chunk: string) => {
          if (!sessionLive()) {
            end();
            return;
          }

          controller.enqueue(encoder.encode(chunk));
        };
        const send = ({ type, ...data }: TAppStreamEvent) => {
          write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const close = liveStream.subscribe(accountId, send, isAppRequest(c));
        const keepAlive = setInterval(() => {
          write(": keep-alive\n\n");
        }, STREAM_KEEP_ALIVE_MS);
        release = () => {
          clearInterval(keepAlive);
          close();
          const index = accountEnds.indexOf(end);

          if (index !== -1) {
            accountEnds.splice(index, 1);
          }
        };

        if (accountEnds.length >= MAX_ACCOUNT_STREAMS) {
          accountEnds[0]?.();
        }

        accountEnds.push(end);
        c.req.raw.signal.addEventListener("abort", release, { once: true });
        send({ type: "check" });
      },
      cancel() {
        release();
      },
    });

    return new Response(body, { headers });
  });

  app.get("/api/model", requireSession, async (c) =>
    respond(c, await internalApi.getModel(c.var.account.publicId)),
  );

  app.put("/api/model", requireSession, async (c) => {
    const body = await parseBody(c.req.raw, SGatewayModelUpdate);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    return respond(c, await internalApi.updateModel(c.var.account.publicId, body.data));
  });

  app.get("/api/models", requireSession, async (c) =>
    respond(c, await internalApi.getModels(c.var.account.publicId)),
  );

  app.get("/api/personality", requireSession, async (c) =>
    respond(c, await internalApi.getPersonality(c.var.account.publicId)),
  );

  app.put("/api/personality", requireSession, async (c) => {
    const body = await parseBody(c.req.raw, SGatewayPersonalityUpdate);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    return respond(c, await internalApi.updatePersonality(c.var.account.publicId, body.data));
  });

  app.all("/api/*", (c) => c.json<TApiError>({ error: "Not found" }, 404));

  // every other path is the single-page client
  app.get("*", (c) => serveClient(c.req.raw));

  return app;
}
