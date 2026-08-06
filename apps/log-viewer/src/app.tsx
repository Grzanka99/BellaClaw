/** @jsxImportSource hono/jsx */

import { getDefaultLogDbPath, LogReader } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { parseLogSearchQuery } from "./query";
import { Document, ErrorPage, EventPageFragment, HomePage, LivePoller } from "./views";

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

export function createLogViewerApp(
  options: TLogViewerOptions = { dbPath: undefined },
): TLogViewerApplication {
  const dbPath = options.dbPath ?? getDefaultLogDbPath();
  const reader = new LogReader(dbPath);
  const app = new Hono();

  app.get("/assets/styles.css", () => serveAsset("styles.css", "text/css; charset=utf-8"));
  app.get("/assets/app.js", () => serveAsset("app.js", "text/javascript; charset=utf-8"));
  app.get("/assets/htmx.min.js", () => {
    const file = Bun.file(new URL(import.meta.resolve("htmx.org/dist/htmx.min.js")));
    return new Response(file, {
      headers: {
        "Cache-Control": "public, max-age=86400",
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

  app.get("/", async (context) => {
    const query = parseLogSearchQuery(context.req.query());
    const result = await reader.readLogPage(query);

    if (!result.success) {
      if (context.req.header("HX-Request") === "true") {
        return hxError(context, result.error.message);
      }

      return context.html(
        <Document>
          <ErrorPage error={result.error} retryUrl={requestPath(context.req.url)} />
        </Document>,
      );
    }

    return context.html(
      <Document>
        <HomePage dbPath={dbPath} query={query} page={result.data} />
      </Document>,
    );
  });

  app.get("/fragments/events", async (context) => {
    const query = parseLogSearchQuery(context.req.query());
    const result = await reader.readLogPage(query);

    if (!result.success) {
      return hxError(context, result.error.message);
    }

    return context.html(
      <EventPageFragment query={query} events={result.data.events} hasMore={result.data.hasMore} />,
    );
  });

  app.get("/fragments/live", async (context) => {
    const query = parseLogSearchQuery(context.req.query());
    const cursor = SLiveCursor.safeParse(context.req.query());

    if (!cursor.success) {
      return context.html(
        <LivePoller
          query={query}
          afterCreatedAt={query.until}
          afterId={0}
          count={0}
          warning="Invalid live cursor"
        />,
      );
    }

    const result = await reader.countNewEvents(
      query,
      cursor.data.afterCreatedAt,
      cursor.data.afterId,
    );

    if (!result.success) {
      return context.html(
        <LivePoller
          query={query}
          afterCreatedAt={cursor.data.afterCreatedAt}
          afterId={cursor.data.afterId}
          count={0}
          warning={result.error.message}
        />,
      );
    }

    return context.html(
      <LivePoller
        query={query}
        afterCreatedAt={cursor.data.afterCreatedAt}
        afterId={cursor.data.afterId}
        count={result.data}
        warning={undefined}
      />,
    );
  });

  app.notFound((context) => context.text("Not found", 404));

  return {
    app,
    async close() {
      await reader.close();
    },
  };
}

function hxError(context: Context, message: string): Response {
  context.header("HX-Reswap", "none");
  context.header("HX-Trigger", JSON.stringify({ logViewerWarning: { message } }));
  return context.body(null);
}

function serveAsset(filename: "styles.css" | "app.js", contentType: string): Response {
  const file = Bun.file(new URL(filename, import.meta.url));
  return new Response(file, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": contentType,
    },
  });
}

function requestPath(requestUrl: string): string {
  const url = new URL(requestUrl);
  return `${url.pathname}${url.search}`;
}
