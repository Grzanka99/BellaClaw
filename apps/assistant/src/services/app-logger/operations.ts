import { AppLogger, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { ERole } from "../ai/types";
import { startSpan } from "./span";

export function logHandlerStarted(trace: TBehaviorTraceContext, handler: string) {
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

export type THandlerSpan = ReturnType<typeof startHandlerSpan>;

export function startHandlerSpan(trace: TBehaviorTraceContext, handler: string) {
  const span = startSpan(trace, "handler.completed", handler);

  return {
    ok: (summary: string, replyChars: number) => {
      span.ok({ summary: `${handler} ${summary}`, metadata: { handler, replyChars } });
    },
    fail: (summary: string, replyChars: number, error?: string) => {
      span.fail(error, { summary: `${handler} ${summary}`, metadata: { handler, replyChars } });
    },
  };
}

export function startMemorySaveSpan(
  trace: TBehaviorTraceContext,
  author: ERole,
  messageChars: number,
) {
  return startSpan(trace, "memory.save.completed", "memory", {
    summary: `memory save completed author=${author}`,
    metadata: {
      author,
      messageChars,
    },
  });
}
