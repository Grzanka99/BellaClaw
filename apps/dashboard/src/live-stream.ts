import { createLogger, SDashboardStreamEvent, type TOption } from "@bellaclaw/shared";
import type { TAppStreamEvent } from "./api-types";
import type { TInternalApi } from "./internal-api";

type TAppStreamListener = (event: TAppStreamEvent) => void;

export type TLiveStream = {
  // listener: called with every event of the account while its stream is open. Returns what
  // closes it
  subscribe(accountId: string, listener: TAppStreamListener): () => void;
};

const logger = createLogger("LIVE-STREAM");

// NOTE: one stream from the assistant for every account, fanned out to the app streams of each
// account. Nothing replays: whenever that stream opens or drops, every app stream is told to
// check revisions, because events of the time between are lost and typing may have stopped unseen.
// retryMs: the wait before connecting again; silenceMs: how long the stream may send nothing, not
// even a keep-alive, before it counts as lost
export function createLiveStream(internalApi: TInternalApi, retryMs: number, silenceMs: number) {
  // by account public id
  const listeners = new Map<string, Set<TAppStreamListener>>();

  function checkAll(): void {
    for (const accountListeners of listeners.values()) {
      for (const listener of accountListeners) {
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

    const parsed = SDashboardStreamEvent.safeParse(decoded);

    if (!parsed.success) {
      logger.error("The assistant's stream sent an unknown event");
      return;
    }

    const { accountId, ...event } = parsed.data;

    for (const listener of listeners.get(accountId) ?? []) {
      listener(event);
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
    subscribe(accountId: string, listener: TAppStreamListener): () => void {
      let accountListeners = listeners.get(accountId);

      if (accountListeners === undefined) {
        accountListeners = new Set();
        listeners.set(accountId, accountListeners);
      }

      accountListeners.add(listener);

      return () => {
        accountListeners.delete(listener);

        if (accountListeners.size === 0 && listeners.get(accountId) === accountListeners) {
          listeners.delete(accountId);
        }
      };
    },

    // keeps the stream from the assistant open until signal aborts
    async follow(signal: AbortSignal): Promise<void> {
      while (!signal.aborted) {
        const opened = await internalApi.openStream(signal);

        if ("data" in opened) {
          checkAll();
          await read(opened.data);
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
