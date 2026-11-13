import { randomBytes } from "node:crypto";
import {
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
import { type AccountStore, SESSION_TTL_MS, type TAccount } from "./account-store";
import type {
  TApiError,
  TLinkCheckResponse,
  TLinkRequest,
  TLoginRequest,
  TLogoutResponse,
  TMeResponse,
  TMessagesResponse,
  TRegisterRequest,
} from "./api-types";
import type { TChatReader } from "./chat-reader";
import { buildFactGraph } from "./fact-graph";
import type { TInternalApi } from "./internal-api";

export const SESSION_COOKIE = "bellaclaw_dashboard_session";

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
const INVALID_LINK = "The link is invalid, expired or already used";

const SLinkBody: z.ZodType<TLinkRequest> = z.object({ token: z.string() });
const SRegisterBody: z.ZodType<TRegisterRequest> = z.object({
  token: z.string(),
  username: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{3,32}$/, "Username must be 3 to 32 characters: letters, digits, _ . -"),
  password: z
    .string()
    .min(10, "Password must be at least 10 characters")
    .max(256, "Password must be at most 256 characters"),
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

  // now: epoch ms. Consumes nothing.
  function findUnusedLink(token: string, now: number): TOption<TDashboardLinkToken> {
    const link = verifyDashboardLinkToken(config.secret, token, now);

    if (link === undefined || store.isLinkUsed(link.nonce)) {
      return undefined;
    }

    return link;
  }

  function startSession(c: Context, account: TAccount): Response {
    setCookie(
      c,
      SESSION_COOKIE,
      store.createSession(account.id, Date.now()),
      SESSION_COOKIE_OPTIONS,
    );

    return c.json(describeAccount(account));
  }

  function describeAccount(account: TAccount): TMeResponse {
    return { username: account.username, chats: store.listChats(account.id) };
  }

  const requireSession = createMiddleware<TEnv>(async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    let account: TOption<TAccount>;

    if (token !== undefined) {
      account = store.touchSession(token, Date.now());
    }

    if (token === undefined || account === undefined) {
      return c.json<TApiError>({ error: "Unauthorized" }, 401);
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
    if (c.req.method !== "GET" && c.req.header("Origin") !== config.publicOrigin) {
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

    return c.json<TLinkCheckResponse>({
      valid: findUnusedLink(body.data.token, Date.now()) !== undefined,
    });
  });

  app.post("/api/register", async (c) => {
    const body = await parseBody(c.req.raw, SRegisterBody);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    // no open sign-up: nothing is hashed or created without a usable link
    const link = findUnusedLink(body.data.token, Date.now());

    if (link === undefined) {
      return c.json<TApiError>({ error: INVALID_LINK }, 400);
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

    return startSession(c, { id: registration.accountId, username: body.data.username });
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
      return c.json<TApiError>({ error: "Wrong username or password" }, 401);
    }

    loginAttempts.delete(name);

    if (link !== undefined && !store.redeemLink(credentials.id, link, Date.now())) {
      return c.json<TApiError>({ error: INVALID_LINK }, 400);
    }

    return startSession(c, { id: credentials.id, username: credentials.username });
  });

  app.post("/api/link", requireSession, async (c) => {
    const body = await parseBody(c.req.raw, SLinkBody);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    const now = Date.now();
    const link = findUnusedLink(body.data.token, now);

    if (link === undefined || !store.redeemLink(c.var.account.id, link, now)) {
      return c.json<TApiError>({ error: INVALID_LINK }, 400);
    }

    return c.json(describeAccount(c.var.account));
  });

  app.post("/api/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);

    if (token !== undefined) {
      store.deleteSession(token);
    }

    deleteCookie(c, SESSION_COOKIE, SESSION_COOKIE_OPTIONS);

    return c.json<TLogoutResponse>({ ok: true });
  });

  app.get("/api/me", requireSession, (c) => c.json(describeAccount(c.var.account)));

  app.use("/api/chats/:chatId/*", requireSession);

  // NOTE: a chat of another account answers like a chat that does not exist
  app.use("/api/chats/:chatId/*", async (c, next) => {
    if (!store.isChatLinked(c.var.account.id, c.req.param("chatId"))) {
      return c.json<TApiError>({ error: "Not found" }, 404);
    }

    await next();
  });

  app.get("/api/chats/:chatId/messages", async (c) => {
    const before = SMessageId.optional().safeParse(c.req.query("before"));

    if (!before.success) {
      return c.json<TApiError>({ error: "Invalid before" }, 400);
    }

    // one row more than a page tells whether another page follows
    const messages = await reader.listMessages(
      c.req.param("chatId"),
      before.data,
      MESSAGES_PAGE_SIZE + 1,
    );
    const response: TMessagesResponse = { messages: messages.slice(0, MESSAGES_PAGE_SIZE) };

    if (messages.length > MESSAGES_PAGE_SIZE) {
      response.nextBefore = response.messages.at(-1)?.id;
    }

    return c.json(response);
  });

  app.delete("/api/chats/:chatId/messages/:messageId", async (c) => {
    const messageId = SMessageId.safeParse(c.req.param("messageId"));

    if (!messageId.success) {
      return c.json<TApiError>({ error: "Invalid message id" }, 400);
    }

    const result = await internalApi.deleteMessage(c.req.param("chatId"), messageId.data);

    if ("error" in result) {
      return c.json<TApiError>({ error: result.error }, result.status);
    }

    return c.json(result.data);
  });

  app.get("/api/chats/:chatId/facts", async (c) =>
    c.json(buildFactGraph(await reader.listFacts(c.req.param("chatId")))),
  );

  app.get("/api/chats/:chatId/model", async (c) => {
    const result = await internalApi.getModel(c.req.param("chatId"));

    if ("error" in result) {
      return c.json<TApiError>({ error: result.error }, result.status);
    }

    return c.json(result.data);
  });

  app.put("/api/chats/:chatId/model", async (c) => {
    const body = await parseBody(c.req.raw, SDashboardModelUpdate);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    const result = await internalApi.updateModel(c.req.param("chatId"), body.data);

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
