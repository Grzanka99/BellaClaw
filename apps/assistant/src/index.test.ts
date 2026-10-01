import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each([
  "SIGINT",
  "SIGTERM",
])("%s shutdown persists every queued behavior event", async (signal) => {
  const directory = await mkdtemp(join(tmpdir(), "bellaclaw-shutdown-"));
  const dbPath = join(directory, "behavior.db");
  try {
    const child = Bun.spawn(["bun", "--no-env-file", "src/fixtures/shutdown.ts", dbPath, signal], {
      cwd: join(import.meta.dir, ".."),
      env: { ...Bun.env, BELLACLAW_LOG_DB_PATH: dbPath, BELLACLAW_MCP_PUBLIC_URL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    await new Response(child.stdout).text();
    if ((await child.exited) !== 0) {
      throw new Error(`Shutdown fixture failed: ${stderr}`);
    }
    const database = new Database(dbPath, { readonly: true });
    try {
      const rows = database
        .query<{ metadataJson: string }, []>(
          "SELECT metadataJson FROM app_event_logs WHERE event = 'shutdown.regression' ORDER BY id",
        )
        .all();
      expect(rows.map((row) => JSON.parse(row.metadataJson))).toEqual(
        Array.from({ length: 8 }, (_, sequence) => ({ sequence })),
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
