import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import type { TIncommingMessage } from "./types";

const MessageTraceMap = new WeakMap<TIncommingMessage, TBehaviorTraceContext>();

export function attachMessageTrace(message: TIncommingMessage, trace: TBehaviorTraceContext) {
  MessageTraceMap.set(message, trace);
}

export function getMessageTrace(message: TIncommingMessage): TOption<TBehaviorTraceContext> {
  return MessageTraceMap.get(message);
}
