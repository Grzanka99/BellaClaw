import { describe, expect, test } from "bun:test";
import type { ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import { ConnectorRunRegistry } from "./runs";

const request: ElicitRequest["params"] = {
  mode: "form",
  message: "Which folder?",
  requestedSchema: {
    type: "object",
    properties: { folder: { type: "string" } },
    required: ["folder"],
  },
};

describe("ConnectorRunRegistry", () => {
  test("resumes repeated questions on the same run and retains its transcript", async () => {
    const chatId = crypto.randomUUID();
    const transcript: string[] = [];
    let closes = 0;
    const first = await ConnectorRunRegistry.instance.start({
      chatId,
      connectorId: "files",
      inputTimeoutMs: 1_000,
      controller: new AbortController(),
      close: async () => {
        closes += 1;
      },
      run: async (_signal, elicit) => {
        const firstAnswer = await elicit(request, new AbortController().signal);
        transcript.push(JSON.stringify(firstAnswer));
        const secondAnswer = await elicit(
          { ...request, message: "Which filename?" },
          new AbortController().signal,
        );
        transcript.push(JSON.stringify(secondAnswer));
        return { text: transcript.join("|"), iterations: 3, toolCallCount: 2, stopReason: "done" };
      },
    });

    expect(first.status).toBe("needs_input");
    const second = await ConnectorRunRegistry.instance.resume(chatId, first.runId, {
      action: "accept",
      content: { folder: "docs" },
    });
    expect(second).toMatchObject({
      status: "needs_input",
      request: { message: "Which filename?" },
    });
    const completed = await ConnectorRunRegistry.instance.resume(chatId, first.runId, {
      action: "accept",
      content: { folder: "notes.txt" },
    });

    expect(completed).toMatchObject({
      status: "completed",
      result: { iterations: 3, toolCallCount: 2, stopReason: "done" },
    });
    expect(transcript).toEqual([
      JSON.stringify({ action: "accept", content: { folder: "docs" } }),
      JSON.stringify({ action: "accept", content: { folder: "notes.txt" } }),
    ]);
    expect(ConnectorRunRegistry.instance.list(chatId)).toEqual([]);
    expect(closes).toBe(1);
  });

  test("only the owning chat can resume or cancel a run", async () => {
    const chatId = crypto.randomUUID();
    let closes = 0;
    const status = await ConnectorRunRegistry.instance.start({
      chatId,
      connectorId: "files",
      inputTimeoutMs: 1_000,
      controller: new AbortController(),
      close: async () => {
        closes += 1;
      },
      run: async (_signal, elicit) => {
        await elicit(request, new AbortController().signal);
        return { text: "cancelled", iterations: 1, toolCallCount: 1, stopReason: "done" };
      },
    });

    expect(() =>
      ConnectorRunRegistry.instance.resume("another-chat", status.runId, { action: "decline" }),
    ).toThrow("Unknown connector run");
    expect(() => ConnectorRunRegistry.instance.cancel("another-chat", status.runId)).toThrow(
      "Unknown connector run",
    );
    await ConnectorRunRegistry.instance.cancel(chatId, status.runId);
    expect(ConnectorRunRegistry.instance.list(chatId)).toEqual([]);
    expect(closes).toBe(1);
  });

  test("cancels the resumed run when its caller is aborted", async () => {
    const chatId = crypto.randomUUID();
    let closes = 0;
    let runAborted = false;
    const status = await ConnectorRunRegistry.instance.start({
      chatId,
      connectorId: "files",
      inputTimeoutMs: 1_000,
      controller: new AbortController(),
      close: async () => {
        closes += 1;
      },
      run: async (signal, elicit) => {
        await elicit(request, signal);
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        runAborted = signal.aborted;
        return { text: undefined, iterations: 1, toolCallCount: 1, stopReason: "aborted" };
      },
    });
    const caller = new AbortController();
    const resumed = ConnectorRunRegistry.instance.resume(
      chatId,
      status.runId,
      { action: "accept", content: { folder: "docs" } },
      caller.signal,
    );

    await Bun.sleep(0);
    caller.abort();
    const completed = await resumed;

    expect(completed).toMatchObject({
      status: "completed",
      result: { stopReason: "aborted" },
    });
    expect(runAborted).toBe(true);
    expect(ConnectorRunRegistry.instance.list(chatId)).toEqual([]);
    expect(closes).toBe(1);
  });

  test("expires and closes an unanswered run without another registry call", async () => {
    const chatId = crypto.randomUUID();
    let closes = 0;
    await ConnectorRunRegistry.instance.start({
      chatId,
      connectorId: "files",
      inputTimeoutMs: 10,
      controller: new AbortController(),
      close: async () => {
        closes += 1;
      },
      run: async (_signal, elicit) => {
        await elicit(request, new AbortController().signal);
        return { text: undefined, iterations: 1, toolCallCount: 1, stopReason: "aborted" };
      },
    });

    await Bun.sleep(30);
    expect(ConnectorRunRegistry.instance.list(chatId)).toEqual([]);
    expect(closes).toBe(1);
  });

  test("settles and closes a run that fails after requesting input", async () => {
    const chatId = crypto.randomUUID();
    let rejectRun: (error: Error) => void = () => undefined;
    let closes = 0;
    await ConnectorRunRegistry.instance.start({
      chatId,
      connectorId: "files",
      inputTimeoutMs: 1_000,
      controller: new AbortController(),
      close: async () => {
        closes += 1;
      },
      run: async (_signal, elicit) => {
        void elicit(request, new AbortController().signal);
        await new Promise<void>((_resolve, reject) => {
          rejectRun = reject;
        });
        return { text: undefined, iterations: 1, toolCallCount: 1, stopReason: "error" };
      },
    });

    rejectRun(new Error("disconnected"));
    await Bun.sleep(0);
    expect(ConnectorRunRegistry.instance.list(chatId)).toEqual([]);
    expect(closes).toBe(1);
  });
});
