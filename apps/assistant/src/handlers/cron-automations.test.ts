import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ECronJobType, type TCronJobContext } from "../lib/cron-engine";
import type { AgentHarness } from "../services/ai/agent-harness";
import { AutomationService, type TAutomation } from "../services/automation";
import { EAutomationRunOutcome, type TAutomationRunReport } from "../services/automation/runner";
import { CronSingleton } from "../services/cron";
import { resetAutomationsTables } from "../services/database/test-utils";
import { SettingsService } from "../services/settings";
import { DefaultConfigRecord } from "../services/settings/schema";
import {
  createAutomationOutputsBlock,
  createAutomationPausedNotices,
  runCronJobAutomations,
} from "./cron-automations";

const SCOPE = "signal:+100";

function context(overrides: Partial<TCronJobContext> = {}): TCronJobContext {
  return {
    name: "briefing",
    scope: SCOPE,
    group: undefined,
    type: ECronJobType.Recurring,
    pattern: "0 9 * * *",
    reminderText: undefined,
    reminderPromptData: undefined,
    reminderFallbackText: undefined,
    taskPrompt: undefined,
    taskFallbackText: undefined,
    automationIds: [],
    lastRunAt: undefined,
    nextRunAt: new Date("2026-01-05T08:00:00.000Z"),
    createdAt: new Date("2026-01-01T08:00:00.000Z"),
    timezone: "Europe/Warsaw",
    ...overrides,
  };
}

function report(
  name: string,
  outcome: EAutomationRunOutcome,
  overrides: Partial<TAutomationRunReport> = {},
): TAutomationRunReport {
  return {
    name,
    instructions: undefined,
    outcome,
    text: undefined,
    data: undefined,
    error: undefined,
    fetches: [],
    logs: [],
    durationMs: 1,
    paused: false,
    ...overrides,
  };
}

async function saveAutomation(name: string, instructions?: string) {
  const draft = await AutomationService.instance.createDraft({
    scope: SCOPE,
    name,
    instructions,
    source: "export default async () => ({ kind: 'silent' })",
    config: {},
    allowedOrigins: [],
  });

  return AutomationService.instance.saveDraft(SCOPE, draft.id);
}

function fakeRunner(reports: Record<string, TAutomationRunReport>) {
  const order: string[] = [];
  const run = mock(async (automation: TAutomation) => {
    order.push(automation.name);
    const result = reports[automation.name];

    if (result === undefined) {
      throw new Error(`Missing report fixture for ${automation.name}`);
    }

    return result;
  });

  return { run, order };
}

function scheduledTaskAi(text = "Agent message") {
  const prompts: string[] = [];
  const runScheduledTask = mock(async (args: Parameters<AgentHarness["runScheduledTask"]>[0]) => {
    prompts.push(args.prompt);
    return { text, stopReason: "completed", iterations: 1, toolCallCount: 0, messages: [] };
  });

  return { ai: { runScheduledTask }, prompts };
}

describe("runCronJobAutomations", () => {
  beforeEach(async () => {
    await resetAutomationsTables();
    (SettingsService as unknown as { _instance: unknown })._instance = {
      getAll: mock(async () => DefaultConfigRecord),
    };
  });

  afterEach(() => {
    (SettingsService as unknown as { _instance: unknown })._instance = undefined;
    CronSingleton.instance.destroy();
  });

  test("raw mode joins text outputs in list order and skips silent and data outputs", async () => {
    const departures = await saveAutomation("departures");
    const quiet = await saveAutomation("quiet");
    const metrics = await saveAutomation("metrics");
    const weather = await saveAutomation("weather");
    const { run, order } = fakeRunner({
      departures: report("departures", EAutomationRunOutcome.Text, { text: "Bus at 7:05" }),
      quiet: report("quiet", EAutomationRunOutcome.Silent),
      metrics: report("metrics", EAutomationRunOutcome.Data, { data: { value: 1 } }),
      weather: report("weather", EAutomationRunOutcome.Text, { text: "Rain later" }),
    });
    const { ai } = scheduledTaskAi();

    const result = await runCronJobAutomations(
      context({ automationIds: [weather.id, quiet.id, metrics.id, departures.id] }),
      SCOPE,
      ai,
      run,
    );

    expect(order).toEqual(["weather", "quiet", "metrics", "departures"]);
    expect(result.text).toBe("Rain later\n\nBus at 7:05");
    expect(result.taskResult).toBeUndefined();
    expect(ai.runScheduledTask).not.toHaveBeenCalled();
  });

  test("raw mode sends nothing when no automation returns text", async () => {
    const quiet = await saveAutomation("quiet");
    const { run } = fakeRunner({ quiet: report("quiet", EAutomationRunOutcome.Silent) });

    const result = await runCronJobAutomations(
      context({ automationIds: [quiet.id, 999] }),
      SCOPE,
      scheduledTaskAi().ai,
      run,
    );

    expect(result.text).toBeUndefined();
    expect(result.reports.map((item) => [item.name, item.outcome, item.error])).toEqual([
      ["quiet", EAutomationRunOutcome.Silent, undefined],
      ["automation 999", EAutomationRunOutcome.Unavailable, "automation was deleted"],
    ]);
  });

  test("task mode gives the agent every automation outcome in a delimited block", async () => {
    const weather = await saveAutomation("weather", "temperature is in Celsius");
    const quiet = await saveAutomation("quiet");
    const broken = await saveAutomation("broken");
    const { run } = fakeRunner({
      weather: report("weather", EAutomationRunOutcome.Data, {
        instructions: "temperature is in Celsius",
        data: { temperature: 21 },
      }),
      quiet: report("quiet", EAutomationRunOutcome.Silent),
      broken: report("broken", EAutomationRunOutcome.Failed, { error: "HTTP 500" }),
    });
    const { ai, prompts } = scheduledTaskAi("It is 21°C.");

    const result = await runCronJobAutomations(
      context({
        taskPrompt: "Write my morning briefing.",
        taskFallbackText: "Briefing unavailable.",
        automationIds: [weather.id, quiet.id, broken.id, 999],
      }),
      SCOPE,
      ai,
      run,
    );

    expect(result.text).toBe("It is 21°C.");
    expect(result.taskResult?.text).toBe("It is 21°C.");
    const prompt = prompts[0] ?? "";
    expect(prompt.startsWith("Write my morning briefing.\n\n<automation_outputs>\n")).toBe(true);
    expect(prompt.endsWith("</automation_outputs>")).toBe(true);
    const json = prompt.slice(prompt.indexOf("["), prompt.lastIndexOf("]") + 1);
    expect(JSON.parse(json)).toEqual([
      {
        name: "weather",
        instructions: "temperature is in Celsius",
        outcome: "data",
        data: { temperature: 21 },
      },
      { name: "quiet", outcome: "silent" },
      { name: "broken", outcome: "failed", error: "HTTP 500" },
      { name: "automation 999", outcome: "unavailable", error: "automation was deleted" },
    ]);
  });

  test("task mode keeps the fallback when the agent returns nothing", async () => {
    const quiet = await saveAutomation("quiet");
    const { run } = fakeRunner({ quiet: report("quiet", EAutomationRunOutcome.Silent) });

    const result = await runCronJobAutomations(
      context({
        taskPrompt: "Summarize.",
        taskFallbackText: "Briefing unavailable.",
        automationIds: [quiet.id],
      }),
      SCOPE,
      scheduledTaskAi(" ").ai,
      run,
    );

    expect(result.text).toBe("Briefing unavailable.");
  });
});

describe("automation outputs", () => {
  test("includes text outputs and omits empty instructions", () => {
    const block = createAutomationOutputsBlock([
      report("bus", EAutomationRunOutcome.Text, { text: "Bus at 7:05" }),
    ]);

    expect(block).toContain('"name": "bus"');
    expect(block).toContain('"text": "Bus at 7:05"');
    expect(block).not.toContain("instructions");
  });

  test("creates one fixed notice per automation paused by this run", () => {
    expect(
      createAutomationPausedNotices([
        report("weather", EAutomationRunOutcome.Failed, { error: "HTTP 500", paused: true }),
        report("bus", EAutomationRunOutcome.Failed, { error: "timeout" }),
      ]),
    ).toEqual(['Automation "weather" was paused after 3 failed runs: HTTP 500. Ask me to fix it.']);
  });
});
