import { afterEach, expect, test } from "bun:test";
import { resetCronEngineJobsTable } from "../database/test-utils";
import { DefaultConfigRecord, EConfigKey } from "../settings/schema";
import { CronSingleton } from "./index";

afterEach(() => CronSingleton.instance.destroy());

test("recreates a destroyed singleton and uses the default timezone", async () => {
  await resetCronEngineJobsTable();
  const first = CronSingleton.instance;
  expect(CronSingleton.instance).toBe(first);
  first.destroy();
  const second = CronSingleton.instance;
  expect(second).not.toBe(first);

  const job = await second.createRecurring({ name: "default-timezone", pattern: "0 9 * * *" });
  expect(job).toMatchObject({ timezone: DefaultConfigRecord[EConfigKey.AiInstructionsTimezone] });
});
