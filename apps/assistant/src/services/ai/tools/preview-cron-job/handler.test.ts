import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TCronJob, TCronSchedulerError } from "../../../../lib/cron-engine";
import { AutomationService, EAutomationStatus } from "../../../automation";
import { EAutomationRunOutcome } from "../../../automation/runner";
import { CronSingleton } from "../../../cron";
import { resetAutomationsTables, resetCronEngineJobsTable } from "../../../database/test-utils";
import { SettingsService } from "../../../settings";
import { DefaultConfigRecord } from "../../../settings/schema";
import type { AgentHarness } from "../../agent-harness";
import { handlePreviewCronJob } from "./handler";

const SCOPE = "signal:+100";
const OPTIONS = { timezone: "Europe/Warsaw", trace: undefined };
const COUNTER_SOURCE = `export default async function run(ctx) {
  const count = ctx.state?.count ?? 0;
  return { kind: "text", text: "count " + count, state: { count: count + 1 } };
}`;

async function saveAutomation(name: string, source: string) {
  const draft = await AutomationService.instance.createDraft({
    scope: SCOPE,
    name,
    source,
    config: {},
    allowedOrigins: [],
  });

  return AutomationService.instance.saveDraft(SCOPE, draft.id);
}

function expectCreated(result: TCronJob | TCronSchedulerError) {
  if ("error" in result) {
    throw new Error(String(result.error));
  }

  return result;
}

function scheduledTaskAi(text: string) {
  const prompts: string[] = [];
  const runScheduledTask = mock(async (args: Parameters<AgentHarness["runScheduledTask"]>[0]) => {
    prompts.push(args.prompt);
    return { text, stopReason: "completed", iterations: 1, toolCallCount: 0, messages: [] };
  });

  return { ai: { runScheduledTask }, prompts };
}

describe("handlePreviewCronJob", () => {
  beforeEach(async () => {
    await resetAutomationsTables();
    await resetCronEngineJobsTable();
    (SettingsService as unknown as { _instance: unknown })._instance = {
      getAll: mock(async () => DefaultConfigRecord),
    };
  });

  afterEach(() => {
    (SettingsService as unknown as { _instance: unknown })._instance = undefined;
    CronSingleton.instance.destroy();
  });

  test("dry-runs a raw automation job without committing state or failures", async () => {
    const counter = await saveAutomation("counter", COUNTER_SOURCE);
    const broken = await saveAutomation(
      "broken",
      "export default async () => { throw new Error('boom'); }",
    );
    expectCreated(
      await CronSingleton.instance.createRecurring({
        name: "daily-counter",
        scope: SCOPE,
        pattern: "0 9 * * *",
        automationIds: [counter.id, broken.id],
      }),
    );
    const { ai } = scheduledTaskAi("unused");

    for (let run = 0; run < 3; run += 1) {
      const result = await handlePreviewCronJob(SCOPE, { name: "daily-counter" }, ai, OPTIONS);

      expect(result.message).toBe("count 0");
      expect(result.note).toBeUndefined();
      expect(result.automations).toEqual([
        { name: "counter", outcome: EAutomationRunOutcome.Text, error: undefined },
        { name: "broken", outcome: EAutomationRunOutcome.Failed, error: expect.any(String) },
      ]);
    }

    const [savedCounter, savedBroken] = await AutomationService.instance.getByIds(SCOPE, [
      counter.id,
      broken.id,
    ]);
    expect(savedCounter?.state).toBeUndefined();
    expect(savedBroken?.failureCount).toBe(0);
    expect(savedBroken?.status).toBe(EAutomationStatus.Active);
    expect(ai.runScheduledTask).not.toHaveBeenCalled();
  });

  test("previews overrides through the scheduled-task agent", async () => {
    await saveAutomation("counter", COUNTER_SOURCE);
    expectCreated(
      await CronSingleton.instance.createRecurring({
        name: "plain-task",
        scope: SCOPE,
        pattern: "0 9 * * *",
        taskPrompt: "Write a short note.",
        taskFallbackText: "Note unavailable.",
      }),
    );
    const { ai, prompts } = scheduledTaskAi("Counter is at zero.");

    const result = await handlePreviewCronJob(
      SCOPE,
      { name: "plain-task", automations: ["counter"] },
      ai,
      OPTIONS,
    );

    expect(result.message).toBe("Counter is at zero.");
    expect(ai.runScheduledTask.mock.calls[0]?.[0].withoutMcp).toBe(true);
    expect(prompts[0]).toContain("Write a short note.\n\n<automation_outputs>");
    expect(prompts[0]).toContain('"text": "count 0"');
  });

  test("reports when a raw job would send nothing", async () => {
    await saveAutomation("quiet", "export default async () => ({ kind: 'silent' })");
    const { ai } = scheduledTaskAi("unused");

    const result = await handlePreviewCronJob(SCOPE, { automations: ["quiet"] }, ai, OPTIONS);

    expect(result.message).toBeUndefined();
    expect(result.note).toContain("Nothing would be sent");
  });

  test("rejects automations on reminder jobs, unknown names, and empty previews", async () => {
    await saveAutomation("counter", COUNTER_SOURCE);
    expectCreated(
      await CronSingleton.instance.createRecurring({
        name: "reminder",
        scope: SCOPE,
        pattern: "0 9 * * *",
        reminderText: "Stretch.",
      }),
    );
    const { ai } = scheduledTaskAi("unused");

    await expect(
      handlePreviewCronJob(SCOPE, { name: "reminder", automations: ["counter"] }, ai, OPTIONS),
    ).rejects.toThrow("automations can only be combined with taskPrompt");
    await expect(
      handlePreviewCronJob(SCOPE, { automations: ["missing"] }, ai, OPTIONS),
    ).rejects.toThrow("Unknown automations: missing");
    await expect(handlePreviewCronJob(SCOPE, { automations: [] }, ai, OPTIONS)).rejects.toThrow(
      "Nothing to preview",
    );
    await expect(handlePreviewCronJob(SCOPE, { name: "nope" }, ai, OPTIONS)).rejects.toThrow(
      "No job found with name: nope",
    );
  });
});
