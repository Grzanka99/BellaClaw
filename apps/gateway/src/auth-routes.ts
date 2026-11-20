import { randomBytes } from "node:crypto";
import {
  ADDRESS_LINKED_ELSEWHERE,
  createLogger,
  isP256PublicKey,
  SGatewayDeviceRegistration,
  type TGatewayLinkToken,
  type TOption,
  verifyGatewayLinkToken,
} from "@bellaclaw/shared";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { ACCOUNT_HEADER } from "./account-header";
import type { TAccount, TSessionKind } from "./account-store";
import type {
  TApiError,
  TAppSessionResponse,
  TDeviceResponse,
  TLinkCheckResponse,
  TLinkConfirmRequest,
  TLinkLoginRequest,
  TLinkRequest,
  TLoginRequest,
  TLogoutResponse,
  TMeResponse,
  TRegisterRequest,
} from "./api-types";
import type { TInternalApiResult } from "./internal-api";
import {
  apiFailed,
  bearerToken,
  createRequireSession,
  invalidBody,
  isAppRequest,
  LINKED_ELSEWHERE,
  OTHER_ACCOUNT,
  parseBody,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  type TEnv,
  type TGatewayDependencies,
} from "./route-support";

const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
// wrong activation codes, counted for every registration together: an anonymous registration has
// nothing else to count by
const MAX_ACTIVATION_FAILURES = 5;
const ACTIVATION_LOCK_MS = 15 * 60 * 1000;
const INVALID_LINK = "The link is invalid, expired or already used";
const WRONG_CREDENTIALS = "Wrong username or password";

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

const logger = createLogger("GATEWAY");

// the answer to a failed link request; an address of another account says so
function linkFailed(c: Context, result: Exclude<TInternalApiResult<unknown>, { data: unknown }>) {
  if (result.code === ADDRESS_LINKED_ELSEWHERE) {
    return c.json<TApiError>({ error: LINKED_ELSEWHERE }, 409);
  }

  return c.json<TApiError>({ error: result.error }, result.status);
}

// the routes of accounts and sessions: register, login, link login and link, with their lockouts,
// logout, the signed-in account and the app session's device
export function registerAuthRoutes(
  app: Hono<TEnv>,
  { config, store, internalApi }: TGatewayDependencies,
) {
  const requireSession = createRequireSession(store);
  // verified for an unknown username, so the answer takes as long as for a wrong password
  const dummyPasswordHash = Bun.password.hash(randomBytes(16).toString("hex"));
  // login attempts since the last success, by lowercase username
  const loginAttempts = new Map<string, { count: number; lastAt: number }>();
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

  // Checks a registration's activation code against the lockout and the assistant; undefined when
  // the code is right, else the answer
  async function admitActivationCode(
    c: Context,
    activationCode: string,
  ): Promise<TOption<Response>> {
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

    return undefined;
  }

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
      const refused = await admitActivationCode(c, activationCode);

      if (refused !== undefined) {
        return refused;
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
}
