import type { TOption } from "@bellaclaw/shared";
import { DAVClient } from "tsdav";
import { ICloudCalendarProvider } from "../icloud";
import { ICloudCalendarClient } from "../icloud-client";

type TStoredObject = { data: string; etag: string };
export type TDAVRequest = { method: string; path: string; body: string; headers: Headers };

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function propertyResponse(path: string, properties: string): string {
  return `<d:response><d:href>${xml(path)}</d:href><d:propstat><d:prop>${properties}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function multistatus(responses: string[]): Response {
  return new Response(
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses.join("")}</d:multistatus>`,
    { status: 207, headers: { "content-type": "application/xml; charset=utf-8" } },
  );
}

/** A local CalDAV endpoint: production tsdav performs every request and XML decode. */
export class ICloudTestServer {
  public readonly objects = new Map<string, TStoredObject>();
  public readonly requests: TDAVRequest[] = [];
  public intercept: TOption<(request: TDAVRequest) => TOption<Response>>;
  private revision = 1;
  private server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const record = {
        method: request.method,
        path: new URL(request.url).pathname,
        body: await request.text(),
        headers: request.headers,
      };
      this.requests.push(record);
      const intercepted = this.intercept?.(record);
      if (intercepted !== undefined) {
        return intercepted;
      }
      return this.respond(record);
    },
  });
  public readonly calendarId = new URL("/home/shared/", this.server.url).href;
  public readonly dav = new DAVClient({
    serverUrl: this.server.url.href,
    credentials: { username: "dedicated-apple-account", password: "test-app-password" },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  public readonly client = new ICloudCalendarClient(this.dav);
  public readonly provider = new ICloudCalendarProvider(this.client);

  public constructor() {
    this.dav.account = {
      accountType: "caldav",
      serverUrl: this.server.url.href,
      rootUrl: this.server.url.href,
      homeUrl: new URL("/home/", this.server.url).href,
    };
  }

  public stop(): void {
    this.server.stop(true);
  }

  public seed(data: string, filename = "series.ics"): TStoredObject {
    const object = { data, etag: `"v${this.revision++}"` };
    this.objects.set(`/home/shared/${filename}`, object);
    return object;
  }

  public get writes(): TDAVRequest[] {
    return this.requests.filter((request) => ["PUT", "DELETE"].includes(request.method));
  }

  private respond(request: TDAVRequest): Response {
    const { method, path, body, headers } = request;
    if (method === "PROPFIND") {
      if (path === "/home/") {
        return multistatus([
          propertyResponse(
            "/home/shared/",
            '<d:displayname>Shared calendar</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>',
          ),
        ]);
      }
      if (path === "/home/shared/") {
        return multistatus([
          propertyResponse(
            path,
            "<d:supported-report-set><d:supported-report><d:report><c:calendar-multiget/></d:report></d:supported-report></d:supported-report-set>",
          ),
        ]);
      }
    }
    if (method === "REPORT") {
      let paths = [...this.objects.keys()];
      if (body.includes("calendar-multiget")) {
        paths = body
          .split("<d:href>")
          .slice(1)
          .map((part) => part.split("</d:href>")[0] ?? "");
      }
      return multistatus(
        paths.map((url) => {
          const object = this.objects.get(url);
          if (object === undefined) {
            return `<d:response><d:href>${xml(url)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;
          }
          return propertyResponse(
            url,
            `<d:getetag>${xml(object.etag)}</d:getetag><c:calendar-data>${xml(object.data)}</c:calendar-data>`,
          );
        }),
      );
    }
    if (method === "PUT" || method === "DELETE") {
      const current = this.objects.get(path);
      if (headers.get("if-none-match") === "*" && current !== undefined) {
        return new Response(null, { status: 412 });
      }
      if (headers.has("if-match") && headers.get("if-match") !== current?.etag) {
        return new Response(null, { status: 412 });
      }
      if (method === "DELETE") {
        this.objects.delete(path);
        return new Response(null, { status: 204 });
      }
      const etag = `"v${this.revision++}"`;
      this.objects.set(path, { data: body, etag });
      return new Response(null, { status: 201, headers: { etag } });
    }
    return new Response(null, { status: 404 });
  }
}
