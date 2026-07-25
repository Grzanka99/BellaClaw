import { AppLogger, EBehaviorLogLevel } from "./services/app-logger";
import { CalendarService } from "./services/calendar";
import { DiscordSingleton } from "./services/discord";
import { MessagingAdapter } from "./services/messaging";
import { SignalSingleton } from "./services/signal";

function createBootTurnId(): string {
  return `boot:${crypto.randomUUID()}`;
}

async function init(): Promise<void> {
  const start = performance.now();
  const turnId = createBootTurnId();

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
    await Promise.all([
      CalendarService.instance.setup(),
      DiscordSingleton.instance.setup(),
      SignalSingleton.instance.setup(),
    ]);
    await MessagingAdapter.instance.setup();

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

init();
