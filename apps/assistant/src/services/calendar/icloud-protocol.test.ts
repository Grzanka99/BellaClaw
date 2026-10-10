import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { calendarData, invitedOccurrence, marchApril, weekly } from "./fixtures/ical-events";
import { ICloudTestServer } from "./fixtures/icloud-server";
import { ECalendarProvider } from "./types";

describe("iCloud over tsdav HTTP/XML", () => {
  let server: ICloudTestServer;
  beforeEach(() => {
    server = new ICloudTestServer();
  });
  afterEach(() => {
    server.stop();
  });

  test("creates, reads, updates, searches and deletes an ordinary event", async () => {
    const created = await server.provider.createEvent(server.calendarId, {
      userId: "chat-test",
      summary: "Lunch & planning",
      description: "Notes <private>",
      start: "2026-03-29T09:00:00+02:00",
      durationMinutes: 45,
      timezone: "Europe/Amsterdam",
    });
    expect(created).toMatchObject({
      provider: ECalendarProvider.ICloud,
      summary: "Lunch & planning",
      description: "Notes <private>",
      start: { dateTime: "2026-03-29T07:00:00.000Z", timeZone: "Europe/Amsterdam" },
      end: { dateTime: "2026-03-29T07:45:00.000Z" },
    });
    expect(server.writes[0]?.headers.get("if-none-match")).toBe("*");
    expect(await server.provider.listEvents(server.calendarId, marchApril)).toHaveLength(1);
    const updated = await server.provider.updateEvent(server.calendarId, {
      userId: "chat-test",
      eventId: created.id,
      scope: "series",
      patch: { summary: "New lunch", location: "Cafe" },
    });
    expect(updated.summary).toBe("New lunch");
    expect(server.writes[1]?.headers.get("if-match")).toBe(created.etag);
    const matches = await server.provider.listEvents(server.calendarId, {
      ...marchApril,
      query: "CAFE",
    });
    expect(matches.map((event) => event.id)).toEqual([created.id]);
    expect(
      await server.provider.listEvents(server.calendarId, { ...marchApril, query: "absent" }),
    ).toEqual([]);
    await server.provider.deleteEvent(server.calendarId, {
      userId: "chat-test",
      eventId: created.id,
      scope: "series",
    });
    expect(server.writes[2]?.headers.get("if-match")).toBe(updated.etag);
    expect(await server.provider.listEvents(server.calendarId, marchApril)).toEqual([]);
    // An invitation to one occurrence has no series master; it is listed but not editable.
    server.seed(calendarData(invitedOccurrence), "invite.ics");
    const invited = await server.provider.listEvents(server.calendarId, marchApril);
    expect(invited.map((event) => event.start.dateTime)).toEqual(["2026-04-05T09:00:00.000Z"]);
    await expect(
      server.provider.deleteEvent(server.calendarId, {
        userId: "chat-test",
        eventId: invited[0]?.id ?? "",
        scope: "occurrence",
      }),
    ).rejects.toThrow("read-only");
    const report = server.requests.find((request) => request.body.includes("calendar-query"));
    expect(report?.body).toContain('start="20260301T000000Z"');
    expect(report?.body).toContain('end="20260501T000000Z"');
  });

  test("restores the series after trim or successor failure using a verified ETag", async () => {
    for (const failedStep of ["trim", "successor"]) {
      const original = server.seed(calendarData(weekly));
      server.requests.length = 0;
      server.intercept = (request) => {
        if (request.method === "PUT" && request.headers.has("if-match")) {
          server.objects.set(request.path, { data: request.body, etag: '"trimmed"' });
          if (failedStep === "trim" && server.writes.length === 1) {
            return new Response(null, { status: 503 });
          }
          return new Response(null, { status: 204 });
        }
        if (request.method === "PUT" && request.headers.get("if-none-match") === "*") {
          return new Response(null, { status: 503 });
        }
        return undefined;
      };
      await expect(
        server.provider.updateEvent(server.calendarId, {
          userId: "chat-test",
          eventId: "series.ics#2026-03-29T07:00:00Z",
          scope: "following",
          patch: { summary: "Future planning" },
        }),
      ).rejects.toThrow("original series restored");
      if (failedStep === "trim") {
        expect(server.writes).toHaveLength(2);
      } else {
        expect(server.writes).toHaveLength(3);
      }
      expect(server.writes.at(-1)?.headers.get("if-match")).toBe('"trimmed"');
      expect(server.objects.get("/home/shared/series.ics")?.data).toBe(original.data);
    }
  });
});
