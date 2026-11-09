import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import {
  runScript,
  type TScriptFetcher,
  type TScriptFetchLog,
  type TScriptRunResult,
} from "../../lib/script-sandbox";
import { sanitizeErrorMessage } from "../app-logger/sanitizers";
import { AutomationService } from "./index";
import { EAutomationStatus, type TAutomation, type TAutomationDraft } from "./types";

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

export type TAutomationRunReport = {
  name: string;
  instructions: TOption<string>;
  outcome: EAutomationRunOutcome;
  text: TOption<string>;
  data: unknown;
  error: TOption<string>;
  fetches: TScriptFetchLog[];
  logs: string[];
  durationMs: number;
  /** True only when this run's failure paused the automation. */
  paused: boolean;
};

export type TAutomationRunOptions = {
  timezone: string;
  trace: TOption<TBehaviorTraceContext>;
  signal?: AbortSignal;
  fetcher?: TScriptFetcher;
};

type TRunnableAutomation = Pick<
  TAutomationDraft,
  "scope" | "name" | "instructions" | "source" | "config" | "allowedOrigins" | "outputCapBytes"
>;

/**
 * Runs a draft against real data with a copy of the live automation's state.
 * Nothing is persisted: preview never commits state or failure counts.
 */
export async function previewAutomationDraft(
  draft: TAutomationDraft,
  options: TAutomationRunOptions,
): Promise<TAutomationRunReport> {
  const live = await AutomationService.instance.get(draft.scope, draft.name);
  let state: TOption<unknown>;

  if (live !== undefined) {
    state = live.state;
  }

  const result = await executeAutomation(draft, state, EAutomationRunMode.Preview, options);

  return createReport(draft, result, false);
}

/**
 * Runs a saved automation and records the result: success stores the returned
 * state and resets failures; failure counts towards the automatic pause.
 */
export async function runSavedAutomation(
  automation: TAutomation,
  mode: EAutomationRunMode.Manual | EAutomationRunMode.Cron,
  options: TAutomationRunOptions,
): Promise<TAutomationRunReport> {
  if (automation.status === EAutomationStatus.Paused) {
    return createPausedReport(automation);
  }

  const result = await executeAutomation(automation, automation.state, mode, options);

  if (result.ok) {
    await AutomationService.instance.recordSuccess(automation.id, result.state);
    return createReport(automation, result, false);
  }

  const failure = await AutomationService.instance.recordFailure(automation.id, result.error);

  return createReport(automation, result, failure.paused);
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
    structuredClone(automation.state),
    EAutomationRunMode.Preview,
    options,
  );

  return createReport(automation, result, false);
}

function createPausedReport(automation: TAutomation): TAutomationRunReport {
  return {
    name: automation.name,
    instructions: automation.instructions,
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

async function executeAutomation(
  automation: TRunnableAutomation,
  state: TOption<unknown>,
  mode: EAutomationRunMode,
  options: TAutomationRunOptions,
): Promise<TScriptRunResult> {
  const result = await runScript({
    source: automation.source,
    config: automation.config,
    state,
    now: new Date(),
    timezone: options.timezone,
    allowedOrigins: automation.allowedOrigins,
    maxOutputBytes: automation.outputCapBytes,
    fetcher: options.fetcher,
    signal: options.signal,
  });

  logAutomationRun(options.trace, automation.name, mode, result);

  return result;
}

function createReport(
  automation: TRunnableAutomation,
  result: TScriptRunResult,
  paused: boolean,
): TAutomationRunReport {
  const report: TAutomationRunReport = {
    name: automation.name,
    instructions: automation.instructions,
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

function logAutomationRun(
  trace: TOption<TBehaviorTraceContext>,
  name: string,
  mode: EAutomationRunMode,
  result: TScriptRunResult,
) {
  if (trace === undefined) {
    return;
  }

  let level = EBehaviorLogLevel.Info;
  let outcome = "failed";
  let error: TOption<string>;

  if (result.ok) {
    outcome = result.outcome.kind;
  } else {
    level = EBehaviorLogLevel.Warning;
    error = result.error;
  }

  AppLogger.instance.record({
    trace,
    event: "automation.run.completed",
    component: "automation",
    level,
    success: result.ok,
    durationMs: Math.round(result.durationMs),
    summary: `automation ${name} ${mode} ${outcome}`,
    metadata: {
      automation: name,
      mode,
      outcome,
      fetches: result.fetches.map((fetch) => ({
        url: fetch.url,
        status: fetch.status ?? 0,
        bytes: fetch.bytes,
      })),
    },
    error: sanitizeErrorMessage(error),
  });
}
