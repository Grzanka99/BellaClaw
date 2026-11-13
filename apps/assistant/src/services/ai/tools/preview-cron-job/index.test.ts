import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TOption } from "@bellaclaw/shared";
import { AutomationService, EAutomationStatus } from "../../../automation";
import { EAutomationRunOutcome } from "../../../automation/runner";
import { CronScheduler } from "../../../cron";
import { ECronJobStatus, ECronJobType, type TCronJob } from "../../../cron/types";
import { DatabaseConnector } from "../../../database";
import { testEventRequester } from "../../../events/test-utils";
import { SettingsService } from "../../../settings";
import { DefaultConfigRecord } from "../../../settings/schema";
import type { AgentHarness } from "../../agent-harness";
import { previewCronJob } from ".";

const COUNTER_SOURCE = `export default async function run(ctx) {
  const count = ctx.state?.count ?? 0;
  return { kind: "text", text: "count " + count, state: { count: count + 1 } };
}`;

// The test database is shared, so each test owns a fresh scope instead of clearing tables.
let scope = "";
let runScheduledTask = createAi("unused");

function createContext() {
  return {
    chatId: scope,
    settings: DefaultConfigRecord,
    trace: { turnId: "test", chatId: undefined, platform: undefined },
    events: testEventRequester,
    verifySettings: mock(async () => undefined),
    runScheduledTask,
  };
}

async function saveAutomation(name: string, source: string) {
  const draft = await AutomationService.instance.createDraft(DatabaseConnector.instance.database, {
    scope,
    name,
    source,
    config: {},
    allowedOrigins: [],
  });

  return AutomationService.instance.saveDraft(DatabaseConnector.instance.database, scope, draft.id);
}

function job(overrides: Partial<TCronJob>): TCronJob {
  return {
    id: 1,
    name: "daily",
    scope,
    type: ECronJobType.Recurring,
    pattern: "0 9 * * *",
    status: ECronJobStatus.Active,
    nextRunAt: new Date("2026-08-01T07:00:00.000Z"),
    lastRunAt: null,
    createdAt: new Date(),
    finishedAt: null,
    finishedReason: null,
    timezone: "Europe/Warsaw",
    content: { kind: "automations" },
    automationIds: [],
    ...overrides,
  };
}

function installJobs(jobs: TCronJob[]) {
  (CronScheduler as unknown as { _instance: unknown })._instance = {
    get: mock(async (name: string): Promise<TOption<TCronJob>> => {
      return jobs.find((item) => item.name === name);
    }),
  };
}

function createAi(text: string) {
  return mock<AgentHarness["runScheduledTask"]>(async () => ({
    text,
    stopReason: "completed",
    iterations: 1,
    toolCallCount: 0,
  }));
}

function installAi(text: string) {
  runScheduledTask = createAi(text);

  return runScheduledTask;
}

async function preview(args: Record<string, unknown>) {
  return previewCronJob.createAgentTool(createContext()).execute("call", args);
}

beforeEach(() => {
  scope = `signal:+${crypto.randomUUID()}`;
  (SettingsService as unknown as { _instance: unknown })._instance = {
    getAll: mock(async () => DefaultConfigRecord),
  };
});

afterEach(() => {
  (SettingsService as unknown as { _instance: unknown })._instance = undefined;
  (CronScheduler as unknown as { _instance: unknown })._instance = undefined;
});

describe("preview-cron-job", () => {
  test("dry-runs a raw automation job without committing state or failures", async () => {
    const counter = await saveAutomation("counter", COUNTER_SOURCE);
    const broken = await saveAutomation(
      "broken",
      "export default async () => { throw new Error('boom'); }",
    );
    installJobs([job({ name: "daily-counter", automationIds: [counter.id, broken.id] })]);
    const runScheduledTask = installAi("unused");

    for (let run = 0; run < 3; run += 1) {
      const result = await preview({ name: "daily-counter" });

      expect(result.details).toEqual({
        message: "count 0",
        note: undefined,
        automations: [
          { name: "counter", outcome: EAutomationRunOutcome.Text, error: undefined },
          { name: "broken", outcome: EAutomationRunOutcome.Failed, error: expect.any(String) },
        ],
      });
    }

    const [savedCounter, savedBroken] = await AutomationService.instance.getByIds(scope, [
      counter.id,
      broken.id,
    ]);
    expect(savedCounter?.state).toBeNull();
    expect(savedBroken?.failureCount).toBe(0);
    expect(savedBroken?.status).toBe(EAutomationStatus.Active);
    expect(runScheduledTask).not.toHaveBeenCalled();
  });

  test("previews overrides through the scheduled-task agent without MCP", async () => {
    await saveAutomation("counter", COUNTER_SOURCE);
    installJobs([
      job({
        name: "plain-task",
        content: { kind: "task", prompt: "Write a short note.", fallback: "Note unavailable." },
      }),
    ]);
    const runScheduledTask = installAi("Counter is at zero.");

    const result = await preview({ name: "plain-task", automations: ["counter"] });

    expect(result.details).toMatchObject({ message: "Counter is at zero." });
    expect(runScheduledTask.mock.calls[0]?.[0].withoutMcp).toBe(true);
    const prompt = runScheduledTask.mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain("Write a short note.\n\n<automation_outputs>");
    expect(prompt).toContain('"text": "count 0"');
  });

  test("reports when a raw job would send nothing", async () => {
    await saveAutomation("quiet", "export default async () => ({ kind: 'silent' })");
    installJobs([]);
    installAi("unused");

    const result = await preview({ automations: ["quiet"] });

    expect(result.details).toMatchObject({ message: undefined });
    expect(result.details).toMatchObject({
      note: expect.stringContaining("Nothing would be sent"),
    });
  });

  test("rejects automations on reminder jobs, unknown names, and empty previews", async () => {
    await saveAutomation("counter", COUNTER_SOURCE);
    installJobs([job({ name: "reminder", content: { kind: "text", text: "Stretch." } })]);
    installAi("unused");

    await expect(preview({ name: "reminder", automations: ["counter"] })).resolves.toMatchObject({
      isError: true,
      details: { errorCode: "automations-without-task" },
    });
    await expect(preview({ automations: ["missing"] })).resolves.toMatchObject({
      isError: true,
      details: { errorCode: "unknown-automation" },
      content: [{ text: "Unknown automations: missing" }],
    });
    await expect(preview({ automations: [] })).resolves.toMatchObject({
      isError: true,
      details: { errorCode: "missing-content" },
    });
    await expect(preview({ name: "nope" })).resolves.toMatchObject({
      isError: true,
      details: { errorCode: "job-not-found" },
    });
  });
});
