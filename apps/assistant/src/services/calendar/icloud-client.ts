import type { TOption } from "@bellaclaw/shared";
import { repositoryPath } from "@bellaclaw/shared";
import ICAL from "ical.js";
import { type DAVCalendar, type DAVCalendarObject, DAVClient } from "tsdav";
import { z } from "zod";
import { ICalendarResource } from "./ical";
import { assertResponse, requestOptions, resourceFilename } from "./icloud-http";
import { fetchCalendarObject } from "./icloud-objects";
import type { TProviderCalendar } from "./types";

const SCredentials = z.object({
  username: z.string().min(1),
  appSpecificPassword: z.string().min(1),
});

function hasPrivilege(value: unknown, name: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasPrivilege(item, name));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(
      ([key, child]) =>
        (key.split(":").at(-1) ?? key).replaceAll("-", "").toLowerCase() === name ||
        hasPrivilege(child, name),
    );
  }
  return false;
}

export class ICloudCalendarClient {
  private login: TOption<Promise<void>>;

  public constructor(private client: TOption<DAVClient> = undefined) {}

  public async setup(): Promise<void> {
    if (this.client !== undefined) {
      return;
    }
    const file = Bun.file(repositoryPath(".secrets/icloud-calendar.json"));
    if (!(await file.exists())) {
      throw new Error("iCloud Calendar credentials are missing at .secrets/icloud-calendar.json");
    }
    let credentials: unknown;
    try {
      credentials = await file.json();
    } catch {
      throw new Error("iCloud Calendar credentials must be valid JSON");
    }
    const parsed = SCredentials.safeParse(credentials);
    if (!parsed.success) {
      throw new Error("iCloud Calendar credentials require username and appSpecificPassword");
    }
    this.client = new DAVClient({
      serverUrl: "https://caldav.icloud.com",
      credentials: { username: parsed.data.username, password: parsed.data.appSpecificPassword },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
  }

  private async requireClient(signal?: AbortSignal): Promise<DAVClient> {
    const client = this.client;
    if (client === undefined) {
      throw new Error("iCloud Calendar setup has not completed");
    }
    signal?.throwIfAborted();
    if (client.account === undefined) {
      if (this.login === undefined) {
        client.fetchOptions = requestOptions(signal);
        this.login = client.login({ loadCollections: false, loadObjects: false }).finally(() => {
          client.fetchOptions = undefined;
          this.login = undefined;
        });
      }
      await this.login;
    }
    signal?.throwIfAborted();
    return client;
  }

  public async calendar(calendarId: string, signal?: AbortSignal): Promise<DAVCalendar> {
    const client = await this.requireClient(signal);
    const calendars = await client.fetchCalendars({ fetchOptions: requestOptions(signal) });
    const calendar = calendars.find(
      (candidate) =>
        candidate.url === calendarId && (candidate.components?.includes("VEVENT") ?? true),
    );
    if (calendar === undefined) {
      throw new Error(
        "iCloud calendar is unavailable; use !calendar_discover icloud to find its ID",
      );
    }
    return calendar;
  }

  private async describeCalendar(
    calendar: DAVCalendar,
    signal?: AbortSignal,
  ): Promise<TProviderCalendar> {
    const client = await this.requireClient(signal);
    const responses = await client.propfind({
      url: calendar.url,
      props: { "d:current-user-privilege-set": {} },
      depth: "0",
      fetchOptions: requestOptions(signal),
    });
    const response = responses.find((item) => item.ok);
    const privileges: unknown = response?.props?.currentUserPrivilegeSet;
    const all = hasPrivilege(privileges, "all");
    const write = hasPrivilege(privileges, "write");
    return {
      calendarId: calendar.url,
      summary: undefined,
      readable: all || write || hasPrivilege(privileges, "read"),
      writable:
        all ||
        write ||
        (hasPrivilege(privileges, "writecontent") &&
          hasPrivilege(privileges, "bind") &&
          hasPrivilege(privileges, "unbind")),
      ...(typeof calendar.displayName === "string" && { summary: calendar.displayName }),
    };
  }

  public async discoverCalendars(signal?: AbortSignal): Promise<TProviderCalendar[]> {
    const client = await this.requireClient(signal);
    const calendars = await client.fetchCalendars({ fetchOptions: requestOptions(signal) });
    return Promise.all(
      calendars
        .filter((calendar) => calendar.components?.includes("VEVENT") ?? true)
        .map((calendar) => this.describeCalendar(calendar, signal)),
    );
  }

  public async probeCalendar(calendarId: string, signal?: AbortSignal): Promise<TProviderCalendar> {
    return this.describeCalendar(await this.calendar(calendarId, signal), signal);
  }

  public parseResource(calendar: DAVCalendar, object: DAVCalendarObject): ICalendarResource {
    if (typeof object.data !== "string") {
      throw new Error("iCloud returned an event without calendar data");
    }
    let timezone: TOption<string>;
    if (calendar.timezone) {
      const component = new ICAL.Component(ICAL.parse(calendar.timezone));
      const zone = component.getFirstSubcomponent("vtimezone")?.getFirstPropertyValue("tzid");
      if (typeof zone === "string") {
        timezone = zone;
      }
    }
    return new ICalendarResource(resourceFilename(calendar, object.url), object.data, timezone);
  }

  public async getObject(
    calendar: DAVCalendar,
    filename: string,
    signal?: AbortSignal,
  ): Promise<DAVCalendarObject> {
    const client = await this.requireClient(signal);
    return fetchCalendarObject(client, calendar, filename, signal);
  }

  public async saveObject(
    object: DAVCalendarObject,
    data: string,
    signal?: AbortSignal,
  ): Promise<DAVCalendarObject> {
    if (!object.etag) {
      throw new Error("iCloud event has no ETag; cannot safely modify it");
    }
    const client = await this.requireClient(signal);
    const response = await client.updateCalendarObject({
      calendarObject: { ...object, data },
      fetchOptions: requestOptions(signal),
    });
    assertResponse(response, "update");
    const etag = response.headers.get("etag");
    if (etag !== null) {
      return { ...object, data, etag };
    }
    const calendar = { url: new URL(".", object.url).href };
    const stored = await this.getObject(calendar, resourceFilename(calendar, object.url), signal);
    if (!stored.etag) {
      throw new Error("iCloud stored event has no ETag; cannot safely continue");
    }
    if (
      typeof stored.data !== "string" ||
      new ICAL.Component(ICAL.parse(stored.data)).toString() !==
        new ICAL.Component(ICAL.parse(data)).toString()
    ) {
      throw new Error("iCloud event changed after update; list events again before retrying");
    }
    return stored;
  }

  public async createObject(
    calendar: DAVCalendar,
    resource: ICalendarResource,
    signal?: AbortSignal,
  ): Promise<void> {
    const client = await this.requireClient(signal);
    const response = await client.createCalendarObject({
      calendar,
      filename: resource.filename,
      iCalString: resource.toString(),
      fetchOptions: requestOptions(signal),
    });
    assertResponse(response, "create");
  }

  public async listObjects(
    calendar: DAVCalendar,
    start: string,
    end: string,
    signal?: AbortSignal,
  ): Promise<DAVCalendarObject[]> {
    const client = await this.requireClient(signal);
    return client.fetchCalendarObjects({
      calendar,
      timeRange: { start, end },
      fetchOptions: requestOptions(signal),
    });
  }

  public async deleteObject(object: DAVCalendarObject, signal?: AbortSignal): Promise<void> {
    if (!object.etag) {
      throw new Error("iCloud event has no ETag; cannot safely delete it");
    }
    const client = await this.requireClient(signal);
    const response = await client.deleteCalendarObject({
      calendarObject: object,
      fetchOptions: requestOptions(signal),
    });
    assertResponse(response, "delete");
  }
}
