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
    expect(homeHtml).toContain('class="event-inspector"');
    expect(homeHtml).toContain('data-event-selectable="true"');
    expect(homeHtml).toContain("Filter to this turn");
    expect(homeHtml).toContain("+ More filters");
    expect(homeHtml).toContain("data-theme-toggle");
    expect(homeHtml.indexOf("bellaclaw-log-viewer-theme")).toBeLessThan(
      homeHtml.indexOf("/assets/styles.css"),
    );
    expect(homeHtml).toContain('localStorage.getItem("bellaclaw-log-viewer-theme")');
    expect(homeHtml).toContain('data-copy-current-event="true"');
    expect(homeHtml).toContain("data-event-json=");
    expect(homeHtml).toContain(
      "q=distinctive&amp;range=all&amp;success=success&amp;turnId=turn-searchable",
    );
    expect(homeHtml).toContain('hx-trigger="click, intersect once root:#events-list"');
  });
});
