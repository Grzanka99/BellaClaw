import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AppLogger, type TBehaviorLogEvent } from "../app-logger";
import { Memory } from "../memory";
import { MessageHandler } from "../message-handler";
import { SettingsService } from "../settings";
import { SettingsIntentClassifier } from "../settings-intent-classifier";
import { SettingsMessageHandler } from "../settings-message-handler";
import { MessagingAdapter } from "./index";
import { EMessagePlatform } from "./types";

type TAppLoggerStatic = {
  _instance: AppLogger | undefined;
};

type TMessagingAdapterStatic = {
  _instance: MessagingAdapter | undefined;
};

type TSettingsServiceStatic = {
  _instance: unknown;
};

type TSettingsIntentClassifierStatic = {
  _instance: unknown;
};

type TMemoryStatic = {
  _instance: unknown;
};

function installAppLogger(appLogger: AppLogger) {
  const AppLoggerWithInternals = AppLogger as unknown as TAppLoggerStatic;
  AppLoggerWithInternals._instance = appLogger;
}

async function resetAppLogger() {
  const AppLoggerWithInternals = AppLogger as unknown as TAppLoggerStatic;
  await AppLoggerWithInternals._instance?.close();
  AppLoggerWithInternals._instance = undefined;
}

function resetSingletons() {
  const MessagingAdapterWithInternals = MessagingAdapter as unknown as TMessagingAdapterStatic;
  MessagingAdapterWithInternals._instance = undefined;

  const SettingsServiceWithInternals = SettingsService as unknown as TSettingsServiceStatic;
  SettingsServiceWithInternals._instance = undefined;

  const ClassifierWithInternals =
    SettingsIntentClassifier as unknown as TSettingsIntentClassifierStatic;
  ClassifierWithInternals._instance = undefined;

  const MemoryWithInternals = Memory as unknown as TMemoryStatic;
  MemoryWithInternals._instance = undefined;

  (MessageHandler as unknown as { _instances: Map<string, MessageHandler> })._instances.clear();
  (
    SettingsMessageHandler as unknown as {
      _instances: Map<string, SettingsMessageHandler>;
    }
  )._instances.clear();
}

function configureFailingSettingsService() {
  const SettingsServiceWithInternals = SettingsService as unknown as TSettingsServiceStatic;
  SettingsServiceWithInternals._instance = {
    getAll: mock(async () => {
      throw new Error("settings failed");
    }),
  };
}

function configureClassifier(intent: "normal" | "settings") {
  const ClassifierWithInternals =
    SettingsIntentClassifier as unknown as TSettingsIntentClassifierStatic;
  ClassifierWithInternals._instance = {
    classify: mock(async () => ({ intent, reason: "test" })),
  };
}

async function expectFailureEvents(
  component: "message-handler" | "settings-message-handler",
  stdoutEvents: TBehaviorLogEvent[],
) {
  const innerCompletions = stdoutEvents.filter(
    (event) => event.event === "handler.completed" && event.component === component,
  );
  const messagingCompletions = stdoutEvents.filter(
    (event) => event.event === "handler.completed" && event.component === "messaging",
  );

  expect(innerCompletions).toHaveLength(1);
  expect(innerCompletions[0]?.success).toBe(false);
  expect(messagingCompletions).toHaveLength(1);
  expect(messagingCompletions[0]?.success).toBe(false);
}

describe("messaging failure behavior logging", () => {
  beforeEach(() => {
    resetSingletons();
  });

  afterEach(async () => {
    await resetAppLogger();
    resetSingletons();
  });

  for (const intent of ["normal", "settings"] as const) {
    test(`records failed ${intent} and messaging completions while rethrowing`, async () => {
      const stdoutEvents: TBehaviorLogEvent[] = [];
      const appLogger = new AppLogger({
        dbPath: ":memory:",
        stdout(event) {
          stdoutEvents.push(event);
        },
      });
      installAppLogger(appLogger);
      configureFailingSettingsService();
      configureClassifier(intent);

      const adapter = MessagingAdapter.instance;
      adapter.registerTransport({
        platform: EMessagePlatform.Discord,
        sendText: mock(async () => {}),
      });

      await expect(
        adapter.handleInboundMessage({
          platform: EMessagePlatform.Discord,
          chatId: "chat-1",
          author: { id: "user-1", username: "User" },
          message: { type: "text", content: "hello" },
        }),
      ).rejects.toThrow("settings failed");

      await appLogger.flush();
      await expectFailureEvents(
        intent === "normal" ? "message-handler" : "settings-message-handler",
        stdoutEvents,
      );
    });
  }
});
