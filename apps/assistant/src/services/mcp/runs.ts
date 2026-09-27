import type { TOption } from "@bellaclaw/shared";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { Value } from "typebox/value";

type TPendingElicitation = {
  params: ElicitRequest["params"];
  resolve: (result: ElicitResult) => void;
};

type TRunCompletion = {
  text: TOption<string>;
  iterations: number;
  toolCallCount: number;
  stopReason: string;
};

type TStatusOutcome = { kind: "completed"; result: TRunCompletion } | { kind: "changed" };

type TLiveRun = {
  chatId: string;
  profileId: string;
  controller: AbortController;
  completion: Promise<TRunCompletion>;
  close: () => Promise<void>;
  pending: TOption<TPendingElicitation>;
  changed: Promise<void>;
  notifyChanged: () => void;
  timeout: TOption<ReturnType<typeof setTimeout>>;
  finishing: TOption<Promise<void>>;
};

export type TMcpRunStatus =
  | { status: "completed"; runId: string; profileId: string; result: TRunCompletion }
  | { status: "needs_input"; runId: string; profileId: string; request: ElicitRequest["params"] };

export class McpRunRegistry {
  private static _instance: TOption<McpRunRegistry>;
  private runs = new Map<string, TLiveRun>();

  public static get instance(): McpRunRegistry {
    if (McpRunRegistry._instance === undefined) {
      McpRunRegistry._instance = new McpRunRegistry();
    }
    return McpRunRegistry._instance;
  }

  public start(args: {
    chatId: string;
    profileId: string;
    inputTimeoutMs: number;
    controller: AbortController;
    run: (
      signal: AbortSignal,
      elicit: (params: ElicitRequest["params"], signal: AbortSignal) => Promise<ElicitResult>,
    ) => Promise<TRunCompletion>;
    close: () => Promise<void>;
  }): Promise<TMcpRunStatus> {
    const runId = crypto.randomUUID();
    let notifyChanged: () => void = () => undefined;
    const changed = new Promise<void>((resolve) => {
      notifyChanged = resolve;
    });
    const live: TLiveRun = {
      chatId: args.chatId,
      profileId: args.profileId,
      controller: args.controller,
      completion: Promise.resolve({
        text: undefined,
        iterations: 0,
        toolCallCount: 0,
        stopReason: "starting",
      }),
      close: args.close,
      pending: undefined,
      changed,
      notifyChanged,
      timeout: undefined,
      finishing: undefined,
    };
    this.runs.set(runId, live);
    const completion = Promise.resolve().then(() => {
      return args.run(args.controller.signal, (params, signal) => {
        return this.waitForInput(runId, live, params, signal, args.inputTimeoutMs);
      });
    });
    live.completion = completion.then(
      async (result) => {
        await this.finish(runId, live);
        return result;
      },
      async (error) => {
        await this.finish(runId, live);
        throw error;
      },
    );
    void live.completion.catch(() => undefined);
    return this.waitForStatus(runId, live);
  }

  public list(chatId: string): TMcpRunStatus[] {
    const statuses: TMcpRunStatus[] = [];
    for (const [runId, live] of this.runs) {
      if (live.chatId !== chatId || live.pending === undefined) {
        continue;
      }
      statuses.push({
        status: "needs_input",
        runId,
        profileId: live.profileId,
        request: live.pending.params,
      });
    }
    return statuses;
  }

  public async resume(
    chatId: string,
    runId: string,
    result: ElicitResult,
    signal?: AbortSignal,
  ): Promise<TMcpRunStatus> {
    const live = this.requireOwned(chatId, runId);
    const pending = live.pending;
    if (pending === undefined) {
      throw new Error("MCP run is not waiting for input");
    }
    if (signal?.aborted) {
      live.controller.abort(signal.reason);
      return this.waitForStatus(runId, live);
    }
    if (result.action === "accept" && pending.params.mode !== "url") {
      if (
        result.content === undefined ||
        !Value.Check(pending.params.requestedSchema, result.content)
      ) {
        throw new Error("Elicitation response does not match the requested schema");
      }
    }
    this.clearTimeout(live);
    live.pending = undefined;
    this.resetChanged(live);
    pending.resolve(result);
    const abort = () => live.controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await this.waitForStatus(runId, live);
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  public async cancel(chatId: string, runId: string): Promise<void> {
    const live = this.requireOwned(chatId, runId);
    live.controller.abort();
    const pending = live.pending;
    if (pending !== undefined) {
      live.pending = undefined;
      pending.resolve({ action: "cancel" });
    }
    await this.finish(runId, live);
  }

  private waitForInput(
    runId: string,
    live: TLiveRun,
    params: ElicitRequest["params"],
    signal: AbortSignal,
    inputTimeoutMs: number,
  ): Promise<ElicitResult> {
    if (signal.aborted || live.controller.signal.aborted) {
      return Promise.resolve({ action: "cancel" });
    }
    if (live.pending !== undefined) {
      return Promise.reject(new Error("MCP run requested concurrent elicitation"));
    }
    return new Promise<ElicitResult>((resolve) => {
      let pending: TPendingElicitation;
      const abort = () => {
        signal.removeEventListener("abort", abort);
        live.controller.signal.removeEventListener("abort", abort);
        if (live.pending === pending) {
          live.pending = undefined;
        }
        resolve({ action: "cancel" });
      };
      pending = {
        params,
        resolve: (result) => {
          signal.removeEventListener("abort", abort);
          live.controller.signal.removeEventListener("abort", abort);
          resolve(result);
        },
      };
      signal.addEventListener("abort", abort, { once: true });
      live.controller.signal.addEventListener("abort", abort, { once: true });
      live.pending = pending;
      live.timeout = setTimeout(() => {
        if (live.pending !== pending) {
          return;
        }
        live.controller.abort(new Error("MCP elicitation timed out"));
        live.pending = undefined;
        pending.resolve({ action: "cancel" });
        void this.finish(runId, live).catch(() => undefined);
      }, inputTimeoutMs);
      live.notifyChanged();
    });
  }

  private async waitForStatus(runId: string, live: TLiveRun): Promise<TMcpRunStatus> {
    const completed: Promise<TStatusOutcome> = live.completion.then((result) => ({
      kind: "completed",
      result,
    }));
    const changed: Promise<TStatusOutcome> = live.changed.then(() => ({ kind: "changed" }));
    const outcome = await Promise.race([completed, changed]);
    if (outcome.kind === "completed") {
      return { status: "completed", runId, profileId: live.profileId, result: outcome.result };
    }
    const pending = live.pending;
    if (pending === undefined) {
      const result = await live.completion;
      return { status: "completed", runId, profileId: live.profileId, result };
    }
    return { status: "needs_input", runId, profileId: live.profileId, request: pending.params };
  }

  private requireOwned(chatId: string, runId: string): TLiveRun {
    const live = this.runs.get(runId);
    if (live === undefined || live.chatId !== chatId) {
      throw new Error("Unknown MCP run");
    }
    return live;
  }

  private resetChanged(live: TLiveRun): void {
    live.changed = new Promise<void>((resolve) => {
      live.notifyChanged = resolve;
    });
  }

  private clearTimeout(live: TLiveRun): void {
    if (live.timeout !== undefined) {
      clearTimeout(live.timeout);
      live.timeout = undefined;
    }
  }

  private async finish(runId: string, live: TLiveRun): Promise<void> {
    if (live.finishing === undefined) {
      live.finishing = (async () => {
        this.clearTimeout(live);
        if (this.runs.get(runId) === live) {
          this.runs.delete(runId);
        }
        const pending = live.pending;
        if (pending !== undefined) {
          live.pending = undefined;
          pending.resolve({ action: "cancel" });
        }
        await live.close();
      })();
    }
    await live.finishing;
  }
}
