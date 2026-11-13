import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRIZZLE_TEST_CONFIG_PATH } from "@bellaclaw/database";

Bun.env.BELLACLAW_DATABASE_MODE = "test";
Bun.env.BELLACLAW_AI_CREDENTIALS_PATH = join(
  tmpdir(),
  `bellaclaw-test-pi-auth-${crypto.randomUUID()}.json`,
);

await rm("./test.db", { force: true });

const schemaPush = Bun.spawn(
  ["bun", "--bun", "drizzle-kit", "push", "--config", DRIZZLE_TEST_CONFIG_PATH],
  {
    env: Bun.env,
    stderr: "inherit",
    stdout: "inherit",
  },
);

const exitCode = await schemaPush.exited;

if (exitCode !== 0) {
  throw new Error("Failed to prepare test database schema");
}
