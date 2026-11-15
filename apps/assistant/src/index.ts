import { AppLogger, EBehaviorLogLevel } from "@bellaclaw/behavior-logs";
import { EEventType } from "@bellaclaw/database";
import { setupAiAuth } from "./services/ai/auth";
import { startAiOAuthKeepAlive } from "./services/ai/auth/oauth-keep-alive";
import { AuthorizationService } from "./services/authorization";
import { AutomationService } from "./services/automation";
import { CalendarService } from "./services/calendar";
import { Commands } from "./services/commands";
import { CronScheduler } from "./services/cron";
import { DiscordSingleton } from "./services/discord";
import { EventBus } from "./services/events";
import {
  setupInternalApi,
  startInternalApiServer,
  stopInternalApiServer,
} from "./services/internal-api";
import { McpService } from "./services/mcp";
import { setupMcpAuth, startMcpAuthServer, stopMcpAuthServer } from "./services/mcp/auth";
import { Memory } from "./services/memory";
import { FactDistiller } from "./services/memory/distill";
import { MessageHandler } from "./services/message-handler";
import { MessagingAdapter } from "./services/messaging";
import { Notices } from "./services/notices";
import { ScheduledDelivery } from "./services/scheduling/delivery";
import { SettingsService } from "./services/settings";
import { SignalSingleton } from "./services/signal";

async function init(): Promise<void> {
  const start = performance.now();
  const turnId = `boot:${crypto.randomUUID()}`;

  console.time("init");

  AppLogger.instance.record({
    trace: {
      turnId,
      chatId: undefined,
      platform: undefined,
    },
    event: "app.boot.start",
    component: "app",
    level: EBehaviorLogLevel.Info,
    summary: "Application boot started",
    metadata: {
      databaseMode: Bun.env.BELLACLAW_DATABASE_MODE ?? null,
      nodeEnv: Bun.env.NODE_ENV ?? null,
      signalEnabled: Bun.env.SIGNAL_ENABLED === "true",
    },
  });

  try {
    MessagingAdapter.instance.setup();
    Notices.instance.setup();
    Commands.instance.setup();
    ScheduledDelivery.instance.setup();
    CronScheduler.instance.subscribe();
    AutomationService.instance.setup();
    MessageHandler.instance.setup();
    Memory.instance.setup();
    FactDistiller.instance.setup();
    SettingsService.instance.setup();
    setupAiAuth();
    setupMcpAuth();
    McpService.instance.setup();
    setupInternalApi();
    if (Bun.env.BELLACLAW_MCP_PUBLIC_URL?.trim()) {
      startMcpAuthServer();
    }
    await AuthorizationService.instance.setup();
    await Promise.all([
      CalendarService.instance.setup(),
      DiscordSingleton.instance.setup(),
      SignalSingleton.instance.setup(),
    ]);
    await EventBus.instance.start();
    // after the bus: a command published before it starts is abandoned
    startInternalApiServer();
    await CronScheduler.instance.setup();
    await EventBus.instance.publish({
      type: EEventType.AppStarted,
      source: "app",
      key: "global",
      trace: { turnId, chatId: undefined, platform: undefined },
      payload: {},
      causationId: undefined,
      dedupeKey: undefined,
    });
    startAiOAuthKeepAlive();

    AppLogger.instance.record({
      trace: {
        turnId,
        chatId: undefined,
        platform: undefined,
      },
      event: "app.boot.complete",
      component: "app",
      level: EBehaviorLogLevel.Info,
      success: true,
      durationMs: performance.now() - start,
      summary: "Application boot completed",
    });
  } catch (error) {
    let serializedError = String(error);

    if (error instanceof Error && error.stack !== undefined) {
      serializedError = error.stack;
    }

    AppLogger.instance.record({
      trace: {
        turnId,
        chatId: undefined,
        platform: undefined,
      },
      event: "app.boot.failed",
      component: "app",
      level: EBehaviorLogLevel.Error,
      success: false,
      durationMs: performance.now() - start,
      summary: "Application boot failed",
      error: serializedError,
    });

    throw error;
  }

  console.timeEnd("init");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void Promise.allSettled([
      McpService.instance.close(),
      stopMcpAuthServer(),
      stopInternalApiServer(),
      EventBus.instance.stop(),
    ]).then(async () => {
      await AppLogger.instance.close();
      process.exit(0);
    });
  });
}

init();
