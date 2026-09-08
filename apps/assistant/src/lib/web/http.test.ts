import { describe, expect, mock, test } from "bun:test";
import { fetchTextWithLimit, validatePublicHttpUrl } from "./http";

const encoder = new TextEncoder();

describe("fetchTextWithLimit", () => {
  test("times out while reading slow response bodies", async () => {
    const request = async () =>
      new Response(createSlowBody(), {
        headers: { "content-type": "text/plain" },
      });

    const startedAt = performance.now();

    await expect(
      fetchTextWithLimit(
        {
          url: "https://example.com/slow",
          timeoutMs: 50,
          maxBytes: 5_000,
        },
        { lookup: async () => [{ address: "93.184.216.34" }], request },
      ),
    ).rejects.toThrow("Request timed out");

    expect(performance.now() - startedAt).toBeLessThan(300);
  });

  test("fails before DNS resolution when the pinned-path caller is already aborted", async () => {
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
    const request = async () => {
      requests += 1;

      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:3000/admin" },
      });
    };

    await expect(
      fetchTextWithLimit(
        {
          url: "https://example.com/redirect",
          timeoutMs: 1_000,
          maxBytes: 5_000,
          followRedirects: true,
        },
        { lookup: async () => [{ address: "93.184.216.34" }], request },
      ),
    ).rejects.toThrow("Private or reserved IP addresses are blocked");
    expect(requests).toBe(1);
  });
  test("validates every resolved redirect address before making a request", async () => {
    const lookup = mock(async (hostname: string) => {
      if (hostname === "private.example") {
        return [{ address: "127.0.0.1" }];
      }
      return [{ address: "93.184.216.34" }];
    });
    const request = mock(
      async (_args: { resolved: { href: string; address: string } }) =>
        new Response(null, {
          status: 302,
          headers: { location: "https://private.example/admin" },
        }),
    );

    await expect(
      fetchTextWithLimit(
        {
          url: "https://public.example/start",
          timeoutMs: 1_000,
          maxBytes: 5_000,
          followRedirects: true,
        },
        { lookup, request },
      ),
    ).rejects.toThrow("Hostname resolves to a private or reserved IP address");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toEqual([
      expect.objectContaining({
        resolved: { href: "https://public.example/start", address: "93.184.216.34" },
      }),
    ]);
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
