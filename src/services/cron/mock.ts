import { CronSingleton } from "./index";

const RUN_ID = `${Date.now()}`;
const USER_A = `mock-user-a-${RUN_ID}`;
const USER_B = `mock-user-b-${RUN_ID}`;
const RECURRING_NAME = `mock-recurring-${RUN_ID}`;
const ONE_TIME_NAME = `mock-one-time-${RUN_ID}`;
const SHARED_NAME = `mock-shared-${RUN_ID}`;
const POLL_INTERVAL_MS = 1_000;
const ONE_TIME_DELAY_MS = 5_000;
const MAX_RUNTIME_MS = 4 * 60 * 1_000;

const cron = CronSingleton.instance;
const trackedJobs: Array<{ name: string; userId: string }> = [];

let sawOneTime = false;
let recurringFireCount = 0;
let didFinish = false;

const timeout = setTimeout(() => {
  void finish(1, "Timeout reached before cron mock completed.");
}, MAX_RUNTIME_MS);

function trackJob(name: string, userId: string) {
  trackedJobs.push({ name, userId });
}

async function cleanup() {
  for (const job of trackedJobs) {
    await cron.unschedule(job.name, job.userId);
  }
}

async function finish(code: number, message: string) {
  if (didFinish) {
    return;
  }

  didFinish = true;
  clearTimeout(timeout);
  console.log(`\n${message}`);

  try {
    await cleanup();
  } finally {
    cron.destroy();
  }

  process.exit(code);
}

async function verifyAndMaybeFinish() {
  if (!sawOneTime || recurringFireCount < 3) {
    return;
  }

  const recurringJob = await cron.getJob(RECURRING_NAME, USER_A);
  const oneTimeJob = await cron.getJob(ONE_TIME_NAME, USER_A);
  const userAJobs = await cron.getAllJobs(USER_A);
  const userBJobs = await cron.getAllJobs(USER_B);

  if (!recurringJob) {
    await finish(1, "Recurring job missing after 3 fires.");
    return;
  }

  if (oneTimeJob !== undefined) {
    await finish(1, "One-time job still exists after firing.");
    return;
  }

  if (recurringJob.group !== "alerts") {
    await finish(1, `Recurring job group mismatch: ${String(recurringJob.group)}`);
    return;
  }

  if (userAJobs.length !== 2) {
    await finish(1, `User A job count mismatch: expected 2, got ${userAJobs.length}`);
    return;
  }

  if (userBJobs.length !== 1) {
    await finish(1, `User B job count mismatch: expected 1, got ${userBJobs.length}`);
    return;
  }

  await finish(0, "Cron mock completed successfully.");
}

cron.on(RECURRING_NAME, (ctx) => {
  if (ctx.userId !== USER_A) {
    return;
  }

  recurringFireCount++;
  console.log(
    `[RECURRING] count=${recurringFireCount}/3 userId=${ctx.userId} group=${ctx.group ?? "none"}`,
  );
  void verifyAndMaybeFinish();
});

cron.on(ONE_TIME_NAME, (ctx) => {
  if (ctx.userId !== USER_A) {
    return;
  }

  sawOneTime = true;
  console.log(`[ONE-TIME] fired userId=${ctx.userId} group=${ctx.group ?? "none"}`);
  void verifyAndMaybeFinish();
});

cron.setup(POLL_INTERVAL_MS);

console.log("=== CronSingleton mock ===\n");
console.log(`Poll interval: ${POLL_INTERVAL_MS}ms`);
console.log(`Max runtime: ${MAX_RUNTIME_MS / 60_000} minutes\n`);

console.log("--- 1. Schedule recurring job ---");
const recurring = await cron.schedule({
  name: RECURRING_NAME,
  userId: USER_A,
  pattern: "*/1 * * * *",
  group: "alerts",
});

if ("error" in recurring) {
  await finish(1, `Failed to schedule recurring job: ${String(recurring.error)}`);
} else {
  trackJob(RECURRING_NAME, USER_A);
  console.log(JSON.stringify(recurring, null, 2));
}

console.log("\n--- 2. Schedule one-time job ---");
const oneTime = await cron.scheduleOnce({
  name: ONE_TIME_NAME,
  userId: USER_A,
  fireAt: new Date(Date.now() + ONE_TIME_DELAY_MS),
  group: "timers",
});

if ("error" in oneTime) {
  await finish(1, `Failed to schedule one-time job: ${String(oneTime.error)}`);
} else {
  trackJob(ONE_TIME_NAME, USER_A);
  console.log(JSON.stringify(oneTime, null, 2));
}

console.log("\n--- 3. Schedule same name for different users ---");
const sharedA = await cron.schedule({
  name: SHARED_NAME,
  userId: USER_A,
  pattern: "0 9 * * *",
});
const sharedB = await cron.schedule({
  name: SHARED_NAME,
  userId: USER_B,
  pattern: "0 10 * * *",
});

if ("error" in sharedA) {
  await finish(1, `Failed to schedule shared job for user A: ${String(sharedA.error)}`);
} else {
  trackJob(SHARED_NAME, USER_A);
  console.log(`User A shared pattern: ${sharedA.pattern}`);
}

if ("error" in sharedB) {
  await finish(1, `Failed to schedule shared job for user B: ${String(sharedB.error)}`);
} else {
  trackJob(SHARED_NAME, USER_B);
  console.log(`User B shared pattern: ${sharedB.pattern}`);
}

console.log("\n--- 4. Duplicate protection in same user ---");
const duplicate = await cron.schedule({
  name: RECURRING_NAME,
  userId: USER_A,
  pattern: "0 12 * * *",
});
console.log("Duplicate result:", "error" in duplicate ? duplicate.error : "unexpected success");

console.log("\n--- 5. Read back current jobs ---");
const userAJobs = await cron.getAllJobs(USER_A);
const userBJobs = await cron.getAllJobs(USER_B);
console.log(`User A jobs: ${userAJobs.length}`);
for (const job of userAJobs) {
  console.log(`  - ${job.name} | type=${job.type} | group=${job.group ?? "none"}`);
}
console.log(`User B jobs: ${userBJobs.length}`);
for (const job of userBJobs) {
  console.log(`  - ${job.name} | type=${job.type} | group=${job.group ?? "none"}`);
}

console.log("\n--- 6. Wait for current behavior checks ---");
console.log("Need: one-time fire once, recurring fire 3 times for user A.");
