import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import type { ERole } from "../ai/types";
import type { EMemoryImportance } from "../memory/types";
import { sanitizeErrorMessage } from "./sanitizers";

export function logHandlerStarted(trace: TOption<TBehaviorTraceContext>, handler: string) {
  if (trace === undefined) {
    return;
  }

  AppLogger.instance.record({
    trace,
    event: "handler.started",
    component: handler,
    summary: `${handler} started`,
    metadata: {
      handler,
    },
  });
}

export function logHandlerCompleted(
  trace: TOption<TBehaviorTraceContext>,
  handler: string,
  start: number,
  success: boolean,
  replyChars: number,
  summary: string,
  error: TOption<string>,
) {
  if (trace === undefined) {
    return;
  }

  let level = EBehaviorLogLevel.Info;

  if (!success) {
    level = EBehaviorLogLevel.Warning;
  }

  AppLogger.instance.record({
    trace,
    event: "handler.completed",
    component: handler,
    level,
    success,
    durationMs: performance.now() - start,
    summary: `${handler} ${summary}`,
    metadata: {
      handler,
      replyChars,
    },
    error: sanitizeErrorMessage(error),
  });
}

export function logMemorySaveCompleted(
  trace: TOption<TBehaviorTraceContext>,
  start: number,
  author: ERole,
  importance: EMemoryImportance,
  messageChars: number,
  error?: string,
) {
  if (trace === undefined) {
    return;
  }

  const success = error === undefined;
  let level = EBehaviorLogLevel.Info;

  if (!success) {
    level = EBehaviorLogLevel.Warning;
  }

  AppLogger.instance.record({
    trace,
    event: "memory.save.completed",
    component: "memory",
    level,
    success,
    durationMs: performance.now() - start,
    summary: `memory save completed author=${author} importance=${importance}`,
    metadata: {
      author,
      importance,
      messageChars,
    },
    error: sanitizeErrorMessage(error),
  });
}
