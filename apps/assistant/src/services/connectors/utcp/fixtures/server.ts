// A UTCP server for tests: it serves a manual at /utcp and the endpoints its tools call.

// manual: the manual's JSON given the server's origin
export type TUtcpFixtureOptions = {
  manual: (origin: string) => unknown;
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
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);

      if (url.pathname === "/utcp") {
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

      return new Response("Not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/utcp`,
    stop: () => server.stop(true),
  };
}
