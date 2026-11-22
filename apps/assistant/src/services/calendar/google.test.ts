import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleCalendarClient } from "./google";

const originalFetch = globalThis.fetch;
let directory = "";
let keyFile = "";

type TCall = { url: string; method: string; headers: Headers; body: string };

function stubFetch(handler: (call: TCall) => Response): TCall[] {
  const calls: TCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tokenOr(call: TCall, response: () => Response): Response {
  if (call.url === "https://oauth2.googleapis.com/token") {
    return json({ access_token: "access-token", expires_in: 3599 });
  }
  return response();
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
    "base64",
  );
  directory = await mkdtemp(join(tmpdir(), "bellaclaw-google-"));
  keyFile = join(directory, "key.json");
  await writeFile(
    keyFile,
    JSON.stringify({
      client_email: "bella@example.iam.gserviceaccount.com",
      private_key: `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----\n`,
    }),
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("GoogleCalendarClient", () => {
  test("signs a service-account assertion once and reuses the access token", async () => {
    const calls = stubFetch((call) => tokenOr(call, () => json({ id: "event" })));
    const client = new GoogleCalendarClient(keyFile);

    await client.getEvent("primary", "event");
    await client.getEvent("primary", "event");

    const tokenCalls = calls.filter((call) => call.url === "https://oauth2.googleapis.com/token");
    expect(tokenCalls).toHaveLength(1);
    const form = new URLSearchParams(tokenCalls[0]?.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const claims = JSON.parse(
      Buffer.from(String(form.get("assertion")).split(".")[1] ?? "", "base64url").toString(),
    );
    expect(claims.iss).toBe("bella@example.iam.gserviceaccount.com");
    expect(claims.scope).toBe("https://www.googleapis.com/auth/calendar");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(3600);

    const apiCalls = calls.filter((call) => call.url !== "https://oauth2.googleapis.com/token");
    expect(apiCalls).toHaveLength(2);
    expect(apiCalls[0]?.url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/event",
    );
    expect(apiCalls[0]?.headers.get("authorization")).toBe("Bearer access-token");
  });

  test("follows page tokens and keeps the calendar's access role", async () => {
    const calls = stubFetch((call) =>
      tokenOr(call, () => {
        const url = new URL(call.url);
        if (url.searchParams.get("pageToken") === null) {
          return json({ accessRole: "writer", items: [{ id: "a" }], nextPageToken: "next" });
        }
        return json({ items: [{ id: "b" }] });
      }),
    );
    const client = new GoogleCalendarClient(keyFile);

    const result = await client.listEvents("team@group.calendar.google.com", {
      singleEvents: true,
      maxResults: 2500,
    });

    expect(result.items).toEqual([{ id: "a" }, { id: "b" }]);
    expect(result.accessRole).toBe("writer");
    const second = new URL(calls.at(-1)?.url ?? "");
    expect(second.pathname).toBe("/calendar/v3/calendars/team%40group.calendar.google.com/events");
    expect(second.searchParams.get("pageToken")).toBe("next");
    expect(second.searchParams.get("singleEvents")).toBe("true");
  });

  test("turns a non-2xx response into an error with Google's status and message", async () => {
    stubFetch((call) =>
      tokenOr(call, () =>
        json({ error: { code: 409, message: "The requested identifier already exists." } }, 409),
      ),
    );
    const client = new GoogleCalendarClient(keyFile);

    await expect(client.insertEvent("primary", { id: "abc" })).rejects.toThrow(
      "Google Calendar POST failed with HTTP 409: The requested identifier already exists.",
    );
  });
});
