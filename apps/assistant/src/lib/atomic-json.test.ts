import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomically } from "./atomic-json";

test("cleans up temporary credential files when the final rename fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bellaclaw-atomic-json-"));
  const path = join(directory, "credentials.json");
  await mkdir(path);

  try {
    await expect(writeJsonAtomically(path, { token: "secret" })).rejects.toThrow();
    expect(await readdir(directory)).toEqual(["credentials.json"]);
    expect((await stat(path)).isDirectory()).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
