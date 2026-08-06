import { describe, expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { REPOSITORY_ROOT, repositoryPath } from "./paths";

describe("repository paths", () => {
  test("resolves the root BellaClaw manifest rather than a workspace manifest", async () => {
    const manifestPath = repositoryPath("package.json");
    const manifest = await Bun.file(manifestPath).json();

    expect(manifest.name).toBe("bellaclaw");
    expect(manifest.workspaces).toEqual(["apps/*", "packages/*"]);
  });

  test("sits above every workspace, so each workspace manifest is reachable", async () => {
    expect(isAbsolute(REPOSITORY_ROOT)).toBe(true);

    const names = await Promise.all(
      [
        "apps/assistant/package.json",
        "apps/log-viewer/package.json",
        "packages/behavior-logs/package.json",
        "packages/shared/package.json",
      ].map(async (relativePath) => (await Bun.file(repositoryPath(relativePath)).json()).name),
    );

    expect(names).toEqual([
      "@bellaclaw/assistant",
      "@bellaclaw/log-viewer",
      "@bellaclaw/behavior-logs",
      "@bellaclaw/shared",
    ]);
  });
});
