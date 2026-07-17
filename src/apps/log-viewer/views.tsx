/** @jsxImportSource hono/jsx */

import type { PropsWithChildren } from "hono/jsx";
import {
  EBehaviorLogLevel,
  type TPersistedBehaviorLogEvent,
} from "../../services/app-logger/types";
import type { TOption } from "../../types";
import { buildLogUrl } from "./query";
import type {
  TLogFilterOptions,
  TLogPage,
  TLogReaderError,
  TLogSearchQuery,
  TRecentTurn,
  TTurnPage,
} from "./types";

export function Document(props: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark light" />
        <title>BellaClaw Logs</title>
        <link rel="icon" href="data:," />
        <link rel="stylesheet" href="/assets/styles.css" />
        <script src="/assets/htmx.min.js" defer></script>
        <script src="/assets/app.js" defer></script>
      </head>
      <body>{props.children}</body>
    </html>
  );
}

export function HomePage(props: { dbPath: string; query: TLogSearchQuery; page: TLogPage }) {
  const newest = props.page.events[0];
  let afterCreatedAt = props.query.until;
  let afterId = 0;

  if (newest !== undefined) {
    afterCreatedAt = newest.createdAtMs;
    afterId = newest.id;
  }

  return (
    <div id="app-shell">
      <div class="sticky-top">
        <PageHeader dbPath={props.dbPath} query={props.query} />
        <div id="transient-warning" class="transient-warning" hidden></div>
        <SearchForm query={props.query} filters={props.page.filters} />
      </div>
      <div class="page-grid">
        <RecentTurns turns={props.page.recentTurns} />
        <main>
          <div class="results-heading">
            <div>
              <p class="eyebrow">Events</p>
              <h2>{props.page.events.length} loaded</h2>
            </div>
            {props.query.live && (
              <LivePoller
                query={props.query}
                afterCreatedAt={afterCreatedAt}
                afterId={afterId}
                count={0}
              />
            )}
          </div>
          <div id="events-list">
            <EventRows events={props.page.events} query={props.query} />
            <LoadMore query={props.query} events={props.page.events} hasMore={props.page.hasMore} />
          </div>
        </main>
      </div>
    </div>
  );
}

export function TurnPage(props: { dbPath: string; turnId: string; page: TTurnPage }) {
  let failureSummary = "None";

  if (props.page.hasFailure) {
    failureSummary = "Present";
  }

  return (
    <div id="app-shell">
      <header class="topbar turn-topbar sticky-top">
        <div>
          <a class="back-link" href="/">
            ← All logs
          </a>
          <p class="eyebrow">Turn</p>
          <h1 class="turn-title">{props.turnId}</h1>
          <p class="db-path">{props.dbPath}</p>
        </div>
        <button class="button secondary" type="button" data-copy={props.turnId}>
          Copy turn ID
        </button>
      </header>
      {props.page.events.length === 0 && (
        <main class="empty-page">
          <h2>Turn not found</h2>
          <p>No persisted events use this turn ID.</p>
        </main>
      )}
      {props.page.events.length > 0 && (
        <main class="turn-page">
          <section class="turn-summary">
            <SummaryStat label="Started" value={<LocalTime ms={props.page.startedAtMs} />} />
            <SummaryStat label="Latest" value={<LocalTime ms={props.page.latestCreatedAtMs} />} />
            <SummaryStat label="Events" value={String(props.page.events.length)} />
            <SummaryStat
              label="Elapsed span"
              value={formatDuration(props.page.latestCreatedAtMs - props.page.startedAtMs)}
            />
            <SummaryStat label="Failures" value={failureSummary} />
          </section>
          <section class="timeline">
            <EventRows events={props.page.events} query={undefined} />
          </section>
        </main>
      )}
    </div>
  );
}

export function ErrorPage(props: { error: TLogReaderError; retryUrl: string }) {
  return (
    <div
      id="app-shell"
      class="error-shell"
      role="alert"
      hx-get={props.retryUrl}
      hx-trigger="every 5s"
      hx-select="#app-shell"
      hx-target="#app-shell"
      hx-swap="outerHTML"
    >
      <div class="error-card">
        <p class="error-kicker">DATABASE {props.error.kind.toUpperCase()}</p>
        <h1>{props.error.message}</h1>
        <p>The viewer is running, but it cannot read the behavior log database.</p>
        <dl class="diagnostic-list">
          <div>
            <dt>Resolved path</dt>
            <dd>
              <code>{props.error.dbPath}</code>
            </dd>
          </div>
        </dl>
        <details>
          <summary>Technical details</summary>
          <pre>{props.error.detail}</pre>
        </details>
        <div class="error-actions">
          <a class="button" href={props.retryUrl}>
            Retry now
          </a>
          <span>Retrying automatically every 5 seconds</span>
        </div>
      </div>
    </div>
  );
}

export function EventPageFragment(props: {
  query: TLogSearchQuery;
  events: TPersistedBehaviorLogEvent[];
  hasMore: boolean;
}) {
  return (
    <>
      <EventRows events={props.events} query={props.query} />
      <LoadMore query={props.query} events={props.events} hasMore={props.hasMore} />
    </>
  );
}

export function LivePoller(props: {
  query: TLogSearchQuery;
  afterCreatedAt: number;
  afterId: number;
  count: number;
  warning?: string;
}) {
  const endpoint = buildLogUrl(props.query, {
    includeUntil: true,
    includeCursor: false,
    live: true,
    path: "/fragments/live",
  });
  const pollUrl = `${endpoint}&afterCreatedAt=${props.afterCreatedAt}&afterId=${props.afterId}`;
  const refreshUrl = buildLogUrl(props.query, {
    includeUntil: false,
    includeCursor: false,
    live: true,
  });

  let eventLabel = "events";

  if (props.count === 1) {
    eventLabel = "event";
  }

  return (
    <div
      id="live-status"
      class="live-status"
      data-new-count={String(props.count)}
      hx-get={pollUrl}
      hx-trigger="every 5s"
      hx-target="#live-status"
      hx-swap="outerHTML"
    >
      <span class="live-dot"></span>
      {props.count === 0 && props.warning === undefined && <span>Live · 5s</span>}
      {props.count > 0 && (
        <a href={refreshUrl}>
          {props.count} new {eventLabel}
        </a>
      )}
      {props.warning !== undefined && <span class="warning-text">{props.warning}</span>}
    </div>
  );
}

function PageHeader(props: { dbPath: string; query: TLogSearchQuery }) {
  const refreshUrl = buildLogUrl(props.query, {
    includeUntil: false,
    includeCursor: false,
    live: props.query.live,
  });
  const liveUrl = buildLogUrl(props.query, {
    includeUntil: true,
    includeCursor: false,
    live: !props.query.live,
  });
  let liveLabel = "Start live";

  if (props.query.live) {
    liveLabel = "Stop live";
  }

  return (
    <header class="topbar">
      <div>
        <p class="eyebrow">BellaClaw diagnostics</p>
        <h1>Behavior logs</h1>
        <p class="db-path">{props.dbPath}</p>
      </div>
      <nav class="header-actions" aria-label="Log actions">
        <a class="button secondary" href={refreshUrl}>
          Refresh
        </a>
        <a class="button" href={liveUrl}>
          {liveLabel}
        </a>
      </nav>
    </header>
  );
}

function SearchForm(props: { query: TLogSearchQuery; filters: TLogFilterOptions }) {
  return (
    <form
      class="search-panel"
      method="get"
      action="/"
      hx-get="/"
      hx-target="#app-shell"
      hx-select="#app-shell"
      hx-swap="outerHTML"
      hx-push-url="true"
    >
      {props.query.live && <input type="hidden" name="live" value="1" />}
      <label class="search-box">
        <span>Search</span>
        <input name="q" value={props.query.q ?? ""} placeholder="summary, event, tool, metadata…" />
      </label>
      <FilterSelect label="Range" name="range">
        <option value="15m" selected={props.query.range === "15m"}>
          15 minutes
        </option>
        <option value="1h" selected={props.query.range === "1h"}>
          1 hour
        </option>
        <option value="24h" selected={props.query.range === "24h"}>
          24 hours
        </option>
        <option value="7d" selected={props.query.range === "7d"}>
          7 days
        </option>
        <option value="all" selected={props.query.range === "all"}>
          All history
        </option>
      </FilterSelect>
      <FilterSelect label="Level" name="level">
        <option value="" selected={props.query.level === undefined}>
          Any
        </option>
        {Object.values(EBehaviorLogLevel).map((level) => (
          <option value={level} selected={props.query.level === level}>
            {level}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect label="Result" name="success">
        <option value="" selected={props.query.success === undefined}>
          Any
        </option>
        <option value="success" selected={props.query.success === "success"}>
          Success
        </option>
        <option value="failure" selected={props.query.success === "failure"}>
          Failure
        </option>
      </FilterSelect>
      <FilterSelect label="Event" name="event">
        <option value="" selected={props.query.event === undefined}>
          Any
        </option>
        {props.filters.events.map((event) => (
          <option value={event} selected={props.query.event === event}>
            {event}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect label="Component" name="component">
        <option value="" selected={props.query.component === undefined}>
          Any
        </option>
        {props.filters.components.map((component) => (
          <option value={component} selected={props.query.component === component}>
            {component}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect label="Tool" name="toolName">
        <option value="" selected={props.query.toolName === undefined}>
          Any
        </option>
        {props.filters.toolNames.map((toolName) => (
          <option value={toolName} selected={props.query.toolName === toolName}>
            {toolName}
          </option>
        ))}
      </FilterSelect>
      <label>
        <span>Turn ID</span>
        <input name="turnId" value={props.query.turnId ?? ""} placeholder="Exact ID" />
      </label>
      <div class="filter-actions">
        <button class="button" type="submit">
          Apply
        </button>
        <a class="button secondary" href="/">
          Clear
        </a>
      </div>
    </form>
  );
}

function FilterSelect(props: PropsWithChildren<{ label: string; name: string }>) {
  return (
    <label>
      <span>{props.label}</span>
      <select name={props.name}>{props.children}</select>
    </label>
  );
}

function RecentTurns(props: { turns: TRecentTurn[] }) {
  return (
    <aside class="turn-sidebar">
      <div class="sidebar-heading">
        <p class="eyebrow">Navigation</p>
        <h2>Recent turns</h2>
      </div>
      {props.turns.length === 0 && <p class="muted">No turns recorded.</p>}
      <ol class="turn-list">
        {props.turns.map((turn) => (
          <li>
            <a
              class="turn-link"
              href={`/turns/${encodeURIComponent(turn.turnId)}`}
              title={turn.turnId}
            >
              <span class="turn-link-main">
                <code>{shortenId(turn.turnId)}</code>
                {turn.hasFailure && <span class="failure-dot" title="Contains a failure"></span>}
              </span>
              <span class="turn-meta">
                <LocalTime ms={turn.latestCreatedAtMs} /> · {turn.eventCount} events
              </span>
            </a>
            <button
              class="copy-icon"
              type="button"
              data-copy={turn.turnId}
              aria-label="Copy turn ID"
            >
              Copy
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function EventRows(props: {
  events: TPersistedBehaviorLogEvent[];
  query: TOption<TLogSearchQuery>;
}) {
  if (props.events.length === 0) {
    return (
      <div class="empty-state">
        <h3>No matching events</h3>
        <p>Change the filters or select a wider time range.</p>
      </div>
    );
  }

  return (
    <div class="event-list">
      {props.events.map((event) => (
        <EventRow event={event} query={props.query} />
      ))}
    </div>
  );
}

function PivotLink(
  props: PropsWithChildren<{
    query: TOption<TLogSearchQuery>;
    field: "event" | "component" | "toolName";
    value: string;
  }>,
) {
  if (props.query === undefined) {
    return <span>{props.children}</span>;
  }

  const active = props.query[props.field] === props.value;
  const overrides: Partial<TLogSearchQuery> = {};

  if (active) {
    overrides[props.field] = undefined;
  } else {
    overrides[props.field] = props.value;
  }

  const url = buildLogUrl(props.query, {
    includeUntil: false,
    includeCursor: false,
    live: false,
    overrides,
  });
  let className = "pivot";
  let hint = `Filter by ${props.field}: ${props.value}`;

  if (active) {
    className = "pivot pivot-active";
    hint = `Clear ${props.field} filter`;
  }

  return (
    <a class={className} href={url} title={hint}>
      {props.children}
    </a>
  );
}

function EventRow(props: { event: TPersistedBehaviorLogEvent; query: TOption<TLogSearchQuery> }) {
  const event = props.event;
  let resultLabel = "not reported";

  if (event.success === true) {
    resultLabel = "success";
  }

  if (event.success === false) {
    resultLabel = "failure";
  }

  return (
    <article class={eventClass(event)} data-event-id={String(event.id)}>
      <div class="event-accent"></div>
      <div class="event-body">
        <div class="event-header">
          <div class="event-title">
            {event.level !== EBehaviorLogLevel.Info && (
              <span class={`badge level-${event.level}`}>{event.level}</span>
            )}
            <strong>
              <PivotLink query={props.query} field="event" value={event.event}>
                {event.event}
              </PivotLink>
            </strong>
            {event.success !== null && (
              <span class={`badge result-${resultLabel}`}>{resultLabel}</span>
            )}
          </div>
          <LocalTime ms={event.createdAtMs} />
        </div>
        <div class="event-context">
          <a href={`/turns/${encodeURIComponent(event.turnId)}`} title={event.turnId}>
            {shortenId(event.turnId)}
          </a>
          {event.component !== null && (
            <PivotLink query={props.query} field="component" value={event.component}>
              {event.component}
            </PivotLink>
          )}
          {event.toolName !== null && (
            <PivotLink query={props.query} field="toolName" value={event.toolName}>
              {event.toolName}
            </PivotLink>
          )}
          {event.durationMs !== null && <span>{formatDuration(event.durationMs)}</span>}
        </div>
        {event.summary !== null && <p class="event-summary">{event.summary}</p>}
        {event.error !== null && <p class="event-error">{event.error}</p>}
        <details class="event-details">
          <summary>Details</summary>
          <div class="detail-toolbar">
            <button class="button secondary small" type="button" data-copy={JSON.stringify(event)}>
              Copy event JSON
            </button>
          </div>
          {event.error !== null && (
            <section>
              <h4>Error</h4>
              <pre>{event.error}</pre>
            </section>
          )}
          <section>
            <h4>Metadata</h4>
            <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
          </section>
          <section>
            <h4>Complete event</h4>
            <pre>{JSON.stringify(event, null, 2)}</pre>
          </section>
        </details>
      </div>
    </article>
  );
}

function LoadMore(props: {
  query: TLogSearchQuery;
  events: TPersistedBehaviorLogEvent[];
  hasMore: boolean;
}) {
  if (!props.hasMore || props.events.length === 0) {
    return (
      <div id="load-more" class="result-end">
        End of loaded results
      </div>
    );
  }

  const last = props.events[props.events.length - 1];

  if (last === undefined) {
    return <div id="load-more"></div>;
  }

  const nextQuery: TLogSearchQuery = {
    ...props.query,
    beforeCreatedAt: last.createdAtMs,
    beforeId: last.id,
  };
  const url = buildLogUrl(nextQuery, {
    includeUntil: true,
    includeCursor: true,
    live: props.query.live,
    path: "/fragments/events",
  });

  return (
    <div id="load-more" class="load-more">
      <button
        class="button secondary"
        type="button"
        hx-get={url}
        hx-trigger="click, revealed"
        hx-target="#load-more"
        hx-swap="outerHTML"
      >
        Load 100 older events
      </button>
    </div>
  );
}

function SummaryStat(props: { label: string; value: unknown }) {
  return (
    <div>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function LocalTime(props: { ms: number }) {
  const iso = new Date(props.ms).toISOString();
  return (
    <time class="local-time" datetime={iso} title={iso}>
      {iso}
    </time>
  );
}

function shortenId(value: string): string {
  if (value.length <= 28) {
    return value;
  }

  return `${value.slice(0, 12)}…${value.slice(-10)}`;
}

function eventClass(event: TPersistedBehaviorLogEvent): string {
  let className = `event-row event-level-${event.level}`;

  if (event.success === false) {
    className += " event-failed";
  }

  return className;
}

function formatDuration(value: number): string {
  if (value < 1000) {
    return `${value}ms`;
  }

  if (value < 60_000) {
    return `${(value / 1000).toFixed(1)}s`;
  }

  return `${(value / 60_000).toFixed(1)}m`;
}
