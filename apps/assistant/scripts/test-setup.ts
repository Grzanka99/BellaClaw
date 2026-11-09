import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

Bun.env.BELLACLAW_DATABASE_MODE = "test";
Bun.env.BELLACLAW_AI_CREDENTIALS_PATH = join(
  tmpdir(),
  `bellaclaw-test-pi-auth-${crypto.randomUUID()}.json`,
);

await rm("./test.db", { force: true });

const schemaPush = Bun.spawn(
  ["bun", "--bun", "drizzle-kit", "push", "--config", "drizzle.test.config.ts"],
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
