import { afterEach, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import { opencodeOAuth } from "./opencode-oauth";

let fetchMock: Mock<(input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>>;
let sleepMock: Mock<typeof Bun.sleep>;

beforeEach(() => {
  fetchMock = spyOn(globalThis, "fetch");
  sleepMock = spyOn(Bun, "sleep").mockResolvedValue(undefined);
});

afterEach(() => {
  fetchMock.mockRestore();
  sleepMock.mockRestore();
});

test("logs in with the device code flow", async () => {
  const tokenResponses = [
    Response.json({ error: "authorization_pending" }, { status: 400 }),
    Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 60 }),
  ];
  fetchMock.mockImplementation(async (input) => {
    if (String(input).endsWith("/auth/device/code")) {
      return Response.json({
        device_code: "device",
        user_code: "ABCD-EFGH",
        verification_uri_complete: "/console/device?user_code=ABCD-EFGH",
        expires_in: 600,
        interval: 5,
      });
    }
    const response = tokenResponses.shift();
    if (response === undefined) {
      throw new Error("Unexpected token poll");
    }
    return response;
  });
  const events: unknown[] = [];

  const credential = await opencodeOAuth.login({
    signal: new AbortController().signal,
    prompt: () => Promise.reject(new Error("No prompt expected")),
    notify: (event) => {
      events.push(event);
    },
  });

  expect(events).toEqual([
    {
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://opencode.ai/console/device?user_code=ABCD-EFGH",
      intervalSeconds: 5,
      expiresInSeconds: 600,
    },
  ]);
  expect(credential).toMatchObject({ type: "oauth", access: "access", refresh: "refresh" });
  expect(credential.expires).toBeGreaterThan(Date.now());
  expect(await opencodeOAuth.toAuth(credential)).toEqual({ apiKey: "access" });
});

test("rotates the refresh token", async () => {
  fetchMock.mockResolvedValue(
    Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 60 }),
  );

  const credential = await opencodeOAuth.refresh(
    { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0 },
    new AbortController().signal,
  );

  expect(credential).toMatchObject({ access: "new-access", refresh: "new-refresh" });
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
    grant_type: "refresh_token",
    refresh_token: "old-refresh",
    client_id: "opencode-cli",
  });
});

test("reports a rejected refresh with its status and error", async () => {
  fetchMock.mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 400 }));

  await expect(
    opencodeOAuth.refresh(
      { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0 },
      new AbortController().signal,
    ),
  ).rejects.toThrow("OpenCode token refresh failed (400): invalid_grant");
});
