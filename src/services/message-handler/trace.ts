import type { TOption } from "../../types";
import type { TBehaviorTraceContext } from "../app-logger";
import type { TIncommingMessage } from "./types";

const MessageTraceMap = new WeakMap<TIncommingMessage, TBehaviorTraceContext>();

export function attachMessageTrace(message: TIncommingMessage, trace: TBehaviorTraceContext) {
  MessageTraceMap.set(message, trace);
}

export function getMessageTrace(message: TIncommingMessage): TOption<TBehaviorTraceContext> {
  return MessageTraceMap.get(message);
}
