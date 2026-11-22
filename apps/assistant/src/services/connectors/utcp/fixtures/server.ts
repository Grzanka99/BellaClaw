// A UTCP server for tests: it serves a manual at /utcp and the endpoints its tools call, and
// records every request it gets.

export type TRecordedRequest = { url: string; headers: [string, string][]; body: string };

// manual: the manual's JSON given the server's origin; manualStatus: an answer other than 200
export type TUtcpFixtureOptions = {
  manual: (origin: string) => unknown;
  manualStatus?: number;
};

export function httpTool(name: string, url: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    description: `Fixture tool ${name}`,
    inputs: { type: "object", properties: { city: { type: "string" } } },
    tool_call_template: { call_template_type: "http", http_method: "GET", url, ...extra },
  };
}

export function startUtcpFixture(options: TUtcpFixtureOptions) {
  const requests: TRecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      requests.push({
        url: request.url,
        headers: [...request.headers.entries()],
        body: await request.text(),
      });
      const url = new URL(request.url);

      if (url.pathname === "/utcp") {
        if (options.manualStatus !== undefined) {
          return new Response("Sign in first", { status: options.manualStatus });
        }

        return Response.json(options.manual(url.origin));
      }

      if (url.pathname === "/weather") {
        return Response.json({ city: url.searchParams.get("city"), temperature: 21 });
      }

      if (url.pathname === "/text") {
        return new Response("Sunny in Oslo", { headers: { "content-type": "text/plain" } });
      }

      if (url.pathname === "/big") {
        return Response.json({ text: "a".repeat(2 * 1024 * 1024) });
      }

      if (url.pathname === "/redirect") {
        return new Response(null, {
          status: 302,
          headers: { location: url.searchParams.get("to") ?? "/" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return {
    origin: `http://127.0.0.1:${server.port}`,
    url: `http://127.0.0.1:${server.port}/utcp`,
    requests,
    stop: () => server.stop(true),
  };
}
