import { CronSingleton } from "../../cron";
import { OllamaAiProvider } from "../providers/ollama";
import { EModelPurpose, ERole, type TToolEntry } from "../types";
import { LIST_CRON_JOBS_TOOL, listCronJobsTool } from "./list-cron-jobs/definition";
import { handleListCronJobs } from "./list-cron-jobs/handler";
import { SCHEDULE_RECURRING_TOOL, scheduleRecurringTool } from "./schedule-recurring/definition";
import { handleScheduleRecurring } from "./schedule-recurring/handler";
import {
  UNSCHEDULE_RECURRING_TOOL,
  unscheduleRecurringTool,
} from "./unschedule-recurring/definition";
import { handleUnscheduleRecurring } from "./unschedule-recurring/handler";

const USER_ID = "mock-user";
const USER = { id: USER_ID, username: "mockuser", displayName: "Mock User" };

const cron = CronSingleton.instance;
cron.setup(1_000);

console.log("=== Cron tool mock test ===\n");

console.log("--- Setup: pre-populate cron jobs for cleanup test ---");
await cron.schedule({
  name: "old-reminder-1",
  userId: USER_ID,
  pattern: "0 9 * * *",
  group: "reminders",
});
await cron.schedule({
  name: "old-reminder-2",
  userId: USER_ID,
  pattern: "0 18 * * *",
  group: "reminders",
});
console.log("Created 2 initial jobs: old-reminder-1 (9:00), old-reminder-2 (18:00)\n");

const scheduleInstructions = await Bun.file(
  "./src/services/ai/tools/schedule-recurring/instructions.xml",
).text();
const unscheduleInstructions = await Bun.file(
  "./src/services/ai/tools/unschedule-recurring/instructions.xml",
).text();
const listInstructions = await Bun.file(
  "./src/services/ai/tools/list-cron-jobs/instructions.xml",
).text();

const tools: TToolEntry[] = [
  { definition: scheduleRecurringTool, instructions: scheduleInstructions },
  { definition: unscheduleRecurringTool, instructions: unscheduleInstructions },
  { definition: listCronJobsTool, instructions: listInstructions },
];

const provider = OllamaAiProvider.instance;
const model = provider.getModel(EModelPurpose.ToolCheap);

type TToolName =
  | typeof SCHEDULE_RECURRING_TOOL
  | typeof UNSCHEDULE_RECURRING_TOOL
  | typeof LIST_CRON_JOBS_TOOL;

async function aiStep(label: string, prompt: string): Promise<void> {
  console.log(`\n--- ${label} ---`);
  console.log(`User: "${prompt}"`);

  const result = await provider.chatWithTools({
    prompt: {
      role: ERole.User,
      content: [{ type: "text" as const, text: prompt }],
    },
    history: [],
    user: USER,
    tools,
    model,
  });

  if (!result) {
    console.log("AI response: (no response)");
    return;
  }

  console.log(`AI: ${result.response || "(no text, tool call only)"}`);

  if (!result.toolCalls.length) {
    console.log("  (no tool calls)");
    return;
  }

  for (const tc of result.toolCalls) {
    const handlerArgs = {
      id: tc.id,
      type: "function" as const,
      function: tc.function,
    };

    const name = tc.function.name as TToolName;
    console.log(`  Tool call: ${name}(${tc.function.arguments})`);

    switch (name) {
      case SCHEDULE_RECURRING_TOOL: {
        const res = await handleScheduleRecurring(handlerArgs, USER_ID);
        if (res) {
          console.log(
            `    -> Scheduled: ${res.name} (${res.pattern}), next at ${res.nextRunAt.toISOString()}`,
          );
        } else {
          console.log("    -> Failed to schedule");
        }
        break;
      }
      case UNSCHEDULE_RECURRING_TOOL: {
        const res = await handleUnscheduleRecurring(handlerArgs, USER_ID);
        if (res) {
          console.log(`    -> Unscheduled: ${res.name}`);
        } else {
          console.log("    -> Failed to unschedule (job not found)");
        }
        break;
      }
      case LIST_CRON_JOBS_TOOL: {
        const res = await handleListCronJobs(handlerArgs, USER_ID);
        if (res) {
          console.log(`    -> Found ${res.length} job(s):`);
          for (const j of res) {
            console.log(
              `       - ${j.name} | ${j.type} | ${j.pattern ?? "one-time"} | next: ${j.nextRunAt.toISOString()}`,
            );
          }
        } else {
          console.log("    -> Failed to list jobs");
        }
        break;
      }
    }
  }
}

async function showDbState(label: string): Promise<void> {
  const jobs = await cron.getAllJobs(USER_ID);
  console.log(`\n  DB state (${label}): ${jobs.length} job(s)`);
  for (const j of jobs) {
    console.log(
      `    - ${j.name} | ${j.type} | ${j.pattern ?? "one-time"} | next: ${j.nextRunAt.toISOString()}`,
    );
  }
}

await showDbState("before AI calls");

await aiStep("1. List scheduled jobs", "What reminders do I have set up?");

await showDbState("after list");

await aiStep("2. Unschedule all events", "Unschedule all my events");

await showDbState("after unschedule all");

await aiStep("3. Schedule a recurring reminder", "Remind me to stretch every 30 minutes");

await showDbState("after schedule");

await aiStep(
  "4. Schedule another reminder",
  "Schedule a weekly standup every Monday at 9am called weekly-standup",
);

await showDbState("after second schedule");

await aiStep("5. List jobs again", "Show me my current scheduled reminders");

await showDbState("after second list");

await aiStep("6. Unschedule a specific event", "Cancel my stretch reminder");

await showDbState("after specific unschedule");

console.log("\n=== Test complete, cleaning up ===");
cron.destroy();
process.exit(0);
