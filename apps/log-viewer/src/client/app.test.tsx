/** @jsxImportSource hono/jsx/dom */

import { afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLogger } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { type HTMLElement, type HTMLInputElement, Window } from "happy-dom";
import { render } from "hono/jsx/dom";
import { createLogViewerApp, type TLogViewerApplication } from "../app";
import { App } from "./app";

const DOM_GLOBALS = [
  "window",
  "document",
  "location",
  "history",
  "localStorage",
  "navigator",
  "Element",
  "HTMLFormElement",
  "FormData",
  "IntersectionObserver",
  "matchMedia",
  "addEventListener",
  "removeEventListener",
  "scrollBy",
  "scrollY",
  "requestAnimationFrame",
  "fetch",
  "setTimeout",
] as const;

const realSetTimeout = globalThis.setTimeout;
let cleanup: TOption<() => Promise<void>>;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/* Renders the real client against the real Hono app; client timers are shortened to 10ms. */
function open(path: string, dbPath: string) {
  const window = new Window({ url: `http://localhost${path}` });
  const application: TLogViewerApplication = createLogViewerApp({ dbPath });
  const delays: number[] = [];
  const saved = new Map(
    DOM_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const globals: Record<(typeof DOM_GLOBALS)[number], unknown> = {
    window,
    document: window.document,
    location: window.location,
    history: window.history,
    localStorage: window.localStorage,
    navigator: window.navigator,
    Element: window.Element,
    HTMLFormElement: window.HTMLFormElement,
    FormData: window.FormData,
    IntersectionObserver: window.IntersectionObserver,
    matchMedia: window.matchMedia.bind(window),
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    scrollBy: window.scrollBy.bind(window),
    scrollY: 0,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    fetch: (input: string) => application.app.request(input),
    setTimeout: (handler: () => void, delay = 0) => {
      delays.push(delay);
      return realSetTimeout(handler, Math.min(delay, 10));
    },
  };

  for (const key of DOM_GLOBALS) {
    Object.defineProperty(globalThis, key, {
      value: globals[key],
      configurable: true,
      writable: true,
    });
  }

  const root = window.document.createElement("div");
  window.document.body.append(root);
  render(<App />, root as unknown as globalThis.HTMLElement);

  cleanup = async () => {
    render(<div />, root as unknown as globalThis.HTMLElement);
    await Bun.sleep(20);

    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, key);
      } else {
        Object.defineProperty(globalThis, key, descriptor);
      }
    }

    await application.close();
    await window.happyDOM.close();
  };

  return { window, document: window.document, delays };
}

function createLogger(): { dbPath: string; logger: AppLogger } {
  const tempDir = mkdtempSync(join(tmpdir(), "bellaclaw-log-viewer-client-"));
  const dbPath = join(tempDir, "logs.db");
  const logger = new AppLogger({ dbPath, stdout() {} });
  const previous = cleanup;
  cleanup = async () => {
    await previous?.();
    await logger.close();
    rmSync(tempDir, { recursive: true, force: true });
  };
  return { dbPath, logger };
}

function record(logger: AppLogger, turnId: string, event: string, summary: string) {
  logger.record({
    trace: { turnId, chatId: undefined, platform: "discord" },
    event,
    component: "ai",
    toolName: "web-search",
    success: true,
    summary,
  });
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) {
      return;
    }

    await Bun.sleep(5);
  }

  throw new Error("Timed out waiting for the viewer");
}

function count(document: Window["document"]): TOption<string> {
  return document.querySelector(".results-title strong")?.textContent;
}

test("filters through pivot links, chips, and the search form without reloading", async () => {
  const { dbPath, logger } = createLogger();
  record(logger, "turn-a", "tool.finished", "alpha lookup");
  record(logger, "turn-b", "model.request.completed", "beta request");
  await logger.flush();
  const { window, document } = open("/?range=all", dbPath);

  await waitFor(() => count(document) === "2 events");
  document.querySelector<HTMLElement>('a[title="Filter by event: tool.finished"]')?.click();
  await waitFor(() => count(document) === "1 events");

  expect(window.location.search).toBe("?range=all&event=tool.finished");
  expect(document.body.textContent).not.toContain("beta request");

  document.querySelector<HTMLElement>(".filter-chip")?.click();
  await waitFor(() => count(document) === "2 events");
  const search = document.querySelector<HTMLInputElement>('input[name="q"]');
  assert(search);
  search.value = "beta";
  document
    .querySelector(".search-panel")
    ?.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await waitFor(() => count(document) === "1 events");

  expect(window.location.search).toBe("?q=beta&range=all");
  expect(document.body.textContent).toContain("beta request");
});

test("live mode keeps polling every 5 seconds and preserves selection and drafts", async () => {
  const { dbPath, logger } = createLogger();
  record(logger, "turn-live", "tool.finished", "first");
  await logger.flush();
  const { document, delays } = open("/?live=1&range=all", dbPath);

  await waitFor(() => count(document) === "1 events");
  const selected = document.querySelector<HTMLElement>('[data-event-id="1"]');
  assert(selected);
  selected.click();
  const search = document.querySelector<HTMLInputElement>('input[name="q"]');
  assert(search);
  search.value = "draft";
  await waitFor(() => delays.filter((delay) => delay === 5_000).length >= 3);

  record(logger, "turn-live", "tool.finished", "second");
  record(logger, "turn-live", "tool.finished", "third");
  await logger.flush();
  await waitFor(() => count(document) === "3 events");
  record(logger, "turn-new", "tool.finished", "fourth");
  await logger.flush();
  await waitFor(() => count(document) === "4 events");
  await waitFor(() => document.querySelector(".turn-list code")?.textContent === "turn-new");

  expect([...document.querySelectorAll("[data-event-id]")].map((row) => row.textContent)).toEqual([
    expect.stringContaining("fourth"),
    expect.stringContaining("third"),
    expect.stringContaining("second"),
    expect.stringContaining("first"),
  ]);
  expect(document.querySelector('[data-event-id="1"]')).toBe(selected);
  expect(selected.getAttribute("aria-current")).toBe("true");
  expect(document.querySelector(".event-inspector.open")?.textContent).toContain("first");
  expect(search.value).toBe("draft");
});

test("loads older events on demand", async () => {
  const { dbPath, logger } = createLogger();

  for (let index = 0; index < 150; index += 1) {
    record(logger, "turn-many", "tool.finished", `event ${index}`);
  }

  await logger.flush();
  const { document } = open("/?range=all", dbPath);

  await waitFor(() => count(document) === "100 events");
  document.querySelector<HTMLElement>(".load-more button")?.click();
  await waitFor(() => count(document) === "150 events");

  expect(document.querySelector(".result-end")?.textContent).toBe("End of loaded results");
});

test("drops an older page that lands after navigating away", async () => {
  const { dbPath, logger } = createLogger();

  for (let index = 0; index < 150; index += 1) {
    record(logger, "turn-many", "tool.finished", `event ${index}`);
  }

  record(logger, "turn-other", "tool.finished", "other turn");
  await logger.flush();
  const { document } = open("/?range=all", dbPath);
  await waitFor(() => count(document) === "100 events");
  const request = globalThis.fetch;
  let releaseOlderPage = () => {};
  const olderPageHeld = new Promise<void>((resolve) => {
    releaseOlderPage = resolve;
  });
  globalThis.fetch = (async (input: string) => {
    if (input.includes("beforeId=")) {
      await olderPageHeld;
    }

    return request(input);
  }) as typeof fetch;

  document.querySelector<HTMLElement>(".load-more button")?.click();
  document.querySelector<HTMLElement>('a[href*="turnId=turn-other"]')?.click();
  await waitFor(() => count(document) === "1 events");
  releaseOlderPage();
  await Bun.sleep(50);

  expect(count(document)).toBe("1 events");
});

test("shows cache hits, cold requests, and unreported usage in the inspector", async () => {
  const { dbPath, logger } = createLogger();
  const cases = [
    { input: 100, cacheRead: 800, cacheWrite: 100, expected: "80.0%" },
    { input: 1000, cacheRead: 0, cacheWrite: 0, expected: "0.0%" },
    { input: 0, cacheRead: 0, cacheWrite: 0, expected: "Not reported" },
  ];

  for (const item of cases) {
    const inputTokens = item.input + item.cacheRead + item.cacheWrite;
    let cacheHitPercent: number | null = null;

    if (inputTokens > 0) {
      cacheHitPercent = (item.cacheRead / inputTokens) * 100;
    }

    logger.record({
      trace: { turnId: "cache", chatId: undefined, platform: "discord" },
      event: "model.request.completed",
      component: "agent-harness",
      success: true,
      metadata: {
        input: item.input,
        output: 20,
        cacheRead: item.cacheRead,
        cacheWrite: item.cacheWrite,
        inputTokens,
        cacheHitPercent,
      },
    });
  }

  await logger.flush();
  const { document } = open("/?range=all", dbPath);
  await waitFor(() => count(document) === "3 events");

  for (const [index, item] of cases.entries()) {
    document.querySelector<HTMLElement>(`[data-event-id="${index + 1}"]`)?.click();
    await waitFor(
      () =>
        document.querySelector('[aria-current="true"]')?.getAttribute("data-event-id") ===
        String(index + 1),
    );
    const inspector = document.querySelector(".event-inspector")?.innerHTML ?? "";

    expect(inspector).toContain("<h3>Prompt cache</h3>");
    expect(inspector).toContain(`>${item.expected}</strong>`);
    expect(inspector).toContain("Cached tokens read");
    expect(inspector).toContain("Uncached input tokens");
  }
});

test("retries a missing database until it appears", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "bellaclaw-log-viewer-client-"));
  const dbPath = join(tempDir, "logs.db");
  const { document } = open("/", dbPath);

  await waitFor(() => document.body.textContent?.includes("database not found") === true);
  const logger = new AppLogger({ dbPath, stdout() {} });
  record(logger, "turn-late", "tool.finished", "late arrival");
  await logger.close();
  await waitFor(() => count(document) === "1 events");

  expect(document.body.textContent).toContain("late arrival");
  rmSync(tempDir, { recursive: true, force: true });
});
