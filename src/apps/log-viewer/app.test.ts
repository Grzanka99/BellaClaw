import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLogger, EBehaviorLogLevel } from "../../services/app-logger";
import type { TOption } from "../../types";
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

  test("searches events and renders a turn timeline", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bellaclaw-log-viewer-"));
    const dbPath = join(tempDir, "logs.db");
    const logger = new AppLogger({ dbPath, stdout() {} });

    logger.record({
      trace: { turnId: "turn-searchable", chatId: undefined, platform: "discord" },
      event: "tool.started",
      component: "ai",
      level: EBehaviorLogLevel.Info,
      toolName: "web-search",
      success: true,
      summary: "distinctive lookup started",
    });
    logger.record({
      trace: { turnId: "turn-searchable", chatId: undefined, platform: "discord" },
      event: "tool.finished",
      component: "ai",
      level: EBehaviorLogLevel.Info,
      toolName: "web-search",
      success: true,
      summary: "distinctive lookup finished",
    });

    for (let index = 0; index < 99; index += 1) {
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
    const turnRedirect = await application.app.request("/turns/turn-searchable");
    const styles = await application.app.request("/assets/styles.css");
    const script = await application.app.request("/assets/app.js");
    const homeHtml = await home.text();
    const stylesCss = await styles.text();
    const appJs = await script.text();

    expect(homeHtml).toContain("distinctive lookup finished");
    expect(homeHtml).toContain("turnId=turn-searchable");
    expect(homeHtml).not.toContain("/turns/turn-searchable");
    expect(turnRedirect.status).toBe(302);
    expect(turnRedirect.headers.get("location")).toBe("/?range=all&turnId=turn-searchable");
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
    expect(stylesCss).toContain("--background: #000000");
    expect(stylesCss).toContain(':root[data-theme="light"]');
    expect(stylesCss).toContain("clip-path: inset(50%)");
    expect(stylesCss).not.toContain("currentColor");
    expect(appJs).toContain("eventsList.scrollTop < 160");
    expect(appJs).not.toContain("window.scrollY");
    expect(appJs).toContain('if (root.id === "app-shell")');
    expect(appJs).toContain("delete document.documentElement.dataset.eventSelection");
  });
});
