import { existsSync } from "node:fs";
import { AppLogger, getDefaultLogDbPath } from "../src";

const turnId = Bun.argv[2];

if (turnId === undefined || turnId.trim().length === 0) {
  console.error("Usage: bun run logs:turn -- <turnId>");
  process.exitCode = 1;
} else {
  await printTurn(turnId);
}

async function printTurn(turnId: string) {
  const dbPath = getDefaultLogDbPath();

  if (dbPath !== ":memory:" && !existsSync(dbPath)) {
    console.error(`Behavior log database does not exist: ${dbPath}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Querying behavior log database: ${dbPath}`);
  const appLogger = new AppLogger({ dbPath });

  try {
    const events = await appLogger.findByTurnId(turnId);

    if (events.length === 0) {
      console.log(`No behavior events found for turnId: ${turnId}`);
      return;
    }

    for (const event of events) {
      const parts = [
        event.createdAt,
        event.event,
        event.component ?? "-",
        event.toolName ?? "-",
        formatSuccess(event.success),
        formatDuration(event.durationMs),
        event.summary ?? "",
      ];

      console.log(parts.join(" | "));

      if (Object.keys(event.metadata).length > 0) {
        console.log(`  metadata: ${JSON.stringify(event.metadata)}`);
      }

      if (event.error !== null) {
        console.log(`  error: ${event.error}`);
      }
    }
  } finally {
    await appLogger.close();
  }
}

function formatSuccess(success: boolean | null): string {
  if (success === null) {
    return "-";
  }

  if (success) {
    return "ok";
  }

  return "failed";
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return "-";
  }

  return `${durationMs}ms`;
}
