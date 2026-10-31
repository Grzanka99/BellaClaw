import type { TOption } from "@bellaclaw/shared";
import type { DAVCalendar, DAVCalendarObject, DAVClient } from "tsdav";
import { requestOptions, resourceFilename } from "./http";

export class CalendarObjectNotFound extends Error {}

export async function fetchCalendarObject(
  client: DAVClient,
  calendar: DAVCalendar,
  filename: string,
  signal?: AbortSignal,
): Promise<DAVCalendarObject> {
  const url = new URL(filename, calendar.url);
  resourceFilename(calendar, url.href);
  // Keep object-level statuses: tsdav's collection helpers throw away their context.
  const responses = await client.davRequest({
    url: calendar.url,
    init: {
      method: "REPORT",
      namespace: "c",
      headers: { depth: "1" },
      body: {
        "calendar-multiget": {
          _attributes: { "xmlns:d": "DAV:", "xmlns:c": "urn:ietf:params:xml:ns:caldav" },
          "d:prop": { "d:getetag": {}, "c:calendar-data": {} },
          "d:href": `${url.pathname}${url.search}`,
        },
      },
    },
    fetchOptions: requestOptions(signal),
  });
  const response = responses.find(
    (item) => item.href !== undefined && new URL(item.href, calendar.url).href === url.href,
  );
  if (response === undefined) {
    throw new Error("iCloud event fetch returned an incomplete response");
  }
  const raw: unknown = response.raw;
  const multistatus = typeof raw === "object" && raw !== null && "multistatus" in raw;
  if (multistatus && response.status === 404 && !response.propStats?.length && !response.error) {
    throw new CalendarObjectNotFound("iCloud event not found (404)");
  }
  if (!multistatus || !response.ok) {
    throw new Error(`iCloud event fetch failed (HTTP ${response.status})`);
  }
  let data: unknown = response.props?.calendarData;
  if (typeof data === "object" && data !== null && "_cdata" in data) {
    data = data._cdata;
  }
  const rawEtag: unknown = response.props?.getetag;
  if (typeof data !== "string") {
    throw new Error("iCloud event fetch returned no calendar data");
  }
  let etag: TOption<string>;
  if (typeof rawEtag === "string") {
    etag = rawEtag;
  }
  return { url: url.href, data, etag };
}
