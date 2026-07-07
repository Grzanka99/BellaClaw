import { AppLogger } from "../src/services/app-logger";

const turnId = Bun.argv[2];

if (turnId === undefined || turnId.trim().length === 0) {
  console.error("Usage: bun run logs:turn -- <turnId>");
  process.exit(1);
}

const events = await AppLogger.instance.findByTurnId(turnId);

if (events.length === 0) {
  console.log(`No behavior events found for turnId: ${turnId}`);
  await AppLogger.instance.close();
  process.exit(0);
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

await AppLogger.instance.close();

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
