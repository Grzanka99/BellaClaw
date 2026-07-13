import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "./file-credential-store";

const temporaryDirectories: string[] = [];

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "bellaclaw-credentials-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "pi-auth.json");
  return { path, store: new FileCredentialStore(path) };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("FileCredentialStore", () => {
  test("persists OAuth credentials with owner-only permissions", async () => {
    const { path, store } = await createStore();
    const credential = {
      type: "oauth" as const,
      access: "access-token",
      refresh: "refresh-token",
      expires: 123456789,
      accountId: "account-id",
    };

    await store.modify("openai-codex", async () => credential);

    expect(await store.read("openai-codex")).toEqual(credential);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      "openai-codex": credential,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("serializes modifications and deletes credentials", async () => {
    const { store } = await createStore();

    await Promise.all([
      store.modify("first", async () => ({ type: "api_key", key: "first-key" })),
      store.modify("second", async () => ({ type: "api_key", key: "second-key" })),
    ]);

    expect(await store.read("first")).toEqual({ type: "api_key", key: "first-key" });
    expect(await store.read("second")).toEqual({ type: "api_key", key: "second-key" });

    await store.delete("first");

    expect(await store.read("first")).toBeUndefined();
    expect(await store.read("second")).toEqual({ type: "api_key", key: "second-key" });
  });

  test("rejects invalid persisted credentials", async () => {
    const { path, store } = await createStore();
    await Bun.write(path, '{"openai-codex":{"type":"oauth"}}');
    await chmod(path, 0o600);

    expect(store.read("openai-codex")).rejects.toThrow("Invalid AI credentials file");
  });
});
