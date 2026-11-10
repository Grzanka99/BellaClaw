import {
  AppLogger,
  EBehaviorLogLevel,
  type TBehaviorLogInput,
  type TBehaviorTraceContext,
} from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { sanitizeErrorMessage } from "./sanitizers";

export type TSpanFields = Partial<Omit<TBehaviorLogInput, "trace" | "success" | "durationMs">>;

export type TBehaviorSpan = {
  end: (success: boolean, fields: TSpanFields, error: TOption<string>) => void;
  ok: (fields?: TSpanFields) => void;
  fail: (error: TOption<string>, fields?: TSpanFields) => void;
};

// NOTE: the span records one completion event. The level is Warning unless it succeeded and the
// error argument is sanitized; base fields and then end fields override those defaults.
export function startSpan(
  trace: TBehaviorTraceContext,
  event: string,
  component: string,
  base: TSpanFields = {},
): TBehaviorSpan {
  const startedAt = performance.now();
  const end = (success: boolean, fields: TSpanFields, error: TOption<string>) => {
    let level = EBehaviorLogLevel.Info;

    if (!success) {
      level = EBehaviorLogLevel.Warning;
    }

    AppLogger.instance.record({
      trace,
      event,
      component,
      level,
      success,
      durationMs: performance.now() - startedAt,
      error: sanitizeErrorMessage(error),
      ...base,
      ...fields,
    });
  };

  return {
    end,
    ok: (fields = {}) => end(true, fields, undefined),
    fail: (error, fields = {}) => end(false, fields, error),
  };
}
