import { describe, expect, test } from "bun:test";
import { realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createGwsWorkingDirectory, GwsCalendarClient, gwsEnvironment } from "./gws";

describe("gws environment", () => {
  test("removes credentials that could override the fixed service account file", () => {
    const original = {
      token: Bun.env.GOOGLE_WORKSPACE_CLI_TOKEN,
      credentials: Bun.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS,
      credentialsFile: Bun.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE,
      clientId: Bun.env.GOOGLE_WORKSPACE_CLI_CLIENT_ID,
      clientSecret: Bun.env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET,
      account: Bun.env.GOOGLE_WORKSPACE_CLI_ACCOUNT,
      impersonatedUser: Bun.env.GOOGLE_WORKSPACE_CLI_IMPERSONATED_USER,
      applicationCredentials: Bun.env.GOOGLE_APPLICATION_CREDENTIALS,
      accessToken: Bun.env.GOOGLE_OAUTH_ACCESS_TOKEN,
    };
    Bun.env.GOOGLE_WORKSPACE_CLI_TOKEN = "token";
    Bun.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS = "credentials";
    Bun.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = "other-file";
    Bun.env.GOOGLE_WORKSPACE_CLI_CLIENT_ID = "client-id";
    Bun.env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET = "client-secret";
    Bun.env.GOOGLE_WORKSPACE_CLI_ACCOUNT = "account";
    Bun.env.GOOGLE_WORKSPACE_CLI_IMPERSONATED_USER = "user@example.com";
    Bun.env.GOOGLE_APPLICATION_CREDENTIALS = "application-file";
    Bun.env.GOOGLE_OAUTH_ACCESS_TOKEN = "access-token";

    try {
      const env = gwsEnvironment();
      expect(env.GOOGLE_WORKSPACE_CLI_TOKEN).toBeUndefined();
      expect(env.GOOGLE_WORKSPACE_CLI_CREDENTIALS).toBeUndefined();
      expect(env.GOOGLE_WORKSPACE_CLI_CLIENT_ID).toBeUndefined();
      expect(env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET).toBeUndefined();
      expect(env.GOOGLE_WORKSPACE_CLI_ACCOUNT).toBeUndefined();
      expect(env.GOOGLE_WORKSPACE_CLI_IMPERSONATED_USER).toBeUndefined();
      expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
      expect(env.GOOGLE_OAUTH_ACCESS_TOKEN).toBeUndefined();
      expect(env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE).toEndWith(
        "/.secrets/google-calendar-service-account.json",
      );
    } finally {
      Bun.env.GOOGLE_WORKSPACE_CLI_TOKEN = original.token;
      Bun.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS = original.credentials;
      Bun.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = original.credentialsFile;
      Bun.env.GOOGLE_WORKSPACE_CLI_CLIENT_ID = original.clientId;
      Bun.env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET = original.clientSecret;
      Bun.env.GOOGLE_WORKSPACE_CLI_ACCOUNT = original.account;
      Bun.env.GOOGLE_WORKSPACE_CLI_IMPERSONATED_USER = original.impersonatedUser;
      Bun.env.GOOGLE_APPLICATION_CREDENTIALS = original.applicationCredentials;
      Bun.env.GOOGLE_OAUTH_ACCESS_TOKEN = original.accessToken;
    }
  });

  test("uses a neutral temporary working directory and fixed credentials path", async () => {
    const directory = await createGwsWorkingDirectory();
    try {
      expect(await realpath(dirname(directory))).toBe(await realpath(tmpdir()));
      expect(directory.startsWith(process.cwd())).toBe(false);
      expect(await Bun.file(`${directory}/.env`).text()).toBe("");
      expect(gwsEnvironment().GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE).toBe(
        resolve(process.cwd(), "../..", ".secrets/google-calendar-service-account.json"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("gws pagination", () => {
  test("rejects aggregate output that exceeds the cross-page byte budget", async () => {
    let calls = 0;
    const client = new GwsCalendarClient(async () => {
      calls += 1;
      return {
        items: [{ description: "x".repeat(4_300_000) }],
        nextPageToken: `page-${calls}`,
      };
    });

    await expect(client.listEvents("calendar", {})).rejects.toThrow(
      "gws aggregate result exceeded",
    );
    expect(calls).toBe(2);
  });
});
