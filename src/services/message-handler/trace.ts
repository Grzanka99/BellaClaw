import type { TBehaviorTraceContext } from "../app-logger";
import type { TIncommingMessage } from "./types";

const MessageTraceMap = new WeakMap<TIncommingMessage, TBehaviorTraceContext>();

export function attachMessageTrace(message: TIncommingMessage, trace: TBehaviorTraceContext) {
  MessageTraceMap.set(message, trace);
}

export function getMessageTrace(message: TIncommingMessage) {
  return MessageTraceMap.get(message);
}
