import { rmSync } from "node:fs";
import { join } from "node:path";
import { CronSingleton } from "./index";
import { ECronJobType } from "./types";

const RUN_ID = `${Date.now()}`;
const USER_A = `edge-user-a-${RUN_ID}`;
const USER_B = `edge-user-b-${RUN_ID}`;
const POLL_INTERVAL_MS = 1_000;
const MAX_RUNTIME_MS = 5 * 60 * 1_000;
const RECURRING_NAME = `edge-recurring-${RUN_ID}`;

const tempDir = Bun.env.TMPDIR ?? "/var/folders/q5/24yvwq2937j076ff04yjn_dc0000gn/T/opencode";
const dbFile = join(tempDir, `cron-service-edge-${RUN_ID}.db`);

rmSync(dbFile, { force: true });
CronSingleton.setDbFile(dbFile);

const cron = CronSingleton.instance;

let passed = 0;
let failed = 0;
let recurringFireCount = 0;
let didFinish = false;

const timeout = setTimeout(() => {
  void finish(1, "Timeout reached before recurring validation finished.");
}, MAX_RUNTIME_MS);

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
    return;
  }

  failed++;
  console.log(`  FAIL: ${label}`);
}

async function finish(code: number, message: string) {
  if (didFinish) {
    return;
  }

  didFinish = true;
  clearTimeout(timeout);
  console.log(`\n${message}`);
  console.log(`=== Results: ${passed} passed, ${failed} failed ===`);

  try {
    cron.destroy();
  } finally {
    CronSingleton.resetDbFile();
    rmSync(dbFile, { force: true });
  }

  process.exit(code);
}

cron.on(RECURRING_NAME, async (ctx) => {
  if (ctx.userId !== USER_A) {
    return;
  }

  recurringFireCount++;
  console.log(`  recurring validation fired ${recurringFireCount}/3`);

  if (recurringFireCount < 3) {
    return;
  }

  const job = await cron.getJob(RECURRING_NAME, USER_A);
  assert(job !== undefined, "recurring job still exists after 3 fires");

  if (job) {
    assert(job.type === ECronJobType.Recurring, "recurring job keeps recurring type");
    assert(job.group === "alerts", "recurring job keeps group payload");
    assert(job.nextRunAt.getTime() > Date.now(), "recurring job rescheduled into future");
    assert(job.lastRunAt !== null, "recurring job records lastRunAt after fire");
  }

  await finish(failed > 0 ? 1 : 0, failed > 0 ? "Edge-case mock found failures." : "Edge-case mock passed.");
});

cron.setup(POLL_INTERVAL_MS);

console.log("=== CronSingleton edge-case mock ===\n");
console.log(`DB file: ${dbFile}`);
console.log(`Poll interval: ${POLL_INTERVAL_MS}ms`);
console.log(`Max runtime: ${MAX_RUNTIME_MS / 60_000} minutes\n`);

console.log("--- 1. Invalid cron pattern ---");
{
  const res = await cron.schedule({
    name: `bad-pattern-${RUN_ID}`,
    userId: USER_A,
    pattern: "not-a-cron",
  });
  assert("error" in res, "invalid pattern returns error");
  if ("error" in res) {
    assert(String(res.error).includes("Invalid cron pattern"), `error message: \"${res.error}\"`);
  }
}

console.log("\n--- 2. Past fireAt for one-time job ---");
{
  const res = await cron.scheduleOnce({
    name: `past-job-${RUN_ID}`,
    userId: USER_A,
    fireAt: new Date(Date.now() - 10_000),
  });
  assert("error" in res, "past fireAt returns error");
  if ("error" in res) {
    assert(
      String(res.error).includes("fireAt must be in the future"),
      `error message: \"${res.error}\"`,
    );
  }
}

console.log("\n--- 3. getJob for non-existent job ---");
{
  const job = await cron.getJob(`does-not-exist-${RUN_ID}`, USER_A);
  assert(job === undefined, "non-existent job returns undefined");
}

console.log("\n--- 4. Unschedule non-existent job ---");
{
  const res = await cron.unschedule(`ghost-job-${RUN_ID}`, USER_A);
  assert("error" in res, "unschedule non-existent returns error");
  if ("error" in res) {
    assert(String(res.error).includes("No job found"), `error message: \"${res.error}\"`);
  }
}

console.log("\n--- 5. Same name across users ---");
{
  const resA = await cron.schedule({
    name: `shared-name-${RUN_ID}`,
    userId: USER_A,
    pattern: "0 9 * * *",
  });
  const resB = await cron.schedule({
    name: `shared-name-${RUN_ID}`,
    userId: USER_B,
    pattern: "0 10 * * *",
  });

  assert(!("error" in resA), "same name for user A schedules");
  assert(!("error" in resB), "same name for user B schedules");

  const jobA = await cron.getJob(`shared-name-${RUN_ID}`, USER_A);
  const jobB = await cron.getJob(`shared-name-${RUN_ID}`, USER_B);
  assert(jobA?.pattern === "0 9 * * *", "user A keeps own pattern");
  assert(jobB?.pattern === "0 10 * * *", "user B keeps own pattern");
}

console.log("\n--- 6. Duplicate protection inside same user ---");
{
  const res = await cron.schedule({
    name: `shared-name-${RUN_ID}`,
    userId: USER_A,
    pattern: "0 11 * * *",
  });
  assert("error" in res, "duplicate recurring in same user returns error");
}

console.log("\n--- 7. Recurring and one-time type conflict ---");
{
  await cron.schedule({
    name: `recurring-first-${RUN_ID}`,
    userId: USER_A,
    pattern: "*/1 * * * *",
  });

  const oneTimeOverRecurring = await cron.scheduleOnce({
    name: `recurring-first-${RUN_ID}`,
    userId: USER_A,
    fireAt: new Date(Date.now() + 60_000),
    overwrite: true,
  });
  assert("error" in oneTimeOverRecurring, "cannot replace recurring with one-time");

  await cron.scheduleOnce({
    name: `one-time-first-${RUN_ID}`,
    userId: USER_A,
    fireAt: new Date(Date.now() + 5 * 60_000),
  });

  const recurringOverOneTime = await cron.schedule({
    name: `one-time-first-${RUN_ID}`,
    userId: USER_A,
    pattern: "*/1 * * * *",
    overwrite: true,
  });
  assert("error" in recurringOverOneTime, "cannot replace one-time with recurring");
}

console.log("\n--- 8. Overwrite same type ---");
{
  const recurringOverwrite = await cron.schedule({
    name: `recurring-first-${RUN_ID}`,
    userId: USER_A,
    pattern: "0 12 * * *",
    overwrite: true,
    group: "alerts",
  });
  assert(!("error" in recurringOverwrite), "overwrite recurring with recurring succeeds");
  if (!("error" in recurringOverwrite)) {
    assert(recurringOverwrite.pattern === "0 12 * * *", "recurring pattern updated");
    assert(recurringOverwrite.group === "alerts", "recurring group updated");
  }

  const oneTimeOverwrite = await cron.scheduleOnce({
    name: `one-time-first-${RUN_ID}`,
    userId: USER_A,
    fireAt: new Date(Date.now() + 10 * 60_000),
    overwrite: true,
    group: "timers",
  });
  assert(!("error" in oneTimeOverwrite), "overwrite one-time with one-time succeeds");
  if (!("error" in oneTimeOverwrite)) {
    assert(oneTimeOverwrite.group === "timers", "one-time group updated");
  }
}

console.log("\n--- 9. Recurring survives repeat fires ---");
{
  const res = await cron.schedule({
    name: RECURRING_NAME,
    userId: USER_A,
    pattern: "*/1 * * * *",
    group: "alerts",
  });
  assert(!("error" in res), "recurring validation job schedules");
}

console.log("\nWaiting for recurring validation job to fire 3 times...");
