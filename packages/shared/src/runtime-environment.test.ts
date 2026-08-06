import { describe, expect, test } from "bun:test";
import { repositoryPath } from "./paths";

describe("runtime environment", () => {
  test("preserves root environment variables across workspace boundaries", async () => {
    const turbo = await Bun.file(repositoryPath("turbo.json")).json();

    expect(turbo.tasks.dev.passThroughEnv).toEqual(["*"]);
    expect(turbo.tasks.start.passThroughEnv).toEqual(["*"]);

    const runtimeScripts: [string, string][] = [
      ["apps/assistant/package.json", "auth:generate-token"],
      ["apps/assistant/package.json", "auth:reset-local"],
      ["apps/assistant/package.json", "auth:seed-local"],
      ["apps/assistant/package.json", "db"],
      ["apps/assistant/package.json", "dev"],
      ["apps/assistant/package.json", "start"],
      ["apps/log-viewer/package.json", "dev"],
      ["apps/log-viewer/package.json", "start"],
      ["packages/behavior-logs/package.json", "logs:turn"],
    ];

    for (const [manifestPath, scriptName] of runtimeScripts) {
      const manifest = await Bun.file(repositoryPath(manifestPath)).json();

      expect(manifest.scripts[scriptName]).toContain("--env-file=../../.env");
    }
  });
});
