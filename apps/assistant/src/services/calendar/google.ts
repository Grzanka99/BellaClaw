import type { TOption } from "@bellaclaw/shared";
import { repositoryPath } from "@bellaclaw/shared";
import { z } from "zod";

const TIMEOUT_MS = 30_000;
const MAX_PAGES = 20;
const TOKEN_LIFETIME_SECONDS = 3600;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const CREDENTIALS_FILE = repositoryPath(".secrets/google-calendar-service-account.json");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

const SServiceAccountKey = z.object({
  client_email: z.string(),
  private_key: z.string(),
});

const STokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
});

const STokenError = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

const SApiError = z.object({
  error: z.object({ message: z.string() }),
});

export type TCalendarProbe = { accessRole: TOption<string>; summary: TOption<string> };

type TAccessToken = { value: string; expiresAt: number };

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function requestSignal(signal: TOption<AbortSignal>): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  if (signal === undefined) {
    return timeout;
  }
  return AbortSignal.any([signal, timeout]);
}

function readPageToken(value: unknown): TOption<string> {
  if (typeof value !== "object" || value === null || !("nextPageToken" in value)) {
    return undefined;
  }
  if (typeof value.nextPageToken === "string") {
    return value.nextPageToken;
  }
  return undefined;
}

function readItems(value: unknown): unknown[] {
  if (
    typeof value === "object" &&
    value !== null &&
    "items" in value &&
    Array.isArray(value.items)
  ) {
    return value.items;
  }
  return [];
}

function readStringProperty(value: unknown, key: string): TOption<string> {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = Reflect.get(value, key);
  if (typeof candidate === "string") {
    return candidate;
  }
  return undefined;
}

export class GoogleCalendarClient {
  private token: TOption<TAccessToken>;

  public constructor(private credentialsFile: string = CREDENTIALS_FILE) {}

  public async probeCalendar(calendarId: string, signal?: AbortSignal): Promise<TCalendarProbe> {
    const value = await this.request(
      "GET",
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      { maxResults: 1 },
      undefined,
      signal,
    );
    return {
      accessRole: readStringProperty(value, "accessRole"),
      summary: readStringProperty(value, "summary"),
    };
  }

  public async listEvents(
    calendarId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ accessRole: TOption<string>; summary: TOption<string>; items: unknown[] }> {
    const items: unknown[] = [];
    let pageToken: TOption<string>;
    let accessRole: TOption<string>;
    let summary: TOption<string>;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const pageParams: Record<string, unknown> = { ...params };
      if (pageToken !== undefined) {
        pageParams.pageToken = pageToken;
      }
      const value = await this.request(
        "GET",
        `/calendars/${encodeURIComponent(calendarId)}/events`,
        pageParams,
        undefined,
        signal,
      );
      items.push(...readItems(value));
      accessRole = readStringProperty(value, "accessRole") ?? accessRole;
      summary = readStringProperty(value, "summary") ?? summary;
      pageToken = readPageToken(value);
      if (pageToken === undefined) {
        return { accessRole, summary, items };
      }
    }
    throw new Error(`Google Calendar pagination exceeded ${MAX_PAGES} pages`);
  }

  public getEvent(calendarId: string, eventId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", this.eventPath(calendarId, eventId), {}, undefined, signal);
  }

  public insertEvent(
    calendarId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      {},
      body,
      signal,
    );
  }

  public patchEvent(
    calendarId: string,
    eventId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request("PATCH", this.eventPath(calendarId, eventId), {}, body, signal);
  }

  public deleteEvent(calendarId: string, eventId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request("DELETE", this.eventPath(calendarId, eventId), {}, undefined, signal);
  }

  private eventPath(calendarId: string, eventId: string): string {
    return `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  }

  private async request(
    method: string,
    path: string,
    params: Record<string, unknown>,
    body: TOption<Record<string, unknown>>,
    signal: TOption<AbortSignal>,
  ): Promise<unknown> {
    const url = new URL(`${CALENDAR_API}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.accessToken(signal)}`,
    };
    let payload: TOption<string>;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const response = await fetch(url, {
      method,
      headers,
      body: payload,
      signal: requestSignal(signal),
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = response.statusText;
      const parsed = SApiError.safeParse(parseJson(text));
      if (parsed.success) {
        detail = parsed.data.error.message;
      }
      throw new Error(`Google Calendar ${method} failed with HTTP ${response.status}: ${detail}`);
    }
    if (text.trim().length === 0) {
      return {};
    }
    return JSON.parse(text);
  }

  private async accessToken(signal: TOption<AbortSignal>): Promise<string> {
    if (this.token !== undefined && this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return this.token.value;
    }

    const key = SServiceAccountKey.safeParse(
      parseJson(await Bun.file(this.credentialsFile).text()),
    );
    if (!key.success) {
      throw new Error(
        "Google Calendar service-account key is not valid JSON with client_email and private_key",
      );
    }

    const issuedAt = Math.floor(Date.now() / 1000);
    const header = base64Url(
      new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    );
    const claims = base64Url(
      new TextEncoder().encode(
        JSON.stringify({
          iss: key.data.client_email,
          scope: CALENDAR_SCOPE,
          aud: TOKEN_URL,
          iat: issuedAt,
          exp: issuedAt + TOKEN_LIFETIME_SECONDS,
        }),
      ),
    );
    const der = Buffer.from(
      key.data.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s/g, ""),
      "base64",
    );
    const signingKey = await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      signingKey,
      new TextEncoder().encode(`${header}.${claims}`),
    );

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${header}.${claims}.${base64Url(new Uint8Array(signature))}`,
      }),
      signal: requestSignal(signal),
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = response.statusText;
      const parsed = STokenError.safeParse(parseJson(text));
      if (parsed.success) {
        detail = parsed.data.error_description ?? parsed.data.error;
      }
      throw new Error(`Google token request failed with HTTP ${response.status}: ${detail}`);
    }
    const token = STokenResponse.safeParse(JSON.parse(text));
    if (!token.success) {
      throw new Error("Google token response is missing access_token or expires_in");
    }
    this.token = {
      value: token.data.access_token,
      expiresAt: Date.now() + token.data.expires_in * 1000,
    };
    return this.token.value;
  }
}
