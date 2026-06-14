import { afterEach, describe, expect, mock, test } from "bun:test";
import { parseSignalReceiveMessage, SignalClient } from "./client";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalWebSocket = globalThis.WebSocket;

class TestWebSocket {
  public static sockets: TestWebSocket[] = [];
  public onopen: (() => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onclose: (() => void) | null = null;
  public closed = false;

  public constructor(public url: URL) {
    TestWebSocket.sockets.push(this);
  }

  public close() {
    this.closed = true;
  }
}

describe("parseSignalReceiveMessage", () => {
  test("parses direct text messages", () => {
    const result = parseSignalReceiveMessage(
      JSON.stringify({
        envelope: {
          sourceNumber: "+111",
          sourceName: "Alice",
          dataMessage: {
            message: "hello",
          },
        },
      }),
    );

    expect(result).toEqual({
      sourceNumber: "+111",
      sourceName: "Alice",
      message: "hello",
    });
  });

  test("falls back to source and profile name", () => {
    const result = parseSignalReceiveMessage(
      JSON.stringify({
        envelope: {
          source: "+222",
          sourceNumber: null,
          sourceName: null,
          profileName: "Bob",
          dataMessage: {
            message: "hello",
          },
        },
      }),
    );

    expect(result).toEqual({
      sourceNumber: "+222",
      sourceName: "Bob",
      message: "hello",
    });
  });

  test("ignores unsupported events", () => {
    expect(parseSignalReceiveMessage("not json")).toBeUndefined();
    expect(
      parseSignalReceiveMessage(
        JSON.stringify({
          envelope: {
            sourceNumber: "+111",
            dataMessage: {
              message: "hello",
              groupInfo: {},
            },
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseSignalReceiveMessage(
        JSON.stringify({
          envelope: {
            sourceNumber: "+111",
            dataMessage: {
              message: "   ",
            },
          },
        }),
      ),
    ).toBeUndefined();
  });
});

describe("SignalClient", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.WebSocket = originalWebSocket;
    TestWebSocket.sockets = [];
  });

  test("checks readiness through /v1/about", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new SignalClient({ baseUrl: "http://127.0.0.1:8080", phoneNumber: "+100" });

    await expect(client.checkReadiness()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(new URL("http://127.0.0.1:8080/v1/about"));
  });

  test("sends text with configured sender and recipient", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new SignalClient({ baseUrl: "http://127.0.0.1:8080", phoneNumber: "+100" });

    await client.sendText("+200", "hello");

    expect(fetchMock).toHaveBeenCalledWith(new URL("http://127.0.0.1:8080/v2/send"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: "hello",
        number: "+100",
        recipients: ["+200"],
      }),
    });
  });

  test("throws on send failure", async () => {
    const fetchMock = mock(async () => new Response("failed", { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new SignalClient({ baseUrl: "http://127.0.0.1:8080", phoneNumber: "+100" });

    await expect(client.sendText("+200", "hello")).rejects.toThrow(
      "Signal send failed with status 500",
    );
  });

  test("throws when send request fails", async () => {
    const fetchMock = mock(async () => {
      throw new Error("network down");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new SignalClient({ baseUrl: "http://127.0.0.1:8080", phoneNumber: "+100" });

    await expect(client.sendText("+200", "hello")).rejects.toThrow("network down");
  });

  test("returns unsubscribe after initial websocket open", async () => {
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;

    const client = new SignalClient({ baseUrl: "http://127.0.0.1:8080", phoneNumber: "+100" });
    const subscribePromise = client.subscribe(() => undefined);

    expect(TestWebSocket.sockets).toHaveLength(1);

    const socket = TestWebSocket.sockets[0];
    if (socket === undefined) {
      throw new Error("expected websocket");
    }
    expect(String(socket.url)).toBe("ws://127.0.0.1:8080/v1/receive/+100");

    socket.onopen?.();

    const unsubscribe = await subscribePromise;
    expect(unsubscribe).toBeDefined();

    unsubscribe?.();
    expect(socket.closed).toBe(true);
  });

  test("returns undefined when initial websocket closes before open", async () => {
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;

    const client = new SignalClient({ baseUrl: "http://127.0.0.1:8080", phoneNumber: "+100" });
    const subscribePromise = client.subscribe(() => undefined);

    const socket = TestWebSocket.sockets[0];
    if (socket === undefined) {
      throw new Error("expected websocket");
    }

    socket.onclose?.();

    await expect(subscribePromise).resolves.toBeUndefined();
    expect(socket.closed).toBe(true);
  });

  test("returns undefined when initial websocket errors before open", async () => {
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;

    const client = new SignalClient({ baseUrl: "http://127.0.0.1:8080", phoneNumber: "+100" });
    const subscribePromise = client.subscribe(() => undefined);

    const socket = TestWebSocket.sockets[0];
    if (socket === undefined) {
      throw new Error("expected websocket");
    }

    socket.onerror?.();

    await expect(subscribePromise).resolves.toBeUndefined();
    expect(socket.closed).toBe(true);
  });

  test("reconnects after websocket close until unsubscribed", async () => {
    let reconnect: (() => void) | undefined;
    const clearTimeoutMock = mock(() => undefined);

    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
    globalThis.setTimeout = mock((callback: () => void, delay: number) => {
      reconnect = callback;
      expect(delay).toBe(5000);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = clearTimeoutMock as unknown as typeof clearTimeout;

    const client = new SignalClient({ baseUrl: "http://127.0.0.1:8080", phoneNumber: "+100" });
    const subscribePromise = client.subscribe(() => undefined);

    expect(TestWebSocket.sockets).toHaveLength(1);

    const firstSocket = TestWebSocket.sockets[0];
    if (firstSocket === undefined) {
      throw new Error("expected first websocket");
    }

    firstSocket.onopen?.();

    const unsubscribe = await subscribePromise;
    expect(unsubscribe).toBeDefined();

    firstSocket.onclose?.();
    expect(globalThis.setTimeout).toHaveBeenCalledTimes(1);

    reconnect?.();
    expect(TestWebSocket.sockets).toHaveLength(2);

    const secondSocket = TestWebSocket.sockets[1];
    if (secondSocket === undefined) {
      throw new Error("expected second websocket");
    }

    unsubscribe?.();
    expect(clearTimeoutMock).toHaveBeenCalledWith(1);
    expect(secondSocket.closed).toBe(true);

    secondSocket.onclose?.();
    expect(globalThis.setTimeout).toHaveBeenCalledTimes(1);
  });

  test("handles async message handler failures", async () => {
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;

    const client = new SignalClient({ baseUrl: "http://127.0.0.1:8080", phoneNumber: "+100" });
    const onMessage = mock(async () => {
      throw new Error("handler failed");
    });
    const subscribePromise = client.subscribe(onMessage);

    const socket = TestWebSocket.sockets[0];
    if (socket === undefined) {
      throw new Error("expected websocket");
    }

    socket.onopen?.();

    const unsubscribe = await subscribePromise;
    socket.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          envelope: {
            sourceNumber: "+200",
            dataMessage: {
              message: "hello",
            },
          },
        }),
      }),
    );

    await Bun.sleep(0);

    expect(onMessage).toHaveBeenCalledTimes(1);
    unsubscribe?.();
  });

  test("handles binary websocket text frames", async () => {
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;

    const client = new SignalClient({ baseUrl: "http://127.0.0.1:8080", phoneNumber: "+100" });
    const onMessage = mock(() => undefined);
    const subscribePromise = client.subscribe(onMessage);

    const socket = TestWebSocket.sockets[0];
    if (socket === undefined) {
      throw new Error("expected websocket");
    }

    socket.onopen?.();

    const unsubscribe = await subscribePromise;
    socket.onmessage?.(
      new MessageEvent("message", {
        data: new TextEncoder().encode(
          JSON.stringify({
            envelope: {
              sourceNumber: "+200",
              dataMessage: {
                message: "hello",
              },
            },
          }),
        ),
      }),
    );

    expect(onMessage).toHaveBeenCalledWith({
      sourceNumber: "+200",
      sourceName: "+200",
      message: "hello",
    });
    unsubscribe?.();
  });
});
