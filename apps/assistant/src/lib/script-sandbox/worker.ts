import type { TOption } from "@bellaclaw/shared";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten-core";
import {
  SMainToWorkerMessage,
  type TFetchReplyMessage,
  type TRunMessage,
  type TWorkerToMainMessage,
} from "./protocol";

const MAX_LOG_LINE_CHARS = 500;
const MAX_ERROR_CHARS = 500;
const STACK_SIZE_BYTES = 1024 * 1024;

// Evaluated inside QuickJS. Builds the `host` object from raw host functions
// without exposing them as globals, runs the script's default export and
// serializes its return value to JSON inside the sandbox.
const BOOTSTRAP_SOURCE = `(async function (run, ctxJson, fetchTextRaw, logRaw) {
  "use strict";
  if (typeof run !== "function") {
    throw new TypeError("automation must have a default export: export default async function run(ctx, host)");
  }
  const format = (value) => {
    if (typeof value === "string") {
      return value;
    }
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) {
        return json;
      }
    } catch {}
    return String(value);
  };
  const fetchText = async (url) => JSON.parse(await fetchTextRaw(String(url)));
  const host = Object.freeze({
    fetchText,
    fetchJson: async (url) => {
      const response = await fetchText(url);
      try {
        return JSON.parse(response.text);
      } catch (error) {
        throw new Error("invalid JSON from " + response.url + ": " + error.message);
      }
    },
    log: (...values) => {
      logRaw(values.map(format).join(" "));
    },
  });
  const result = await run(JSON.parse(ctxJson), host);
  return JSON.stringify(result);
})`;

function send(message: TWorkerToMainMessage): void {
  postMessage(message);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}…`;
}

function describeError(context: QuickJSContext, handle: QuickJSHandle): string {
  const dumped: unknown = context.dump(handle);

  if (typeof dumped !== "object" || dumped === null) {
    return truncate(`Uncaught ${String(dumped)}`, MAX_ERROR_CHARS);
  }

  const name = Reflect.get(dumped, "name");
  const message = Reflect.get(dumped, "message");
  const stack = Reflect.get(dumped, "stack");
  let text = `${String(name ?? "Error")}: ${String(message ?? "")}`;

  if (typeof stack === "string") {
    const firstFrame = stack
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("at "));

    if (firstFrame !== undefined) {
      text = `${text} (${firstFrame})`;
    }
  }

  return truncate(text, MAX_ERROR_CHARS);
}

async function run(message: TRunMessage): Promise<void> {
  const quickjs = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = quickjs.newRuntime();
  const context = runtime.newContext();
  const pendingFetches = new Map<number, QuickJSDeferredPromise>();
  const ownedHandles: QuickJSHandle[] = [];
  let nextFetchId = 0;
  let logCount = 0;
  let cpuUsedMs = 0;
  let sliceStartedAt: TOption<number>;
  let cpuExceeded = false;
  let wake: TOption<() => void>;

  runtime.setMemoryLimit(message.memoryBytes);
  runtime.setMaxStackSize(STACK_SIZE_BYTES);
  runtime.setInterruptHandler(() => {
    if (sliceStartedAt === undefined) {
      return false;
    }

    if (cpuUsedMs + performance.now() - sliceStartedAt > message.cpuMs) {
      cpuExceeded = true;
      return true;
    }

    return false;
  });

  // Runs synchronous VM work and charges its duration to the CPU budget.
  function inSlice<T>(work: () => T): T {
    const startedAt = performance.now();
    sliceStartedAt = startedAt;

    try {
      return work();
    } finally {
      cpuUsedMs += performance.now() - startedAt;
      sliceStartedAt = undefined;
    }
  }

  function own(handle: QuickJSHandle): QuickJSHandle {
    ownedHandles.push(handle);

    return handle;
  }

  function errorText(handle: QuickJSHandle): string {
    if (cpuExceeded) {
      return `cpu time limit exceeded (${message.cpuMs} ms)`;
    }

    return describeError(context, handle);
  }

  function onFetchReply(reply: TFetchReplyMessage): void {
    const deferred = pendingFetches.get(reply.id);

    if (deferred === undefined) {
      return;
    }

    pendingFetches.delete(reply.id);
    inSlice(() => {
      if (reply.ok) {
        const value = context.newString(JSON.stringify(reply.result));
        deferred.resolve(value);
        value.dispose();
      } else {
        const error = context.newError(reply.error);
        deferred.reject(error);
        error.dispose();
      }
    });
    deferred.dispose();
    wake?.();
  }

  function waitForHostEvent(): Promise<void> {
    return new Promise((resolve) => {
      wake = () => {
        wake = undefined;
        resolve();
      };
    });
  }

  // Pumps QuickJS jobs until `promise` settles, waiting for host fetches in between.
  // Returns an owned handle to the fulfilled value; throws with the script-facing message otherwise.
  async function settle(promise: QuickJSHandle): Promise<QuickJSHandle> {
    while (true) {
      const jobs = inSlice(() => runtime.executePendingJobs());

      if (jobs.error) {
        const text = errorText(jobs.error);
        jobs.error.dispose();
        throw new Error(text);
      }

      const state = context.getPromiseState(promise);

      if (state.type === "fulfilled") {
        if (state.notAPromise) {
          return promise.dup();
        }

        return state.value;
      }

      if (state.type === "rejected") {
        const text = errorText(state.error);
        state.error.dispose();
        throw new Error(text);
      }

      if (pendingFetches.size === 0) {
        throw new Error("script promise never settled");
      }

      await waitForHostEvent();
    }
  }

  addEventListener("message", (event) => {
    const parsed = SMainToWorkerMessage.safeParse(event.data);

    if (parsed.success && parsed.data.type === "fetch-reply") {
      onFetchReply(parsed.data);
    }
  });

  let outcome: TWorkerToMainMessage;

  try {
    const fetchTextRaw = own(
      context.newFunction("fetchTextRaw", (urlHandle) => {
        const id = nextFetchId;
        nextFetchId += 1;
        const deferred = context.newPromise();
        pendingFetches.set(id, deferred);
        send({ type: "fetch", id, url: context.getString(urlHandle) });

        return deferred.handle;
      }),
    );
    const logRaw = own(
      context.newFunction("logRaw", (lineHandle) => {
        logCount += 1;

        if (logCount <= message.maxLogLines) {
          send({ type: "log", line: truncate(context.getString(lineHandle), MAX_LOG_LINE_CHARS) });
        } else if (logCount === message.maxLogLines + 1) {
          send({
            type: "log",
            line: `[log limit of ${message.maxLogLines} lines reached; further lines dropped]`,
          });
        }
      }),
    );
    const moduleResult = inSlice(() =>
      context.evalCode(message.source, "automation.js", { type: "module" }),
    );

    if (moduleResult.error) {
      const text = errorText(moduleResult.error);
      moduleResult.error.dispose();
      throw new Error(text);
    }

    own(moduleResult.value);
    const namespace = own(await settle(moduleResult.value));
    const runHandle = own(context.getProp(namespace, "default"));
    const bootstrapResult = inSlice(() =>
      context.evalCode(BOOTSTRAP_SOURCE, "bootstrap.js", { type: "global" }),
    );

    if (bootstrapResult.error) {
      const text = errorText(bootstrapResult.error);
      bootstrapResult.error.dispose();
      throw new Error(text);
    }

    const bootstrap = own(bootstrapResult.value);
    const ctxJson = own(context.newString(message.ctxJson));
    const callResult = inSlice(() =>
      context.callFunction(bootstrap, context.undefined, runHandle, ctxJson, fetchTextRaw, logRaw),
    );

    if (callResult.error) {
      const text = errorText(callResult.error);
      callResult.error.dispose();
      throw new Error(text);
    }

    own(callResult.value);
    const jsonHandle = own(await settle(callResult.value));
    let json: TOption<string>;

    if (context.typeof(jsonHandle) === "string") {
      json = context.getString(jsonHandle);
    }

    outcome = { type: "done", ok: true, json };
  } catch (error) {
    let text = String(error);

    if (error instanceof Error) {
      text = error.message;
    }

    outcome = { type: "done", ok: false, error: text };
  }

  for (const deferred of pendingFetches.values()) {
    deferred.dispose();
  }

  pendingFetches.clear();

  for (const handle of ownedHandles.reverse()) {
    handle.dispose();
  }

  context.dispose();
  runtime.dispose();
  send(outcome);
}

addEventListener("message", (event) => {
  const parsed = SMainToWorkerMessage.safeParse(event.data);

  if (parsed.success && parsed.data.type === "run") {
    void run(parsed.data);
  }
});
