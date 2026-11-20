import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { TAppStreamEvent } from "./api-types";
import {
  bearerToken,
  createRequireSession,
  isAppRequest,
  SESSION_COOKIE,
  type TEnv,
  type TGatewayDependencies,
} from "./route-support";

// NOTE: well under the 255 s idle timeout, and the usual idle limits of a proxy
const STREAM_KEEP_ALIVE_MS = 25_000;
const MAX_ACCOUNT_STREAMS = 4;

export function registerStreamRoute(app: Hono<TEnv>, { store, liveStream }: TGatewayDependencies) {
  const requireSession = createRequireSession(store);
  // what ends each open app stream, by account public id, oldest first
  const streamEnds = new Map<string, (() => void)[]>();

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
}
