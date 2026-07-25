import { afterEach, describe, expect, test } from "bun:test";
import { fetchTextWithLimit, validatePublicHttpUrl } from "./http";

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

  test("fails before DNS resolution when the pinned-path caller is already aborted", async () => {
    globalThis.fetch = originalFetch;
    const controller = new AbortController();
    controller.abort();
    const startedAt = performance.now();

    await expect(
      fetchTextWithLimit({
        url: "https://must-not-resolve.invalid/path",
        timeoutMs: 5_000,
        maxBytes: 5_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  test("caller cancellation wins while the pinned path is awaiting DNS", async () => {
    globalThis.fetch = originalFetch;
    const controller = new AbortController();
    const startedAt = performance.now();
    const pending = fetchTextWithLimit({
      url: `https://dns-cancel-${crypto.randomUUID()}.invalid/path`,
      timeoutMs: 5_000,
      maxBytes: 5_000,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow("aborted");
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  test("blocks redirects to non-public IP addresses", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;

      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:3000/admin" },
      });
    }) as unknown as typeof fetch;

    await expect(
      fetchTextWithLimit({
        url: "https://example.com/redirect",
        timeoutMs: 1_000,
        maxBytes: 5_000,
        followRedirects: true,
      }),
    ).rejects.toThrow("Private or reserved IP addresses are blocked");
    expect(requests).toBe(1);
  });
});

describe("validatePublicHttpUrl", () => {
  test.each([
    "http://0.0.0.0",
    "http://10.0.0.1",
    "http://100.64.0.1",
    "http://127.0.0.1",
    "http://127.1",
    "http://2130706433",
    "http://169.254.169.254/latest/meta-data",
    "http://172.16.0.1",
    "http://192.168.0.1",
    "http://[::1]",
    "http://[::ffff:127.0.0.1]",
    "http://[2001:db8::1]",
    "http://[fc00::1]",
    "http://[fe80::1]",
  ])("blocks non-public IP address %s", (url) => {
    expect(() => validatePublicHttpUrl(url)).toThrow(
      "Private or reserved IP addresses are blocked",
    );
  });

  test.each([
    "https://8.8.8.8/path",
    "https://[2606:4700:4700::1111]/path",
  ])("allows public IP address %s", (url) => {
    expect(validatePublicHttpUrl(url)).toBe(url);
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
