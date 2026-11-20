// What the gateway's routes share: the session cookie, the request body and the answers of the
// assistant, and the session middleware.
import type { TOption } from "@bellaclaw/shared";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { CookieOptions } from "hono/utils/cookie";
import type { z } from "zod";
import { ACCOUNT_HEADER } from "./account-header";
import { type AccountStore, SESSION_TTL_MS, type TAccount } from "./account-store";
import type { TApiError } from "./api-types";
import type { TChatReader } from "./chat-reader";
import type { TInternalApi, TInternalApiResult } from "./internal-api";
import type { TLiveStream } from "./live-stream";

export const SESSION_COOKIE = "bellaclaw_dashboard_session";
// "app" on a request that starts a session asks for a bearer token instead of the cookie
export const CLIENT_HEADER = "X-BellaClaw-Client";

export const SESSION_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
  maxAge: SESSION_TTL_MS / 1000,
};
// every body but an image upload is a small JSON object
export const MAX_JSON_BODY_BYTES = 65_536;
export const LINKED_ELSEWHERE = "This chat is linked to another account";
export const OTHER_ACCOUNT = "You are signed in to another account now";

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

export type TEnv = { Variables: { account: TAccount } };

export async function parseBody<T>(request: Request, schema: z.ZodType<T>) {
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

export function invalidBody(error: z.ZodError): TApiError {
  return { error: error.issues[0]?.message ?? "Invalid request" };
}

// the token of an Authorization header of the Bearer scheme
export function bearerToken(c: Context): TOption<string> {
  return /^Bearer (\S+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
}

// NOTE: a request of the app carries a bearer token or the client header, and never uses the
// cookie. A browser sends neither header across sites without a preflight, which the gateway
// does not answer, so app requests are exempt from the Origin rule.
export function isAppRequest(c: Context): boolean {
  return bearerToken(c) !== undefined || c.req.header(CLIENT_HEADER) === "app";
}

// the answer to a failed assistant request, passed on
export function apiFailed(
  c: Context,
  result: Exclude<TInternalApiResult<unknown>, { data: unknown }>,
) {
  return c.json<TApiError>({ error: result.error }, result.status);
}

// the assistant's answer, passed on
export function respond<T>(c: Context, result: TInternalApiResult<T>) {
  if ("error" in result) {
    return apiFailed(c, result);
  } else {
    return c.json(result.data);
  }
}

// NOTE: an app request is served by its bearer token alone, and names no account: the account
// header guards pages of the browser, which share one cookie
export function createRequireSession(store: AccountStore) {
  return createMiddleware<TEnv>(async (c, next) => {
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
}
