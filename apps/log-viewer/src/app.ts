import { getDefaultLogDbPath, LogReader } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { Hono } from "hono";
import { z } from "zod";
import { createMcpRequestHandler } from "./mcp";
import { parseLogSearchQuery } from "./query";

type TLogViewerOptions = {
  dbPath: TOption<string>;
};

export type TLogViewerApplication = {
  app: Hono;
  close: () => Promise<void>;
};

const SLiveCursor = z.object({
  afterCreatedAt: z.coerce.number().int().nonnegative(),
  afterId: z.coerce.number().int().nonnegative(),
});

const CLIENT_ENTRY = new URL("./client/main.tsx", import.meta.url).pathname;

export function createLogViewerApp(
  options: TLogViewerOptions = { dbPath: undefined },
): TLogViewerApplication {
  const dbPath = options.dbPath ?? getDefaultLogDbPath();
  const reader = new LogReader(dbPath);
  const app = new Hono();
  const handleMcpRequest = createMcpRequestHandler(reader);

  app.all("/mcp", (context) => handleMcpRequest(context.req.raw));

  app.get("/", () => serveAsset("shell.html", "text/html; charset=utf-8"));
  app.get("/assets/styles.css", () => serveAsset("styles.css", "text/css; charset=utf-8"));

  /* Built per request so `bun --watch` picks up client edits; one user makes this cheap. */
  app.get("/assets/client.js", async () => {
    const build = await Bun.build({ entrypoints: [CLIENT_ENTRY], target: "browser", minify: true });
    const [output] = build.outputs;

    if (output === undefined) {
      return new Response("Client bundle is empty", { status: 500 });
    }

    return new Response(output, {
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "text/javascript; charset=utf-8",
      },
    });
  });

  app.get("/health", async (context) => {
    const result = await reader.health();

    if (result.success) {
      return context.text("ok");
    }

    return context.text(`${result.error.message}: ${result.error.dbPath}`, 503);
  });

  app.get("/api/logs", async (context) => {
    const query = parseLogSearchQuery(context.req.query());
    const result = await reader.readLogPage(query);

    if (!result.success) {
      return context.json(result, 503);
    }

    return context.json({ success: true, data: { dbPath, query, page: result.data } });
  });

  app.get("/api/logs/new", async (context) => {
    const cursor = SLiveCursor.safeParse(context.req.query());

    if (!cursor.success) {
      return context.text("Invalid live cursor", 400);
    }

    const query = parseLogSearchQuery(context.req.query());
    const result = await reader.readNewEvents(
      query,
      cursor.data.afterCreatedAt,
      cursor.data.afterId,
    );

    if (!result.success) {
      return context.json(result, 503);
    }

    return context.json(result);
  });

  app.notFound((context) => context.text("Not found", 404));

  return {
    app,
    async close() {
      await reader.close();
    },
  };
}

function serveAsset(filename: "shell.html" | "styles.css", contentType: string): Response {
  const file = Bun.file(new URL(filename, import.meta.url));
  return new Response(file, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": contentType,
    },
  });
}
