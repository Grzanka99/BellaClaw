import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLogger, EBehaviorLogLevel } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { createLogViewerApp, type TLogViewerApplication } from "./app";

let application: TOption<TLogViewerApplication>;
let tempDir: TOption<string>;

afterEach(async () => {
  await application?.close();

  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
  }

  application = undefined;
  tempDir = undefined;
});

describe("log viewer", () => {
  test("serves htmx from the viewer workspace dependency", async () => {
    const application = createLogViewerApp({ dbPath: ":memory:" });

    try {
      const response = await application.app.request("/assets/htmx.min.js");

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("htmx");
    } finally {
      await application.close();
    }
  });

  test("shows a missing database without creating it", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bellaclaw-log-viewer-"));
    const dbPath = join(tempDir, "missing.db");
    application = createLogViewerApp({ dbPath });

    const page = await application.app.request("/");
    const health = await application.app.request("/health");

    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Behavior log database not found");
    expect(health.status).toBe(503);
    expect(await Bun.file(dbPath).exists()).toBe(false);
  });

  test("searches events and renders the log workspace", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bellaclaw-log-viewer-"));
    const dbPath = join(tempDir, "logs.db");
    const logger = new AppLogger({ dbPath, stdout() {} });

    for (let index = 0; index < 101; index += 1) {
      logger.record({
        trace: { turnId: "turn-searchable", chatId: undefined, platform: "discord" },
        event: "tool.finished",
        component: "ai",
        level: EBehaviorLogLevel.Info,
        toolName: "web-search",
        success: true,
        summary: `distinctive lookup ${index}`,
      });
    }

    await logger.flush();
    await logger.close();
    application = createLogViewerApp({ dbPath });

    const home = await application.app.request("/?q=distinctive&success=success");
    const homeHtml = await home.text();

    expect(homeHtml).toContain("distinctive lookup 100");
    expect(homeHtml).not.toContain("<h3>Prompt cache</h3>");
    expect(homeHtml).toContain(
      "q=distinctive&amp;range=all&amp;success=success&amp;turnId=turn-searchable",
    );
  });

  test("shows cache hits, cold requests, and unreported usage in the inspector", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bellaclaw-log-viewer-"));
    const dbPath = join(tempDir, "logs.db");
    const logger = new AppLogger({ dbPath, stdout() {} });
    const cases = [
      { turnId: "cache-hit", input: 100, cacheRead: 800, cacheWrite: 100, expected: "80.0%" },
      { turnId: "cache-cold", input: 1000, cacheRead: 0, cacheWrite: 0, expected: "0.0%" },
      { turnId: "cache-unknown", input: 0, cacheRead: 0, cacheWrite: 0, expected: "Not reported" },
    ];
    for (const item of cases) {
      const inputTokens = item.input + item.cacheRead + item.cacheWrite;
      let cacheHitPercent: number | null = null;
      if (inputTokens > 0) {
        cacheHitPercent = (item.cacheRead / inputTokens) * 100;
      }
      logger.record({
        trace: { turnId: item.turnId, chatId: undefined, platform: "discord" },
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
    await logger.close();
    application = createLogViewerApp({ dbPath });

    for (const item of cases) {
      for (const path of ["/", "/fragments/events"]) {
        const response = await application.app.request(`${path}?range=all&turnId=${item.turnId}`);
        const html = await response.text();
        expect(response.status).toBe(200);
        expect(html).toContain("<h3>Prompt cache</h3>");
        expect(html).toContain(`>${item.expected}</strong>`);
        expect(html).toContain("Cached tokens read");
        expect(html).toContain("Cache tokens written");
        expect(html).toContain("Uncached input tokens");
        expect(html).toContain("Output tokens");
      }
    }
  });
});
