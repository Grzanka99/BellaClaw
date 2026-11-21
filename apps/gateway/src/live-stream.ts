import { createLogger, SGatewayStreamEvent, type TOption } from "@bellaclaw/shared";
import type { TAppStreamEvent } from "./api-types";
import type { TInternalApi } from "./internal-api";

type TAppStreamListener = (event: TAppStreamEvent) => void;

export type TLiveStream = {
  // listener: called with every event of the account while its stream is open; app: whether the
  // stream is an app session's, which counts toward presence. Returns what closes it
  subscribe(accountId: string, listener: TAppStreamListener, app: boolean): () => void;
};

const logger = createLogger("LIVE-STREAM");

// NOTE: one stream from the assistant for every account, fanned out to the app streams of each
// account; a reply goes to its account's app session streams only. Nothing replays: whenever that
// stream opens or drops, every app stream is told to check revisions, because events of the time
// between are lost and typing may have stopped unseen.
// The assistant learns which accounts have an open app session stream here: the whole set, sent on
// each connection and whenever an account's first such stream opens or its last one closes, one
// report at a time; a failed report is sent again after retryMs. retryMs: the wait before
// connecting or reporting again; silenceMs: how long the stream may send nothing, not even a
// keep-alive, before it counts as lost
export function createLiveStream(internalApi: TInternalApi, retryMs: number, silenceMs: number) {
  // by account public id: each listener with whether its stream is an app session's
  const listeners = new Map<string, Map<TAppStreamListener, boolean>>();
  // the number of open app session streams, by account public id
  const appStreams = new Map<string, number>();
  const presence = { connected: false, reporting: false, changed: false };

  // NOTE: the assistant forgets the set when the connection drops, so nothing is sent without one
  async function reportPresence(): Promise<void> {
    if (!presence.connected) {
      return;
    }

    if (presence.reporting) {
      presence.changed = true;
      return;
    }

    presence.reporting = true;

    do {
      presence.changed = false;
      const reported = await internalApi.reportPresence([...appStreams.keys()]);

      if ("error" in reported) {
        presence.changed = true;
        await Bun.sleep(retryMs);
      }
    } while (presence.changed && presence.connected);

    presence.reporting = false;
  }

  function checkAll(): void {
    for (const accountListeners of listeners.values()) {
      for (const listener of accountListeners.keys()) {
        listener({ type: "check" });
      }
    }
  }

  function dispatch(line: string): void {
    let decoded: unknown;

    try {
      decoded = JSON.parse(line);
    } catch {
      logger.error("The assistant's stream sent a line that is not JSON");
      return;
    }

    const parsed = SGatewayStreamEvent.safeParse(decoded);

    if (!parsed.success) {
      logger.error("The assistant's stream sent an unknown event");
      return;
    }

    const { accountId, ...event } = parsed.data;

    for (const [listener, app] of listeners.get(accountId) ?? []) {
      if (event.type !== "reply" || app) {
        listener(event);
      }
    }
  }

  // resolves when the stream ends, fails or stays silent too long; a silent stream is cancelled
  async function read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let silence: TOption<ReturnType<typeof setTimeout>>;

    try {
      while (true) {
        silence = setTimeout(() => {
          logger.warning("The assistant's stream went silent");
          void reader.cancel();
        }, silenceMs);
        const { done, value } = await reader.read();
        clearTimeout(silence);

        if (done) {
          return;
        }

        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";

        // an empty line is a keep-alive
        for (const line of lines) {
          if (line.length > 0) {
            dispatch(line);
          }
        }
      }
    } catch (error) {
      logger.error(`The assistant's stream failed: ${error}`);
    } finally {
      clearTimeout(silence);
    }
  }

  return {
    subscribe(accountId: string, listener: TAppStreamListener, app: boolean): () => void {
      let accountListeners = listeners.get(accountId);

      if (accountListeners === undefined) {
        accountListeners = new Map();
        listeners.set(accountId, accountListeners);
      }

      accountListeners.set(listener, app);

      if (app) {
        const count = appStreams.get(accountId) ?? 0;
        appStreams.set(accountId, count + 1);

        if (count === 0) {
          void reportPresence();
        }
      }

      let open = true;

      // NOTE: a stream may release its subscription more than once
      return () => {
        if (!open) {
          return;
        }

        open = false;
        accountListeners.delete(listener);

        if (accountListeners.size === 0 && listeners.get(accountId) === accountListeners) {
          listeners.delete(accountId);
        }

        if (app) {
          const count = (appStreams.get(accountId) ?? 1) - 1;

          if (count === 0) {
            appStreams.delete(accountId);
            void reportPresence();
          } else {
            appStreams.set(accountId, count);
          }
        }
      };
    },

    // keeps the stream from the assistant open until signal aborts
    async follow(signal: AbortSignal): Promise<void> {
      while (!signal.aborted) {
        const opened = await internalApi.openStream(signal);

        if ("data" in opened) {
          presence.connected = true;
          void reportPresence();
          checkAll();
          await read(opened.data);
          presence.connected = false;
          checkAll();

          if (!signal.aborted) {
            logger.warning("The assistant's stream closed; connecting again");
          }
        }

        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, retryMs);
          signal.addEventListener("abort", done);
        });
      }
    },
  };
}
