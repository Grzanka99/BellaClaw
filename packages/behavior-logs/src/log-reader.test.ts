import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TOption } from "@bellaclaw/shared";
import { AppLogger } from "./app-logger";
import { LogReader } from "./log-reader";
import type { TBehaviorMetadata } from "./types";

let tempDir: TOption<string>;

afterEach(() => {
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
  }

  tempDir = undefined;
});

describe("LogReader diagnostics", () => {
  test("aggregates all model calls in completed conversational turns with usage coverage", async () => {
    const context = createContext();
    recordBoundary(context.logger, "outside-window", "message.received");
    context.logger.record({
      trace: { turnId: "outside-window", chatId: context.chatId, platform: "discord" },
      event: "model.request.completed",
      component: "agent-harness",
      metadata: { cacheRead: 10_000, inputTokens: 10_000 },
    });
    recordBoundary(context.logger, "outside-window", "handler.completed");
    await Bun.sleep(3);
    const cases: { turnId: string; metadata: TBehaviorMetadata }[] = [
      { turnId: "valid", metadata: { cacheRead: 150, inputTokens: 100, agentName: "main" } },
      { turnId: "zero", metadata: { cacheRead: 0, inputTokens: 0, agentName: "memory" } },
      { turnId: "missing", metadata: { agentName: "browser" } },
    ];

    for (const item of cases) {
      recordBoundary(context.logger, item.turnId, "message.received");
      context.logger.record({
        trace: { turnId: item.turnId, chatId: context.chatId, platform: "discord" },
        event: "model.request.completed",
        component: "agent-harness",
        metadata: item.metadata,
      });
      recordBoundary(context.logger, item.turnId, "handler.completed");
      await Bun.sleep(2);
    }

    for (let index = 0; index < 7; index += 1) {
      recordBoundary(context.logger, `no-model-${index}`, "message.received");
      recordBoundary(context.logger, `no-model-${index}`, "handler.completed");
      await Bun.sleep(2);
    }

    recordBoundary(context.logger, "current-diagnostic", "message.received");
    context.logger.record({
      trace: { turnId: "current-diagnostic", chatId: context.chatId, platform: "discord" },
      event: "model.request.completed",
      component: "agent-harness",
      metadata: { cacheRead: 10_000, inputTokens: 10_000 },
    });
    await context.logger.close();

    const result = await context.reader.readCacheHitRate({
      chatId: context.chatId,
      excludeTurnId: "current-diagnostic",
    });

    expect(result).toEqual({
      success: true,
      data: {
        completedTurnCount: 10,
        turnsWithModelRequests: 3,
        modelRequestCount: 3,
        modelRequestsWithUsage: 2,
        cacheReadTokens: 150,
        inputTokens: 100,
        cacheHitRatePercent: 150,
      },
    });
    await context.reader.close();
  });

  test("uses conversational boundaries for latency and keeps overlapping durations on a timeline", async () => {
    const context = createContext();
    recordBoundary(context.logger, "older", "message.received");
    recordBoundary(context.logger, "older", "handler.completed");
    await Bun.sleep(3);
    recordBoundary(context.logger, "latest", "message.received");
    await Bun.sleep(4);

    for (const agentName of ["memory", "browser"]) {
      context.logger.record({
        trace: { turnId: "latest", chatId: context.chatId, platform: "discord" },
        event: "model.request.completed",
        component: "agent-harness",
        durationMs: 100,
        metadata: { agentName, cacheRead: 0, inputTokens: 1 },
      });
    }

    await Bun.sleep(4);
    recordBoundary(context.logger, "latest", "handler.completed");
    await context.logger.close();

    const result = await context.reader.readLatestTurnLatency({
      chatId: context.chatId,
      excludeTurnId: undefined,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.turnId).toBe("latest");
      expect(result.data?.latencyMs).toBeGreaterThanOrEqual(4);
      expect(
        result.data?.timeline.filter((item) => item.event.event === "model.request.completed"),
      ).toHaveLength(2);
      expect(
        result.data?.timeline.filter((item) => item.event.event === "model.request.completed"),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ startOffsetMs: 0 }),
          expect.objectContaining({ startOffsetMs: 0 }),
        ]),
      );
    }
    await context.reader.close();
  });

  test("returns a null cache rate when reported and missing usage has no input tokens", async () => {
    const context = createContext();
    recordBoundary(context.logger, "zero", "message.received");
    context.logger.record({
      trace: { turnId: "zero", chatId: context.chatId, platform: "discord" },
      event: "model.request.completed",
      component: "agent-harness",
      metadata: { cacheRead: 0, inputTokens: 0 },
    });
    context.logger.record({
      trace: { turnId: "zero", chatId: context.chatId, platform: "discord" },
      event: "model.request.completed",
      component: "agent-harness",
      metadata: { agentName: "memory" },
    });
    recordBoundary(context.logger, "zero", "handler.completed");
    await context.logger.close();

    const result = await context.reader.readCacheHitRate({
      chatId: context.chatId,
      excludeTurnId: undefined,
    });

    expect(result).toEqual({
      success: true,
      data: {
        completedTurnCount: 1,
        turnsWithModelRequests: 1,
        modelRequestCount: 2,
        modelRequestsWithUsage: 1,
        cacheReadTokens: 0,
        inputTokens: 0,
        cacheHitRatePercent: null,
      },
    });
    await context.reader.close();
  });

  test("finds false-success and error-bearing failures while honoring the excluded turn", async () => {
    const context = createContext();
    context.logger.record({
      trace: { turnId: "false", chatId: context.chatId, platform: "discord" },
      event: "tool.completed",
      component: "tools",
      success: false,
    });
    context.logger.record({
      trace: { turnId: "error", chatId: context.chatId, platform: "discord" },
      event: "tool.completed",
      component: "tools",
      success: true,
      error: "reported error",
    });
    context.logger.record({
      trace: { turnId: "excluded", chatId: context.chatId, platform: "discord" },
      event: "tool.completed",
      component: "tools",
      success: false,
    });
    await context.logger.close();

    const result = await context.reader.readRecentFailures({
      sinceMs: Date.now() - 60_000,
      limit: 50,
      excludeTurnId: "excluded",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.map((event) => event.turnId).sort()).toEqual(["error", "false"]);
    }
    await context.reader.close();
  });

  test("freezes diagnostic queries at the excluded turn start", async () => {
    const context = createContext();
    recordBoundary(context.logger, "before", "message.received");
    context.logger.record({
      trace: { turnId: "before", chatId: context.chatId, platform: "discord" },
      event: "model.request.completed",
      component: "agent-harness",
      metadata: { cacheRead: 25, inputTokens: 100 },
    });
    context.logger.record({
      trace: { turnId: "before", chatId: context.chatId, platform: "discord" },
      event: "tool.completed",
      component: "tools",
      success: false,
    });
    recordBoundary(context.logger, "before", "handler.completed");
    recordBoundary(context.logger, "diagnostic", "message.received");
    recordBoundary(context.logger, "later", "message.received");
    context.logger.record({
      trace: { turnId: "later", chatId: context.chatId, platform: "discord" },
      event: "model.request.completed",
      component: "agent-harness",
      metadata: { cacheRead: 100, inputTokens: 100 },
    });
    context.logger.record({
      trace: { turnId: "later", chatId: context.chatId, platform: "discord" },
      event: "tool.completed",
      component: "tools",
      success: false,
    });
    recordBoundary(context.logger, "later", "handler.completed");
    await context.logger.close();

    const latency = await context.reader.readLatestTurnLatency({
      chatId: context.chatId,
      excludeTurnId: "diagnostic",
    });
    const cache = await context.reader.readCacheHitRate({
      chatId: context.chatId,
      excludeTurnId: "diagnostic",
    });
    const failures = await context.reader.readRecentFailures({
      sinceMs: Date.now() - 60_000,
      limit: 50,
      excludeTurnId: "diagnostic",
    });

    expect(latency.success && latency.data?.turnId).toBe("before");
    expect(cache).toEqual({
      success: true,
      data: {
        completedTurnCount: 1,
        turnsWithModelRequests: 1,
        modelRequestCount: 1,
        modelRequestsWithUsage: 1,
        cacheReadTokens: 25,
        inputTokens: 100,
        cacheHitRatePercent: 25,
      },
    });
    expect(failures.success && failures.data.map((event) => event.turnId)).toEqual(["before"]);
    await context.reader.close();
  });

  test("returns complete turns with more than one page of events", async () => {
    const context = createContext();

    for (let index = 0; index < 105; index += 1) {
      context.logger.record({
        trace: { turnId: "large-turn", chatId: context.chatId, platform: "discord" },
        event: "tool.completed",
        component: "tools",
        metadata: { index },
      });
    }

    await context.logger.close();
    const result = await context.reader.readTurn("large-turn");

    expect(result.success && result.data).toHaveLength(105);
    await context.reader.close();
  });
});

function createContext() {
  tempDir = mkdtempSync(join(tmpdir(), "bellaclaw-log-reader-"));
  const dbPath = join(tempDir, "logs.db");
  return {
    chatId: "discord:diagnostic-chat",
    logger: new AppLogger({ dbPath, stdout() {} }),
    reader: new LogReader(dbPath),
  };
}

function recordBoundary(logger: AppLogger, turnId: string, event: string) {
  logger.record({
    trace: { turnId, chatId: "discord:diagnostic-chat", platform: "discord" },
    event,
    component: "messaging",
  });
}
