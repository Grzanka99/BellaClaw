import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import { EAutomationStatus } from "@bellaclaw/database";
import {
  runScript,
  SCRIPT_LIMITS,
  type TScriptFetcher,
  type TScriptRunResult,
} from "../../lib/script-sandbox";
import { startSpan } from "../app-logger/span";
import type { TAutomationRunReport } from "../events/catalog";
import type { TAutomation, TAutomationDraft } from "./types";

export enum EAutomationRunMode {
  Preview = "preview",
  Manual = "manual",
  Cron = "cron",
}

export enum EAutomationRunOutcome {
  Text = "text",
  Data = "data",
  Silent = "silent",
  Failed = "failed",
  Unavailable = "unavailable",
}

export type TAutomationRunOptions = {
  timezone: string;
  trace: TBehaviorTraceContext;
  signal?: AbortSignal;
  fetcher?: TScriptFetcher;
};

type TRunnableAutomation = Pick<
  TAutomationDraft,
  "scope" | "name" | "instructions" | "source" | "config" | "allowedOrigins" | "outputCapBytes"
>;

/** A scheduled or manual run waits this long: the sandbox wall limit plus a margin. */
export const AUTOMATION_RUN_TIMEOUT_MS = SCRIPT_LIMITS.wallMs + 30_000;

/**
 * Runs a draft against real data with a copy of the live automation's state.
 * Nothing is persisted: preview never commits state or failure counts.
 */
export async function previewAutomationDraft(
  draft: TAutomationDraft,
  liveState: unknown,
  options: TAutomationRunOptions,
): Promise<TAutomationRunReport> {
  const result = await executeAutomation(draft, liveState, EAutomationRunMode.Preview, options);

  return createReport(draft, result, false);
}

/**
 * Runs a saved automation exactly like a scheduled run but records nothing:
 * the script gets a copy of the stored state, and neither the returned state
 * nor a failure is committed.
 */
export async function dryRunSavedAutomation(
  automation: TAutomation,
  options: TAutomationRunOptions,
): Promise<TAutomationRunReport> {
  if (automation.status === EAutomationStatus.Paused) {
    return createPausedReport(automation);
  }

  const result = await executeAutomation(
    automation,
    automation.state,
    EAutomationRunMode.Preview,
    options,
  );

  return createReport(automation, result, false);
}

export function createPausedReport(automation: TAutomation): TAutomationRunReport {
  return {
    name: automation.name,
    instructions: automation.instructions ?? undefined,
    outcome: EAutomationRunOutcome.Unavailable,
    text: undefined,
    data: undefined,
    error: "automation is paused",
    fetches: [],
    logs: [],
    durationMs: 0,
    paused: false,
  };
}

export async function executeAutomation(
  automation: TRunnableAutomation,
  state: unknown,
  mode: EAutomationRunMode,
  options: TAutomationRunOptions,
): Promise<TScriptRunResult> {
  const span = startSpan(options.trace, "automation.run.completed", "automation");
  const result = await runScript({
    source: automation.source,
    config: automation.config,
    state: state ?? undefined,
    now: new Date(),
    timezone: options.timezone,
    allowedOrigins: automation.allowedOrigins,
    maxOutputBytes: automation.outputCapBytes,
    fetcher: options.fetcher,
    signal: options.signal,
  });

  const fields = {
    summary: `automation ${automation.name} ${mode}`,
    metadata: {
      automation: automation.name,
      mode,
      fetches: result.fetches.map((fetch) => {
        let host = "invalid-url";

        if (URL.canParse(fetch.url)) {
          host = new URL(fetch.url).host;
        }

        return { host, status: fetch.status ?? 0, bytes: fetch.bytes };
      }),
    },
  };

  if (result.ok) {
    span.ok({ ...fields, metadata: { ...fields.metadata, outcome: result.outcome.kind } });
  } else {
    span.fail(result.error, { ...fields, metadata: { ...fields.metadata, outcome: "failed" } });
  }

  return result;
}

export function createReport(
  automation: TRunnableAutomation,
  result: TScriptRunResult,
  paused: boolean,
): TAutomationRunReport {
  const report: TAutomationRunReport = {
    name: automation.name,
    instructions: automation.instructions ?? undefined,
    outcome: EAutomationRunOutcome.Failed,
    text: undefined,
    data: undefined,
    error: undefined,
    fetches: result.fetches,
    logs: result.logs,
    durationMs: result.durationMs,
    paused,
  };

  if (!result.ok) {
    report.error = result.error;
    return report;
  }

  switch (result.outcome.kind) {
    case "text":
      report.outcome = EAutomationRunOutcome.Text;
      report.text = result.outcome.text;
      break;
    case "data":
      report.outcome = EAutomationRunOutcome.Data;
      report.data = result.outcome.data;
      break;
    case "silent":
      report.outcome = EAutomationRunOutcome.Silent;
      break;
  }

  return report;
}
