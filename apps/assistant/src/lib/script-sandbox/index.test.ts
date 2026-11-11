import { describe, expect, test } from "bun:test";
import { runScript, type TRunScriptArgs, type TScriptFetcher } from "./index";

const ORIGIN = "https://api.example.com";

const fakeFetcher: TScriptFetcher = async (url) => {
  if (url.endsWith("/broken")) {
    return { url, status: 200, contentType: "text/plain", text: "not json" };
  }

  if (url.endsWith("/redirect")) {
    return {
      url: "https://evil.example.org/landing",
      status: 200,
      contentType: "text/plain",
      text: "x",
    };
  }

  return { url, status: 200, contentType: "application/json", text: '{"temp":21}' };
};

function run(source: string, overrides: Partial<TRunScriptArgs> = {}) {
  return runScript({
    source,
    config: { city: "Warsaw" },
    state: undefined,
    now: new Date("2026-01-02T03:04:05.000Z"),
    timezone: "Europe/Warsaw",
    allowedOrigins: [ORIGIN],
    maxOutputBytes: 10_000,
    fetcher: fakeFetcher,
    ...overrides,
  });
}

function expectError(result: Awaited<ReturnType<typeof runScript>>): string {
  if (result.ok) {
    throw new Error(`expected failure, got ${JSON.stringify(result.outcome)}`);
  }

  return result.error;
}

describe("runScript", () => {
  test("returns data outcome with state and sees ctx", async () => {
    const result = await run(
      `export default async function run(ctx, host) {
        const weather = await host.fetchJson("${ORIGIN}/weather");
        return { kind: "data", data: { weather, ctx }, state: { count: (ctx.state?.count ?? 0) + 1 } };
      }`,
      { state: { count: 4 } },
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: {
        kind: "data",
        data: {
          weather: { temp: 21 },
          ctx: {
            config: { city: "Warsaw" },
            state: { count: 4 },
            now: "2026-01-02T03:04:05.000Z",
            timezone: "Europe/Warsaw",
          },
        },
      },
      state: { count: 5 },
      fetches: [{ url: `${ORIGIN}/weather`, status: 200, bytes: 11, error: undefined }],
    });
  });

  test("returns text outcome via fetchText", async () => {
    const result = await run(
      `export default async function run(ctx, host) {
        const response = await host.fetchText("${ORIGIN}/a");
        return { kind: "text", text: response.status + " " + response.contentType + " " + response.text };
      }`,
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: { kind: "text", text: '200 application/json {"temp":21}' },
      state: undefined,
    });
  });

  test("returns silent outcome from a sync function", async () => {
    const result = await run("export default function run() { return { kind: 'silent' }; }");

    expect(result).toMatchObject({ ok: true, outcome: { kind: "silent" }, state: undefined });
  });

  test("reports thrown errors", async () => {
    const result = await run(
      "export default async function run() {\n  throw new Error('boom');\n}",
    );

    expect(expectError(result)).toContain("Error: boom");
  });

  test("reports syntax errors and missing default export", async () => {
    expect(expectError(await run("export default async function run( {"))).toContain("SyntaxError");
    expect(expectError(await run("export const x = 1;"))).toContain("default export");
  });

  test("reports deep recursion as a stack overflow without crashing the worker", async () => {
    const result = await run(
      "export default async function run() { const f = (n) => f(n + 1) + 1; return { kind: 'text', text: String(f(0)) }; }",
    );

    expect(expectError(result)).toContain("stack overflow");
  });

  test("rejects a return value whose serialization is not JSON", async () => {
    const result = await run(
      "export default async function run() { JSON.stringify = () => '{'; return { kind: 'silent' }; }",
    );

    expect(expectError(result)).toContain("invalid return value");
  });

  test("rejects invalid return shape", async () => {
    expect(
      expectError(await run("export default async () => ({ kind: 'text', text: 42 })")),
    ).toContain("invalid return value");
    expect(expectError(await run("export default async () => {}"))).toContain(
      "invalid return value",
    );
  });

  test("rejects too large output", async () => {
    const error = expectError(
      await run("export default async () => ({ kind: 'text', text: 'x'.repeat(200) })", {
        maxOutputBytes: 100,
      }),
    );

    expect(error).toMatch(/^output too large \(\d+ bytes > cap 100 bytes\)$/);
  });

  test("rejects too large state", async () => {
    const error = expectError(
      await run("export default async () => ({ kind: 'silent', state: 'x'.repeat(20000) })"),
    );

    expect(error).toContain("state too large");
  });

  test("rejects disallowed origins before fetching", async () => {
    let called = false;
    const result = await run(
      `export default async function run(ctx, host) {
        try {
          await host.fetchText("https://evil.example.org/x");
        } catch (error) {
          return { kind: "text", text: error.message };
        }
        return { kind: "silent" };
      }`,
      {
        fetcher: async (url) => {
          called = true;
          return { url, status: 200, contentType: "", text: "" };
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: { kind: "text", text: "origin not allowed: https://evil.example.org" },
      fetches: [
        {
          url: "https://evil.example.org/x",
          status: undefined,
          error: "origin not allowed: https://evil.example.org",
        },
      ],
    });
    expect(called).toBe(false);
  });

  test("rejects redirects to disallowed origins", async () => {
    const error = expectError(
      await run(
        `export default async (ctx, host) => { await host.fetchText("${ORIGIN}/redirect"); return { kind: "silent" }; }`,
      ),
    );

    expect(error).toContain("redirected to origin not allowed: https://evil.example.org");
  });

  test("fetchJson throws on invalid JSON", async () => {
    const error = expectError(
      await run(
        `export default async (ctx, host) => { await host.fetchJson("${ORIGIN}/broken"); return { kind: "silent" }; }`,
      ),
    );

    expect(error).toContain(`invalid JSON from ${ORIGIN}/broken`);
  });

  test("enforces maxFetches", async () => {
    const result = await run(
      `export default async (ctx, host) => {
        for (let i = 0; i < 20; i++) {
          await host.fetchText("${ORIGIN}/" + i);
        }
        return { kind: "silent" };
      }`,
      { limits: { maxFetches: 3 } },
    );

    expect(expectError(result)).toContain("fetch limit exceeded (max 3 per run)");
    expect(result.fetches).toHaveLength(3);
  });

  test("does not log fetches rejected by maxFetches", async () => {
    const result = await run(
      `export default async (ctx, host) => {
        for (let i = 0; i < 1000; i++) {
          host.fetchText("${ORIGIN}/" + i).catch(() => {});
        }
        return { kind: "silent" };
      }`,
      { limits: { maxFetches: 3 } },
    );

    expect(result.fetches.length).toBeLessThanOrEqual(3);
  });

  test("stops infinite loops at the cpu limit", async () => {
    const startedAt = performance.now();
    const error = expectError(
      await run("export default async () => { while (true) {} }", { limits: { cpuMs: 200 } }),
    );

    expect(error).toBe("cpu time limit exceeded (200 ms)");
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  });

  test("cpu limit cannot be caught by the script", async () => {
    const error = expectError(
      await run("export default async () => { for (;;) { try { while (true) {} } catch {} } }", {
        limits: { cpuMs: 200 },
      }),
    );

    expect(error).toBe("cpu time limit exceeded (200 ms)");
  });

  test("enforces wall time limit", async () => {
    const error = expectError(
      await run(
        `export default async (ctx, host) => { await host.fetchText("${ORIGIN}/slow"); return { kind: "silent" }; }`,
        {
          limits: { wallMs: 300 },
          fetcher: () => new Promise(() => undefined),
        },
      ),
    );

    expect(error).toBe("wall time limit exceeded (300 ms)");
  });

  test("stops memory bombs", async () => {
    const error = expectError(
      await run(
        "export default async () => { const a = []; while (true) { a.push({ n: a.length }); } }",
        {
          limits: { memoryBytes: 16 * 1024 * 1024 },
        },
      ),
    );

    expect(error).toContain("out of memory");
  });

  test("respects abort signal", async () => {
    const controller = new AbortController();
    const pending = run("export default async () => { while (true) {} }", {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);

    expect(expectError(await pending)).toBe("aborted");
  });

  test("does not expose host globals or module imports", async () => {
    const result = await run(
      `export default async () => ({
        kind: "data",
        data: [typeof fetch, typeof Bun, typeof process, typeof require, typeof console, typeof setTimeout, typeof fetchTextRaw],
      })`,
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: { kind: "data", data: Array(7).fill("undefined") },
    });
    expect(
      expectError(
        await run("import fs from 'fs'; export default async () => ({ kind: 'silent' })"),
      ),
    ).toBeString();
  });

  test("finishes cleanly when the script returns with a fetch still pending", async () => {
    const result = await run(
      `export default async (ctx, host) => {
        host.fetchText("${ORIGIN}/slow").catch(() => undefined);
        return { kind: "silent" };
      }`,
      { fetcher: () => new Promise(() => undefined) },
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: { kind: "silent" },
      fetches: [{ url: `${ORIGIN}/slow`, error: "cancelled" }],
    });
  });

  test("captures and caps logs", async () => {
    const result = await run(
      `export default async (ctx, host) => {
        host.log("hello", 42, { a: 1 }, null);
        host.log("y".repeat(1000));
        for (let i = 0; i < 100; i++) {
          host.log("line " + i);
        }
        return { kind: "silent" };
      }`,
      { limits: { maxLogLines: 5 } },
    );

    expect(result.logs[0]).toBe('hello 42 {"a":1} null');
    expect(result.logs[1]).toHaveLength(501);
    expect(result.logs).toHaveLength(6);
    expect(result.logs[5]).toContain("log limit of 5 lines reached");
  });
});
