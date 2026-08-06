import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { seedAuthFile } from "./seed-auth";

const temporaryDirectories: string[] = [];

function createAccessToken(expires: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expires })).toString("base64url");
  return `${header}.${payload}.signature`;
}

async function createDestinationPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bellaclaw-auth-seed-"));
  temporaryDirectories.push(directory);
  return join(directory, "pi-auth.json");
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("auth seed", () => {
  test("imports Codex auth into Pi format with owner-only permissions", async () => {
    const destinationPath = await createDestinationPath();
    const expires = 2_000_000_000;

    const seeded = await seedAuthFile(
      {
        tokens: {
          access_token: createAccessToken(expires),
          refresh_token: "refresh-token",
          account_id: "account-id",
        },
      },
      destinationPath,
    );

    expect(seeded).toBe(true);
    expect(JSON.parse(await readFile(destinationPath, "utf8"))).toEqual({
      "openai-codex": {
        type: "oauth",
        access: createAccessToken(expires),
        refresh: "refresh-token",
        expires: expires * 1000,
        accountId: "account-id",
      },
    });
    expect((await stat(destinationPath)).mode & 0o777).toBe(0o600);
  });

  test("preserves an existing destination without validating the seed", async () => {
    const destinationPath = await createDestinationPath();
    await Bun.write(destinationPath, "existing");

    expect(await seedAuthFile({}, destinationPath)).toBe(false);
    expect(await readFile(destinationPath, "utf8")).toBe("existing");
  });

  test("resets an existing destination when requested", async () => {
    const destinationPath = await createDestinationPath();
    await Bun.write(destinationPath, "existing");
    const expires = 2_000_000_000;

    const seeded = await seedAuthFile(
      {
        tokens: {
          access_token: createAccessToken(expires),
          refresh_token: "replacement-refresh-token",
          account_id: "account-id",
        },
      },
      destinationPath,
      true,
    );

    expect(seeded).toBe(true);
    expect(JSON.parse(await readFile(destinationPath, "utf8"))).toHaveProperty(
      "openai-codex.refresh",
      "replacement-refresh-token",
    );
    expect((await stat(destinationPath)).mode & 0o777).toBe(0o600);
  });

  test("publishes one complete file when seeders run concurrently", async () => {
    const destinationPath = await createDestinationPath();
    const source = {
      tokens: {
        access_token: createAccessToken(2_000_000_000),
        refresh_token: "refresh-token",
        account_id: "account-id",
      },
    };

    const results = await Promise.all([
      seedAuthFile(source, destinationPath),
      seedAuthFile(source, destinationPath),
    ]);

    expect(results.toSorted()).toEqual([false, true]);
    expect(JSON.parse(await readFile(destinationPath, "utf8"))).toHaveProperty(
      "openai-codex.refresh",
      "refresh-token",
    );
    expect(await readdir(dirname(destinationPath))).toEqual(["pi-auth.json"]);
  });

  test("rejects invalid Codex auth without creating a destination", async () => {
    const destinationPath = await createDestinationPath();

    expect(seedAuthFile({}, destinationPath)).rejects.toThrow("Invalid Codex auth file");
    expect(await Bun.file(destinationPath).exists()).toBe(false);
  });
});
