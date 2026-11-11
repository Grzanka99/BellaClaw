import type { TOption } from "@bellaclaw/shared";
import { z } from "zod";
import { createBrowserHeaders, fetchTextWithLimit } from "../web/http";
import { SWorkerToMainMessage, type TFetchReplyMessage, type TRunMessage } from "./protocol";

export type TScriptFetchResult = { url: string; status: number; contentType: string; text: string };
export type TScriptFetcher = (url: string, signal: AbortSignal) => Promise<TScriptFetchResult>;
export type TScriptOutcome =
  | { kind: "text"; text: string }
  | { kind: "data"; data: unknown }
  | { kind: "silent" };
export type TScriptFetchLog = {
  url: string;
  status: TOption<number>;
  bytes: number;
  error: TOption<string>;
};
export type TScriptRunResult =
  | {
      ok: true;
      outcome: TScriptOutcome;
      state: TOption<unknown>;
      logs: string[];
      fetches: TScriptFetchLog[];
      durationMs: number;
    }
  | { ok: false; error: string; logs: string[]; fetches: TScriptFetchLog[]; durationMs: number };

export const SCRIPT_LIMITS = {
  memoryBytes: 64 * 1024 * 1024,
  cpuMs: 5_000,
  wallMs: 30_000,
  maxFetches: 10,
  maxFetchBytes: 1_000_000,
  maxLogLines: 50,
  maxStateBytes: 16_384,
};

export type TScriptLimits = typeof SCRIPT_LIMITS;

export type TRunScriptArgs = {
  /** ES module source: `export default async function run(ctx, host) { ... }` */
  source: string;
  /** JSON value */
  config: unknown;
  /** JSON value or undefined (previous state) */
  state: unknown;
  now: Date;
  timezone: string;
  /** e.g. ["https://api.open-meteo.com"] */
  allowedOrigins: string[];
  /** Cap on JSON size of returned outcome (excluding state) */
  maxOutputBytes: number;
  /** Injectable for tests; default = real fetch via lib/web */
  fetcher?: TScriptFetcher;
  signal?: AbortSignal;
  /** Overrides for SCRIPT_LIMITS (mainly for tests) */
  limits?: Partial<TScriptLimits>;
};

const FETCH_TIMEOUT_MS = 15_000;

const SScriptReturn = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string(), state: z.json().optional() }),
  z.object({ kind: z.literal("data"), data: z.json(), state: z.json().optional() }),
  z.object({ kind: z.literal("silent"), state: z.json().optional() }),
]);

const EXPECTED_RETURN =
  '{ kind: "text", text, state? } | { kind: "data", data, state? } | { kind: "silent", state? }';

type TWorkerOutcome = { ok: true; json: TOption<string> } | { ok: false; error: string };

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function toOrigin(url: string): TOption<string> {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export async function runScript(args: TRunScriptArgs): Promise<TScriptRunResult> {
  const limits = { ...SCRIPT_LIMITS, ...args.limits };
  const startedAt = performance.now();
  const logs: string[] = [];
  const fetches: TScriptFetchLog[] = [];

  function fail(error: string): TScriptRunResult {
    return {
      ok: false,
      error,
      logs,
      fetches,
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  if (args.signal?.aborted) {
    return fail("aborted");
  }

  let ctxJson: TOption<string>;

  try {
    ctxJson = JSON.stringify({
      config: args.config,
      state: args.state,
      now: args.now.toISOString(),
      timezone: args.timezone,
    });
  } catch (error) {
    return fail(`config or state is not JSON-serializable: ${errorMessage(error)}`);
  }

  const allowedOrigins = new Set<string>();

  for (const origin of args.allowedOrigins) {
    const normalized = toOrigin(origin);

    if (normalized !== undefined) {
      allowedOrigins.add(normalized);
    }
  }

  const defaultFetcher: TScriptFetcher = async (url, signal) => {
    const result = await fetchTextWithLimit({
      url,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: limits.maxFetchBytes,
      headers: createBrowserHeaders(),
      signal,
      validateRedirectUrl(redirectUrl) {
        const redirectOrigin = toOrigin(redirectUrl);

        if (redirectOrigin === undefined || !allowedOrigins.has(redirectOrigin)) {
          throw new Error(`redirected to origin not allowed: ${redirectOrigin ?? redirectUrl}`);
        }
      },
    });

    return {
      url: result.url,
      status: result.response.status,
      contentType: result.response.headers.get("content-type") ?? "",
      text: result.text,
    };
  };
  const fetcher = args.fetcher ?? defaultFetcher;

  const fetchController = new AbortController();
  const inFlight = new Set<TScriptFetchLog>();
  const worker = new Worker(new URL("./worker.ts", import.meta.url));
  let finished = false;

  async function performFetch(url: string): Promise<TScriptFetchResult> {
    if (fetches.length > limits.maxFetches) {
      throw new Error(`fetch limit exceeded (max ${limits.maxFetches} per run)`);
    }

    const origin = toOrigin(url);

    if (origin === undefined) {
      throw new Error(`invalid URL: ${url}`);
    }

    if (!allowedOrigins.has(origin)) {
      throw new Error(`origin not allowed: ${origin}`);
    }

    const result = await fetcher(url, fetchController.signal);
    const finalOrigin = toOrigin(result.url);

    if (finalOrigin === undefined || !allowedOrigins.has(finalOrigin)) {
      throw new Error(`redirected to origin not allowed: ${finalOrigin ?? result.url}`);
    }

    if (byteLength(result.text) > limits.maxFetchBytes) {
      throw new Error(`response too large (max ${limits.maxFetchBytes} bytes)`);
    }

    return result;
  }

  async function handleFetch(id: number, url: string): Promise<void> {
    const entry: TScriptFetchLog = { url, status: undefined, bytes: 0, error: undefined };
    fetches.push(entry);
    inFlight.add(entry);
    let reply: TFetchReplyMessage;

    try {
      const result = await performFetch(url);
      entry.status = result.status;
      entry.bytes = byteLength(result.text);
      reply = { type: "fetch-reply", id, ok: true, result };
    } catch (error) {
      entry.error = errorMessage(error);
      reply = { type: "fetch-reply", id, ok: false, error: entry.error };
    }

    inFlight.delete(entry);

    if (!finished) {
      worker.postMessage(reply);
    }
  }

  const outcome = await new Promise<TWorkerOutcome>((resolve) => {
    const wallTimer = setTimeout(() => {
      finish({ ok: false, error: `wall time limit exceeded (${limits.wallMs} ms)` });
    }, limits.wallMs);
    const onAbort = () => {
      finish({ ok: false, error: "aborted" });
    };

    function finish(result: TWorkerOutcome): void {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(wallTimer);
      args.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      fetchController.abort();

      for (const entry of inFlight) {
        entry.error = "cancelled";
      }

      inFlight.clear();
      resolve(result);
    }

    args.signal?.addEventListener("abort", onAbort, { once: true });
    worker.addEventListener("message", (event) => {
      const parsed = SWorkerToMainMessage.safeParse(event.data);

      if (!parsed.success) {
        finish({ ok: false, error: "sandbox sent an invalid message" });
        return;
      }

      const message = parsed.data;

      if (message.type === "log") {
        logs.push(message.line);
        return;
      }

      if (message.type === "fetch") {
        void handleFetch(message.id, message.url);
        return;
      }

      if (message.ok) {
        finish({ ok: true, json: message.json });
      } else {
        finish({ ok: false, error: message.error });
      }
    });
    worker.addEventListener("error", (event) => {
      finish({ ok: false, error: `sandbox worker crashed: ${event.message.slice(0, 300)}` });
    });

    const runMessage: TRunMessage = {
      type: "run",
      source: args.source,
      ctxJson,
      memoryBytes: limits.memoryBytes,
      cpuMs: limits.cpuMs,
      maxLogLines: limits.maxLogLines,
    };
    worker.postMessage(runMessage);
  });

  if (!outcome.ok) {
    return fail(outcome.error);
  }

  if (outcome.json === undefined) {
    return fail(`invalid return value: script returned nothing; expected ${EXPECTED_RETURN}`);
  }

  let returnedJson: unknown;

  try {
    returnedJson = JSON.parse(outcome.json);
  } catch (error) {
    return fail(`invalid return value: ${errorMessage(error)}`);
  }

  const returned = SScriptReturn.safeParse(returnedJson);

  if (!returned.success) {
    const issue = returned.error.issues[0];
    let detail = "unknown issue";

    if (issue !== undefined) {
      detail = `${issue.path.join(".") || "(root)"}: ${issue.message}`;
    }

    return fail(`invalid return value (${detail}); expected ${EXPECTED_RETURN}`);
  }

  const { state, ...outcomeValue } = returned.data;
  const outcomeBytes = byteLength(JSON.stringify(outcomeValue));

  if (outcomeBytes > args.maxOutputBytes) {
    return fail(`output too large (${outcomeBytes} bytes > cap ${args.maxOutputBytes} bytes)`);
  }

  if (state !== undefined) {
    const stateBytes = byteLength(JSON.stringify(state));

    if (stateBytes > limits.maxStateBytes) {
      return fail(`state too large (${stateBytes} bytes > cap ${limits.maxStateBytes} bytes)`);
    }
  }

  return {
    ok: true,
    outcome: outcomeValue,
    state,
    logs,
    fetches,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
