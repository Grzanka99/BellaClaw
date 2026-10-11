import type { TOption } from "@bellaclaw/shared";
import { runGws, type TGwsRunner } from "./gws-runner";

const MAX_AGGREGATE_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 20;
const MAX_ITEMS = 50_000;

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
  if (Array.isArray(value)) {
    return value;
  }
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

export class GwsCalendarClient {
  public constructor(private runner: TGwsRunner = runGws) {}

  public async listCalendars(
    signal?: AbortSignal,
  ): Promise<Array<{ id: string; summary: TOption<string>; accessRole: TOption<string> }>> {
    const calendars: Array<{ id: string; summary: TOption<string>; accessRole: TOption<string> }> =
      [];
    let pageToken: TOption<string>;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params: Record<string, unknown> = { maxResults: 250 };
      if (pageToken !== undefined) {
        params.pageToken = pageToken;
      }
      const result = await this.runner({
        resource: "calendarList",
        method: "list",
        params,
        body: undefined,
        signal,
      });
      for (const item of readItems(result)) {
        const id = readStringProperty(item, "id");
        if (id !== undefined) {
          calendars.push({
            id,
            summary: readStringProperty(item, "summary"),
            accessRole: readStringProperty(item, "accessRole"),
          });
        }
      }
      pageToken = readPageToken(result);
      if (pageToken === undefined) {
        return calendars;
      }
    }
    throw new Error(`gws calendar pagination exceeded ${MAX_PAGES} pages`);
  }

  public async probeCalendar(
    calendarId: string,
    signal?: AbortSignal,
  ): Promise<{ accessRole: TOption<string>; summary: TOption<string> }> {
    const value = await this.runner({
      resource: "events",
      method: "list",
      params: { calendarId, maxResults: 1 },
      body: undefined,
      signal,
    });
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
    let aggregateBytes = 0;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const pageParams: Record<string, unknown> = { ...params, calendarId };
      if (pageToken !== undefined) {
        pageParams.pageToken = pageToken;
      }
      const value = await this.runner({
        resource: "events",
        method: "list",
        params: pageParams,
        body: undefined,
        signal,
      });
      aggregateBytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (aggregateBytes > MAX_AGGREGATE_BYTES) {
        throw new Error(`gws aggregate result exceeded ${MAX_AGGREGATE_BYTES} bytes`);
      }
      items.push(...readItems(value));
      if (items.length > MAX_ITEMS) {
        throw new Error(`gws result exceeded ${MAX_ITEMS} items`);
      }
      if (typeof value === "object" && value !== null) {
        if ("accessRole" in value && typeof value.accessRole === "string") {
          accessRole = value.accessRole;
        }
        if ("summary" in value && typeof value.summary === "string") {
          summary = value.summary;
        }
      }
      pageToken = readPageToken(value);
      if (pageToken === undefined) {
        return { accessRole, summary, items };
      }
    }
    throw new Error(`gws pagination exceeded ${MAX_PAGES} pages`);
  }

  public getEvent(calendarId: string, eventId: string, signal?: AbortSignal): Promise<unknown> {
    return this.runner({
      resource: "events",
      method: "get",
      params: { calendarId, eventId },
      body: undefined,
      signal,
    });
  }

  public insertEvent(
    calendarId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.runner({
      resource: "events",
      method: "insert",
      params: { calendarId },
      body,
      signal,
    });
  }

  public patchEvent(
    calendarId: string,
    eventId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.runner({
      resource: "events",
      method: "patch",
      params: { calendarId, eventId },
      body,
      signal,
    });
  }

  public deleteEvent(calendarId: string, eventId: string, signal?: AbortSignal): Promise<unknown> {
    return this.runner({
      resource: "events",
      method: "delete",
      params: { calendarId, eventId },
      body: undefined,
      signal,
    });
  }
}
