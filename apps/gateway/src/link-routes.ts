import {
  ADDRESS_LINKED_ELSEWHERE,
  createLogger,
  type TGatewayLinkToken,
  type TOption,
  verifyGatewayLinkToken,
} from "@bellaclaw/shared";
import type { Context, Hono } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import type { TAccount, TSessionKind } from "./account-store";
import type {
  TApiError,
  TAppSessionResponse,
  TLinkCheckResponse,
  TLinkConfirmRequest,
  TLinkLoginRequest,
  TLinkRequest,
  TMeResponse,
} from "./api-types";
import type { TInternalApiResult } from "./internal-api";
import {
  apiFailed,
  createRequireSession,
  describeAccount,
  invalidBody,
  isAppRequest,
  LINKED_ELSEWHERE,
  parseBody,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  SNewPassword,
  type TEnv,
  type TGatewayDependencies,
  WRONG_CREDENTIALS,
} from "./route-support";

export const INVALID_LINK = "The link is invalid, expired or already used";

const SLinkBody: z.ZodType<TLinkRequest> = z.object({ token: z.string() });
const SLinkConfirmBody: z.ZodType<TLinkConfirmRequest> = z.object({ token: z.string() });
const SLinkLoginBody: z.ZodType<TLinkLoginRequest> = z.object({
  token: z.string(),
  password: SNewPassword.optional(),
});

const logger = createLogger("GATEWAY");

// the answer to a failed link request; an address of another account says so
export function linkFailed(
  c: Context,
  result: Exclude<TInternalApiResult<unknown>, { data: unknown }>,
) {
  if (result.code === ADDRESS_LINKED_ELSEWHERE) {
    return c.json<TApiError>({ error: LINKED_ELSEWHERE }, 409);
  }

  return c.json<TApiError>({ error: result.error }, result.status);
}

// now: epoch ms. Consumes nothing.
export function findUnusedLink(
  { config, store }: TGatewayDependencies,
  token: string,
  now: number,
): TOption<TGatewayLinkToken> {
  const link = verifyGatewayLinkToken(config.secret, token, now);

  if (link === undefined || store.isLinkUsed(link.nonce)) {
    return undefined;
  }

  return link;
}

// The public id of the account the chat is linked to, or undefined for an unlinked chat. A row of
// account_chats the import still holds counts as its account's link.
// NOTE: the row is read before the assistant: the import removes it only once the assistant's
// link is active, so no moment answers neither.
export async function findLinkedAccountId(
  { store, internalApi }: TGatewayDependencies,
  chatId: string,
): Promise<TInternalApiResult<TOption<string>>> {
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
export async function resolveLink(
  c: Context,
  dependencies: TGatewayDependencies,
  token: TOption<string>,
): Promise<Response | { link: TGatewayLinkToken; linkedAccountId: TOption<string> }> {
  let link: TOption<TGatewayLinkToken>;

  if (token !== undefined) {
    link = findUnusedLink(dependencies, token, Date.now());
  }

  if (link === undefined) {
    return c.json<TApiError>({ error: INVALID_LINK }, 400);
  }

  const linked = await findLinkedAccountId(dependencies, link.chatId);

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
export async function linkChat(
  c: Context,
  { store, internalApi }: TGatewayDependencies,
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

// the routes of a chat's link: its check, the login by a link and the link of a signed-in account
export function registerLinkRoutes(app: Hono<TEnv>, dependencies: TGatewayDependencies) {
  const { store, internalApi } = dependencies;
  const requireSession = createRequireSession(store);

  app.post("/api/link/check", async (c) => {
    const body = await parseBody(c.req.raw, SLinkBody);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    const link = findUnusedLink(dependencies, body.data.token, Date.now());

    if (link === undefined) {
      return c.json<TLinkCheckResponse>({ valid: false });
    }

    const linked = await findLinkedAccountId(dependencies, link.chatId);

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

    const resolved = await resolveLink(c, dependencies, body.data.token);

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

  // NOTE: the confirmation names its account in the account header, so another signed-in account
  // is refused before the link is used. So is a link of another account's chat, which still logs
  // into it.
  app.post("/api/link", requireSession, async (c) => {
    const body = await parseBody(c.req.raw, SLinkConfirmBody);

    if (!body.success) {
      return c.json(invalidBody(body.error), 400);
    }

    const resolved = await resolveLink(c, dependencies, body.data.token);

    if (resolved instanceof Response) {
      return resolved;
    }

    const failed = await linkChat(
      c,
      dependencies,
      resolved.link,
      resolved.linkedAccountId,
      c.var.account,
      undefined,
    );

    if (failed !== undefined) {
      return failed;
    }

    return describeAccount(c, internalApi, c.var.account);
  });
}
