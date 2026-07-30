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
} from "./types";

const SLOW_EVENT_THRESHOLD_MS = 5_000;

export function Document(props: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark light" />
        <title>BellaClaw Logs</title>
        <link rel="icon" href="data:," />
        <link rel="stylesheet" href="/assets/styles.css?v=log-viewer-redesign-4" />
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
    <div id="app-shell" class="log-viewer-shell">
      <div class="sticky-top">
        <PageHeader dbPath={props.dbPath} query={props.query} />
        <div id="transient-warning" class="transient-warning" hidden></div>
        <SearchForm query={props.query} filters={props.page.filters} />
      </div>
      <div class="workspace-grid">
        <RecentTurns turns={props.page.recentTurns} query={props.query} />
        <main class="event-workspace">
          <div class="results-heading">
            <div class="results-title">
              <strong>{props.page.events.length} events</strong>
              {props.query.turnId !== undefined && (
                <span>
                  Turn <code>{shortenId(props.query.turnId)}</code>
                </span>
              )}
            </div>
            <div class="results-actions">
              {props.query.live && (
                <LivePoller
                  query={props.query}
                  afterCreatedAt={afterCreatedAt}
                  afterId={afterId}
                  count={0}
                  warning={undefined}
                />
              )}
              <span class="sort-label">Newest first</span>
            </div>
          </div>
          <div id="events-list">
            <EventRows
              events={props.page.events}
              query={props.query}
              selectedEventId={newest?.id}
            />
            <LoadMore query={props.query} events={props.page.events} hasMore={props.page.hasMore} />
          </div>
        </main>
        <EventInspector event={newest} />
      </div>
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
      <EventRows events={props.events} query={props.query} selectedEventId={undefined} />
      <LoadMore query={props.query} events={props.events} hasMore={props.hasMore} />
    </>
  );
}

export function LivePoller(props: {
  query: TLogSearchQuery;
  afterCreatedAt: number;
  afterId: number;
  count: number;
  warning: TOption<string>;
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

  return (
    <header class="topbar">
      <div class="brand-block">
        <p class="eyebrow">BellaClaw diagnostics</p>
        <h1>Behavior logs</h1>
        <p class="db-path">{props.dbPath}</p>
      </div>
      <nav class="header-actions" aria-label="Log actions">
        <button class="button secondary theme-toggle" type="button" data-theme-toggle>
          <span class="theme-toggle-icon" aria-hidden="true"></span>
          <span data-theme-label>Theme</span>
        </button>
        <a class="button secondary" href={refreshUrl}>
          ↻ Refresh
        </a>
        <a class={`button live-button${props.query.live ? " active" : ""}`} href={liveUrl}>
          <span class="live-dot"></span>
          {props.query.live ? "Pause live" : "Go live"}
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
      <div class="primary-filters">
        <label class="search-box">
          <span class="sr-only">Search</span>
          <span class="search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            name="q"
            value={props.query.q ?? ""}
            placeholder="Search events, turns, tools, metadata…"
          />
        </label>
        <FilterSelect label="Time range" name="range" compact>
          <option value="15m" selected={props.query.range === "15m"}>
            Last 15 minutes
          </option>
          <option value="1h" selected={props.query.range === "1h"}>
            Last hour
          </option>
          <option value="24h" selected={props.query.range === "24h"}>
            Last 24 hours
          </option>
          <option value="7d" selected={props.query.range === "7d"}>
            Last 7 days
          </option>
          <option value="all" selected={props.query.range === "all"}>
            All history
          </option>
        </FilterSelect>
        <FilterSelect label="Level" name="level" compact>
          <option value="" selected={props.query.level === undefined}>
            All levels
          </option>
          {Object.values(EBehaviorLogLevel).map((level) => (
            <option value={level} selected={props.query.level === level}>
              {level}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Result" name="success" compact>
          <option value="" selected={props.query.success === undefined}>
            All results
          </option>
          <option value="success" selected={props.query.success === "success"}>
            Success
          </option>
          <option value="failure" selected={props.query.success === "failure"}>
            Failure
          </option>
        </FilterSelect>
        <details class="advanced-filters">
          <summary>+ More filters</summary>
          <div class="advanced-filter-grid">
            <FilterSelect label="Event" name="event">
              <option value="" selected={props.query.event === undefined}>
                Any event
              </option>
              {props.filters.events.map((event) => (
                <option value={event} selected={props.query.event === event}>
                  {event}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect label="Component" name="component">
              <option value="" selected={props.query.component === undefined}>
                Any component
              </option>
              {props.filters.components.map((component) => (
                <option value={component} selected={props.query.component === component}>
                  {component}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect label="Tool" name="toolName">
              <option value="" selected={props.query.toolName === undefined}>
                Any tool
              </option>
              {props.filters.toolNames.map((toolName) => (
                <option value={toolName} selected={props.query.toolName === toolName}>
                  {toolName}
                </option>
              ))}
            </FilterSelect>
            <label class="filter-field">
              <span>Turn ID</span>
              <input name="turnId" value={props.query.turnId ?? ""} placeholder="Exact turn ID" />
            </label>
          </div>
        </details>
        <button class="button apply-button" type="submit">
          Apply filters
        </button>
      </div>
      <ActiveFilters query={props.query} />
    </form>
  );
}

function ActiveFilters(props: { query: TLogSearchQuery }) {
  const filters: Array<{ label: string; field: keyof TLogSearchQuery }> = [];

  if (props.query.q !== undefined) {
    filters.push({ label: `search: ${props.query.q}`, field: "q" });
  }
  if (props.query.level !== undefined) {
    filters.push({ label: `level: ${props.query.level}`, field: "level" });
  }
  if (props.query.success !== undefined) {
    filters.push({ label: `result: ${props.query.success}`, field: "success" });
  }
  if (props.query.event !== undefined) {
    filters.push({ label: `event: ${props.query.event}`, field: "event" });
  }
  if (props.query.component !== undefined) {
    filters.push({ label: `component: ${props.query.component}`, field: "component" });
  }
  if (props.query.toolName !== undefined) {
    filters.push({ label: `tool: ${props.query.toolName}`, field: "toolName" });
  }
  if (props.query.turnId !== undefined) {
    filters.push({ label: `turn: ${shortenId(props.query.turnId)}`, field: "turnId" });
  }

  if (filters.length === 0) {
    return <div class="filter-summary">Showing all events in the selected time range</div>;
  }

  return (
    <fieldset class="active-filters">
      <legend class="sr-only">Active filters</legend>
      {filters.map((filter) => (
        <a
          class="filter-chip"
          href={buildLogUrl(props.query, {
            includeUntil: false,
            includeCursor: false,
            live: props.query.live,
            overrides: { [filter.field]: undefined },
          })}
        >
          {filter.label} <span aria-hidden="true">×</span>
        </a>
      ))}
      <a class="clear-filters" href="/">
        Clear all
      </a>
    </fieldset>
  );
}

function FilterSelect(
  props: PropsWithChildren<{ label: string; name: string; compact?: boolean }>,
) {
  return (
    <label class={props.compact ? "filter-control" : "filter-field"}>
      <span class={props.compact ? "sr-only" : undefined}>{props.label}</span>
      <select name={props.name} aria-label={props.label}>
        {props.children}
      </select>
    </label>
  );
}

function RecentTurns(props: { turns: TRecentTurn[]; query: TLogSearchQuery }) {
  return (
    <aside class="turn-sidebar">
      <div class="sidebar-heading">
        <h2>Recent turns</h2>
        <span>{props.turns.length} turns</span>
      </div>
      {props.turns.length === 0 && <p class="muted">No turns recorded.</p>}
      <ol class="turn-list">
        {props.turns.map((turn) => {
          const selected = props.query.turnId === turn.turnId;
          const url = buildLogUrl(props.query, {
            includeUntil: false,
            includeCursor: false,
            live: false,
            overrides: {
              range: selected ? props.query.range : "all",
              turnId: selected ? undefined : turn.turnId,
            },
          });
          const turnPresentation = describeTurn(turn.turnId);

          return (
            <li class={selected ? "selected" : undefined}>
              <a
                class="turn-link"
                href={url}
                title={turn.turnId}
                aria-current={selected ? "page" : undefined}
              >
                <span class="turn-icon" aria-hidden="true">
                  {turnPresentation.icon}
                </span>
                <span class="turn-link-content">
                  <span class="turn-type">{turnPresentation.label}</span>
                  <code>{shortenId(turn.turnId)}</code>
                  <span class="turn-meta">
                    <LocalTime ms={turn.latestCreatedAtMs} /> · {turn.eventCount} events
                  </span>
                </span>
                <span
                  class={turn.hasFailure ? "turn-status failed" : "turn-status healthy"}
                  title={turn.hasFailure ? "Contains a failure" : "No failures reported"}
                >
                  <span aria-hidden="true">{turn.hasFailure ? "!" : "✓"}</span>
                  <span class="sr-only">
                    {turn.hasFailure ? "Contains a failure" : "No failures reported"}
                  </span>
                </span>
              </a>
              <button
                class="copy-icon"
                type="button"
                data-copy={turn.turnId}
                aria-label="Copy turn ID"
                title="Copy turn ID"
              >
                Copy
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

function EventRows(props: {
  events: TPersistedBehaviorLogEvent[];
  query: TLogSearchQuery;
  selectedEventId?: number;
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
    <div class="event-list timeline-list">
      {props.events.map((event) => (
        <EventRow event={event} query={props.query} selected={props.selectedEventId === event.id} />
      ))}
    </div>
  );
}

function PivotLink(
  props: PropsWithChildren<{
    query: TLogSearchQuery;
    field: "event" | "component" | "toolName";
    value: string;
  }>,
) {
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

function EventRow(props: {
  event: TPersistedBehaviorLogEvent;
  query: TLogSearchQuery;
  selected: boolean;
}) {
  const event = props.event;
  const slow = isSlowEvent(event);
  const status = eventStatus(event);
  const turnUrl = buildLogUrl(props.query, {
    includeUntil: false,
    includeCursor: false,
    live: false,
    overrides: { range: "all", turnId: event.turnId },
  });

  return (
    <article
      class={eventClass(event, props.selected)}
      data-event-id={String(event.id)}
      data-event-selectable="true"
      aria-current={props.selected ? "true" : undefined}
      tabindex={0}
    >
      <span class="timeline-dot" aria-hidden="true"></span>
      <div class="event-body">
        <div class="event-main">
          <div class="event-copy">
            <div class="event-title">
              <strong>
                <PivotLink query={props.query} field="event" value={event.event}>
                  {event.event}
                </PivotLink>
              </strong>
              {event.level !== EBehaviorLogLevel.Info && (
                <span class={`badge level-${event.level}`}>{event.level}</span>
              )}
              {event.success === false && <span class="badge result-failure">Failure</span>}
              {isStartedEvent(event) && <span class="event-state">{status.label}</span>}
            </div>
            {event.summary !== null && <p class="event-summary">{event.summary}</p>}
            {event.error !== null && <p class="event-error">{event.error}</p>}
            <div class="event-turn">
              <a href={turnUrl} title={`Filter to turn ${event.turnId}`}>
                {shortenId(event.turnId)}
              </a>
            </div>
          </div>
          <div class="event-component">
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
          </div>
          <div
            class={`event-duration${slow ? " slow" : ""}`}
            title={slow ? "Slow event" : undefined}
          >
            {event.durationMs === null ? "—" : formatDuration(event.durationMs)}
          </div>
          <LocalTime ms={event.createdAtMs} />
          <span class="event-chevron" aria-hidden="true">
            ›
          </span>
        </div>
      </div>
      <template class="event-inspector-template">
        <EventInspectorContent event={event} />
      </template>
    </article>
  );
}

function EventInspector(props: { event: TOption<TPersistedBehaviorLogEvent> }) {
  return (
    <aside class="event-inspector" aria-label="Event details">
      <div class="inspector-heading">
        <h2>Event details</h2>
        <div class="inspector-heading-actions">
          <button
            class="icon-button"
            type="button"
            data-copy-current-event
            aria-label="Copy event JSON"
            title="Copy event JSON"
          >
            ⧉
          </button>
        </div>
      </div>
      <div id="event-inspector-content" aria-live="polite">
        {props.event === undefined ? (
          <div class="inspector-empty">
            <strong>Select an event</strong>
            <p>Choose an event from the timeline to inspect its context and raw payload.</p>
          </div>
        ) : (
          <EventInspectorContent event={props.event} />
        )}
      </div>
    </aside>
  );
}

function EventInspectorContent(props: { event: TPersistedBehaviorLogEvent }) {
  const event = props.event;
  const status = eventStatus(event);
  const metadataEntries = Object.entries(event.metadata);

  return (
    <div class="inspector-content" data-event-json={JSON.stringify(event)}>
      <div class="inspector-event-title">
        <strong>{event.event}</strong>
        <span class={`status-label ${status.className}`}>
          <span class="status-dot" aria-hidden="true"></span>
          {status.label}
        </span>
      </div>
      <InspectorSection title="Overview">
        <InspectorValue label="Result" value={status.label} className={status.className} />
        <InspectorValue
          label="Duration"
          value={event.durationMs === null ? "Not reported" : formatDuration(event.durationMs)}
          className={isSlowEvent(event) ? "warning" : undefined}
        />
        <InspectorValue
          label="Timestamp"
          value={new Date(event.createdAtMs).toLocaleString()}
          mono
        />
        <InspectorValue label="Level" value={event.level} />
      </InspectorSection>
      <InspectorSection title="Context">
        <InspectorValue label="Turn ID" value={event.turnId} mono />
        {event.chatId !== null && <InspectorValue label="Chat ID" value={event.chatId} mono />}
        {event.component !== null && <InspectorValue label="Component" value={event.component} />}
        {event.toolName !== null && <InspectorValue label="Tool" value={event.toolName} />}
        {event.platform !== null && <InspectorValue label="Platform" value={event.platform} />}
        {event.provider !== null && <InspectorValue label="Provider" value={event.provider} />}
        {event.model !== null && <InspectorValue label="Model" value={event.model} />}
      </InspectorSection>
      <InspectorSection title="Metadata">
        {metadataEntries.length === 0 ? (
          <p class="inspector-muted">No metadata recorded.</p>
        ) : (
          metadataEntries.map(([key, value]) => (
            <InspectorValue label={key} value={formatMetadataValue(value)} mono />
          ))
        )}
      </InspectorSection>
      {event.error !== null && (
        <InspectorSection title="Error">
          <pre class="error-pre">{event.error}</pre>
        </InspectorSection>
      )}
      <InspectorSection title="Raw event" className="inspector-raw-section">
        <pre class="raw-event">{JSON.stringify(event, null, 2)}</pre>
      </InspectorSection>
      <div class="inspector-actions">
        <button class="button secondary" type="button" data-copy={JSON.stringify(event)}>
          Copy JSON
        </button>
        <a class="button secondary" href={`/?range=all&turnId=${encodeURIComponent(event.turnId)}`}>
          Filter to this turn
        </a>
      </div>
    </div>
  );
}

function InspectorSection(props: PropsWithChildren<{ title: string; className?: string }>) {
  return (
    <section class={`inspector-section ${props.className ?? ""}`.trim()}>
      <h3>{props.title}</h3>
      <div class="inspector-section-body">{props.children}</div>
    </section>
  );
}

function InspectorValue(props: {
  label: string;
  value: string;
  className?: string;
  mono?: boolean;
}) {
  return (
    <div class="inspector-value">
      <span>{props.label}</span>
      <strong class={`${props.mono ? "mono" : ""}${props.className ? ` ${props.className}` : ""}`}>
        {props.value}
      </strong>
    </div>
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

function eventClass(event: TPersistedBehaviorLogEvent, selected: boolean): string {
  let className = `event-row event-level-${event.level}`;

  if (event.success === false) {
    className += " event-failed";
  } else if (isSlowEvent(event)) {
    className += " event-slow";
  } else if (isStartedEvent(event) || event.success === null) {
    className += " event-neutral";
  } else {
    className += " event-success";
  }

  if (selected) {
    className += " selected";
  }

  return className;
}

function eventStatus(event: TPersistedBehaviorLogEvent): { label: string; className: string } {
  if (event.success === false) {
    return { label: "Failure", className: "danger" };
  }

  if (isStartedEvent(event)) {
    return { label: "Started", className: "neutral" };
  }

  if (event.success === true) {
    return { label: "Success", className: "success" };
  }

  return { label: "Recorded", className: "neutral" };
}

function isStartedEvent(event: TPersistedBehaviorLogEvent): boolean {
  return event.event.endsWith(".started") || event.event.endsWith(".starting");
}

function isSlowEvent(event: TPersistedBehaviorLogEvent): boolean {
  return event.durationMs !== null && event.durationMs >= SLOW_EVENT_THRESHOLD_MS;
}

function describeTurn(turnId: string): { label: string; icon: string } {
  if (turnId.startsWith("cron:")) {
    return { label: "Scheduled task", icon: "◷" };
  }

  if (turnId.startsWith("msg:")) {
    return { label: "Message", icon: "◌" };
  }

  if (turnId.startsWith("boot:")) {
    return { label: "System boot", icon: "□" };
  }

  return { label: "Turn", icon: "◇" };
}

function formatMetadataValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
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
