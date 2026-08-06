import { rm } from "node:fs/promises";

Bun.env.BELLACLAW_DATABASE_MODE = "test";

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
