import { afterEach, describe, expect, test } from "bun:test";
import { fetchTextWithLimit } from "./http";

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

describe("fetchTextWithLimit", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("times out while reading slow response bodies", async () => {
    globalThis.fetch = (async () =>
      new Response(createSlowBody(), {
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch;

    const startedAt = performance.now();

    await expect(
      fetchTextWithLimit({
        url: "https://example.com/slow",
        timeoutMs: 50,
        maxBytes: 5_000,
      }),
    ).rejects.toThrow("Request timed out");

    expect(performance.now() - startedAt).toBeLessThan(300);
  });
});

function createSlowBody(): ReadableStream<Uint8Array> {
  let sent = 0;
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent === 0) {
        controller.enqueue(encoder.encode("a"));
        sent += 1;
        return;
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      });

      if (cancelled) {
        return;
      }

      controller.enqueue(encoder.encode("b"));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
}
