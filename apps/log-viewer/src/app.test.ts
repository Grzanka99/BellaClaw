import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppLogger,
  EBehaviorLogLevel,
  type TLogLiveUpdate,
  type TLogReaderResult,
} from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { createLogViewerApp, type TLogViewerApplication } from "./app";
import type { TLogViewerPage } from "./types";

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

function createLogger(): { dbPath: string; logger: AppLogger } {
  tempDir = mkdtempSync(join(tmpdir(), "bellaclaw-log-viewer-"));
  const dbPath = join(tempDir, "logs.db");
  return { dbPath, logger: new AppLogger({ dbPath, stdout() {} }) };
}

describe("log viewer", () => {
  test("serves the shell and a browser bundle without server-only modules", async () => {
    application = createLogViewerApp({ dbPath: ":memory:" });

    const shell = await application.app.request("/");
    const bundle = await application.app.request("/assets/client.js");
    const script = await bundle.text();

    expect(await shell.text()).toContain('<div id="root"></div>');
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("Content-Type")).toContain("javascript");
    expect(script).not.toContain("bun:sqlite");
    expect(script).not.toContain("zod/v4/locales");
  });

  test("reports a missing database without creating it", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bellaclaw-log-viewer-"));
    const dbPath = join(tempDir, "missing.db");
    application = createLogViewerApp({ dbPath });

    const page = await application.app.request("/api/logs");
    const body: TLogReaderResult<TLogViewerPage> = await page.json();
    const health = await application.app.request("/health");

    expect(page.status).toBe(503);
    expect(body.success).toBe(false);
    expect(JSON.stringify(body)).toContain("Behavior log database not found");
    expect(health.status).toBe(503);
    expect(await Bun.file(dbPath).exists()).toBe(false);
  });

  test("searches events and pages through older results", async () => {
    const { dbPath, logger } = createLogger();

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

    await logger.close();
    application = createLogViewerApp({ dbPath });

    const first = await application.app.request("/api/logs?q=distinctive&success=success");
    const firstBody: TLogReaderResult<TLogViewerPage> = await first.json();

    expect(firstBody.success).toBe(true);

    if (!firstBody.success) {
      return;
    }

    const page = firstBody.data.page;
    const last = page.events[page.events.length - 1];
    expect(firstBody.data.query.q).toBe("distinctive");
    expect(page.events[0]?.summary).toBe("distinctive lookup 100");
    expect(page.events).toHaveLength(100);
    expect(page.hasMore).toBe(true);

    const older = await application.app.request(
      `/api/logs?q=distinctive&success=success&until=${firstBody.data.query.until}&beforeCreatedAt=${last?.createdAtMs}&beforeId=${last?.id}`,
    );
    const olderBody: TLogReaderResult<TLogViewerPage> = await older.json();

    expect(olderBody.success && olderBody.data.page.events.map((event) => event.summary)).toEqual([
      "distinctive lookup 0",
    ]);
    expect(olderBody.success && olderBody.data.page.hasMore).toBe(false);
  });

  test("live endpoint delivers every new matching event across batches", async () => {
    const { dbPath, logger } = createLogger();

    try {
      logger.record({
        trace: { turnId: "live", chatId: undefined, platform: "discord" },
        event: "tool.finished",
        component: "ai",
      });
      await logger.flush();
      application = createLogViewerApp({ dbPath });
      const home = await application.app.request("/api/logs?live=1&range=all&event=tool.finished");
      const homeBody: TLogReaderResult<TLogViewerPage> = await home.json();
      expect(homeBody.success).toBe(true);

      if (!homeBody.success) {
        return;
      }

      let cursor = homeBody.data.page.events[0];

      for (let index = 0; index < 205; index += 1) {
        logger.record({
          trace: { turnId: "live", chatId: undefined, platform: "discord" },
          event: "tool.finished",
          component: "ai",
        });
      }
      logger.record({
        trace: { turnId: "live", chatId: undefined, platform: "discord" },
        event: "model.request.completed",
        component: "ai",
      });
      await logger.flush();

      const ids: number[] = [];

      for (const expectedCount of [100, 100, 5, 0]) {
        const response = await application.app.request(
          `/api/logs/new?live=1&range=all&event=tool.finished&afterCreatedAt=${cursor?.createdAtMs}&afterId=${cursor?.id}`,
        );
        const body: TLogReaderResult<TLogLiveUpdate> = await response.json();
        expect(body.success).toBe(true);

        if (!body.success) {
          return;
        }

        const batch = body.data.events.map((event) => event.id);
        expect(batch).toHaveLength(expectedCount);
        expect(batch).toEqual([...batch].sort((a, b) => b - a));
        ids.push(...batch);
        expect(body.data.recentTurns[0]?.turnId).toBe("live");
        cursor = body.data.events[0] ?? cursor;
      }

      expect(ids.sort((a, b) => a - b)).toEqual(
        Array.from({ length: 205 }, (_, index) => index + 2),
      );
    } finally {
      await logger.close();
    }
  });

  test("live endpoint rejects a missing cursor", async () => {
    application = createLogViewerApp({ dbPath: ":memory:" });

    const response = await application.app.request("/api/logs/new?live=1");

    expect(response.status).toBe(400);
  });
});
