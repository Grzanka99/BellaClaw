/** @jsxImportSource hono/jsx/dom */

import type {
  EBehaviorLogLevel,
  TBehaviorLogSearchQuery,
  TLogFilterOptions,
  TLogReaderError,
  TPersistedBehaviorLogEvent,
  TRecentTurn,
} from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { type PropsWithChildren, useEffect, useRef, useState } from "hono/jsx/dom";
import * as z from "zod/mini";
import { buildLogUrl } from "./url";

const SLOW_EVENT_THRESHOLD_MS = 5_000;
const THEME_STORAGE_KEY = "bellaclaw-log-viewer-theme";

/* Runtime imports from behavior-logs would bundle full zod; `satisfies` keeps this list exhaustive. */
const LOG_LEVELS = {
  info: "info",
  warning: "warning",
  error: "error",
  message: "message",
} satisfies Record<EBehaviorLogLevel, string>;

const SModelRequestUsage = z.object({
  input: z.number().check(z.nonnegative()),
  output: z.number().check(z.nonnegative()),
  cacheRead: z.number().check(z.nonnegative()),
  cacheWrite: z.number().check(z.nonnegative()),
  inputTokens: z.number().check(z.nonnegative()),
  cacheHitPercent: z.nullable(z.number().check(z.gte(0), z.lte(100))),
});

export function ErrorPage(props: { error: TLogReaderError; onRetry: () => void }) {
  return (
    <div class="error-shell" role="alert">
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
          <button class="button" type="button" onClick={props.onRetry}>
            Retry now
          </button>
          <span>Retrying automatically every 5 seconds</span>
        </div>
      </div>
    </div>
  );
}

export function PageHeader(props: { dbPath: string; query: TBehaviorLogSearchQuery }) {
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
  let liveButtonClass = "button live-button";
  let liveButtonLabel = "Go live";

  if (props.query.live) {
    liveButtonClass += " active";
    liveButtonLabel = "Pause live";
  }

  return (
    <header class="topbar">
      <div class="brand-block">
        <p class="eyebrow">BellaClaw diagnostics</p>
        <h1>Behavior logs</h1>
        <p class="db-path">{props.dbPath}</p>
      </div>
      <nav class="header-actions" aria-label="Log actions">
        <ThemeToggle />
        <a class="button secondary" href={refreshUrl}>
          ↻ Refresh
        </a>
        <a class={liveButtonClass} href={liveUrl}>
          <span class="live-dot"></span>
          {liveButtonLabel}
        </a>
      </nav>
    </header>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState(getActiveTheme);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setTheme(getActiveTheme());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  let nextTheme = "dark";
  let nextThemeLabel = "Dark mode";
  let icon = "◐";

  if (theme === "dark") {
    nextTheme = "light";
    nextThemeLabel = "Light mode";
    icon = "☼";
  }

  const label = `Use ${nextTheme} mode`;
  const toggle = () => {
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    setTheme(nextTheme);
  };

  return (
    <button
      class="button secondary theme-toggle"
      type="button"
      aria-label={label}
      title={label}
      onClick={toggle}
    >
      <span class="theme-toggle-icon" aria-hidden="true">
        {icon}
      </span>
      <span>{nextThemeLabel}</span>
    </button>
  );
}

export function SearchForm(props: {
  query: TBehaviorLogSearchQuery;
  filters: TLogFilterOptions;
  phone: boolean;
  onSearch: (url: string) => void;
}) {
  const submit = (event: Event) => {
    event.preventDefault();

    if (!(event.currentTarget instanceof HTMLFormElement)) {
      return;
    }

    const params = new URLSearchParams();

    for (const [key, value] of new FormData(event.currentTarget)) {
      if (typeof value === "string" && value !== "") {
        params.set(key, value);
      }
    }

    props.onSearch(`/?${params.toString()}`);
  };

  return (
    <form class="search-panel" onSubmit={submit}>
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
        <details class="filter-drawer" open={!props.phone}>
          <summary>Filters</summary>
          <div class="filter-drawer-body">
            <FilterSelect label="Time range" name="range" value={props.query.range} compact>
              <option value="15m">Last 15 minutes</option>
              <option value="1h">Last hour</option>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="all">All history</option>
            </FilterSelect>
            <FilterSelect label="Level" name="level" value={props.query.level ?? ""} compact>
              <option value="">All levels</option>
              {Object.values(LOG_LEVELS).map((level) => (
                <option value={level}>{level}</option>
              ))}
            </FilterSelect>
            <FilterSelect label="Result" name="success" value={props.query.success ?? ""} compact>
              <option value="">All results</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
            </FilterSelect>
            <details class="advanced-filters">
              <summary>+ More filters</summary>
              <div class="advanced-filter-grid">
                <FilterSelect label="Event" name="event" value={props.query.event ?? ""}>
                  <option value="">Any event</option>
                  {props.filters.events.map((event) => (
                    <option value={event}>{event}</option>
                  ))}
                </FilterSelect>
                <FilterSelect
                  label="Component"
                  name="component"
                  value={props.query.component ?? ""}
                >
                  <option value="">Any component</option>
                  {props.filters.components.map((component) => (
                    <option value={component}>{component}</option>
                  ))}
                </FilterSelect>
                <FilterSelect label="Tool" name="toolName" value={props.query.toolName ?? ""}>
                  <option value="">Any tool</option>
                  {props.filters.toolNames.map((toolName) => (
                    <option value={toolName}>{toolName}</option>
                  ))}
                </FilterSelect>
                <label class="filter-field">
                  <span>Turn ID</span>
                  <input
                    name="turnId"
                    value={props.query.turnId ?? ""}
                    placeholder="Exact turn ID"
                  />
                </label>
              </div>
            </details>
            <button class="button apply-button" type="submit">
              Apply filters
            </button>
          </div>
        </details>
      </div>
      <ActiveFilters query={props.query} />
    </form>
  );
}

function ActiveFilters(props: { query: TBehaviorLogSearchQuery }) {
  const filters: Array<{ label: string; field: keyof TBehaviorLogSearchQuery }> = [];

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
  props: PropsWithChildren<{ label: string; name: string; value: string; compact?: boolean }>,
) {
  let labelClass = "filter-field";
  let textClass: TOption<string>;

  if (props.compact === true) {
    labelClass = "filter-control";
    textClass = "sr-only";
  }

  return (
    <label class={labelClass}>
      <span class={textClass}>{props.label}</span>
      <select name={props.name} value={props.value} aria-label={props.label}>
        {props.children}
      </select>
    </label>
  );
}

export function RecentTurns(props: {
  turns: TRecentTurn[];
  query: TBehaviorLogSearchQuery;
  phone: boolean;
}) {
  return (
    <details class="turn-sidebar" open={!props.phone}>
      <summary class="sidebar-heading">
        <h2>Recent turns</h2>
        <span>{props.turns.length} turns</span>
      </summary>
      {props.turns.length === 0 && <p class="muted">No turns recorded.</p>}
      <ol class="turn-list">
        {props.turns.map((turn) => {
          const selected = props.query.turnId === turn.turnId;
          let range: TBehaviorLogSearchQuery["range"] = "all";
          let turnId: TOption<string> = turn.turnId;
          let listClass: TOption<string>;
          let currentPage: TOption<string>;

          if (selected) {
            range = props.query.range;
            turnId = undefined;
            listClass = "selected";
            currentPage = "page";
          }

          const url = buildLogUrl(props.query, {
            includeUntil: false,
            includeCursor: false,
            live: false,
            overrides: { range, turnId },
          });
          const turnPresentation = describeTurn(turn.turnId);
          let statusClass = "turn-status healthy";
          let statusTitle = "No failures reported";
          let statusSymbol = "✓";

          if (turn.hasFailure) {
            statusClass = "turn-status failed";
            statusTitle = "Contains a failure";
            statusSymbol = "!";
          }

          return (
            <li class={listClass} key={turn.turnId}>
              <a class="turn-link" href={url} title={turn.turnId} aria-current={currentPage}>
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
                <span class={statusClass} title={statusTitle}>
                  <span aria-hidden="true">{statusSymbol}</span>
                  <span class="sr-only">{statusTitle}</span>
                </span>
              </a>
              <CopyButton class="copy-icon" label="Copy" title="Copy turn ID" value={turn.turnId} />
            </li>
          );
        })}
      </ol>
    </details>
  );
}

export function LiveStatus() {
  return (
    <div class="live-status">
      <span class="live-dot"></span>
      <span>Live · 5s</span>
    </div>
  );
}

export function EventRows(props: {
  events: TPersistedBehaviorLogEvent[];
  query: TBehaviorLogSearchQuery;
  selectedId: TOption<number>;
  onSelect: (id: number) => void;
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
        <EventRow
          key={event.id}
          event={event}
          query={props.query}
          selected={props.selectedId === event.id}
          onSelect={props.onSelect}
        />
      ))}
    </div>
  );
}

function PivotLink(
  props: PropsWithChildren<{
    query: TBehaviorLogSearchQuery;
    field: "event" | "component" | "toolName";
    value: string;
  }>,
) {
  const active = props.query[props.field] === props.value;
  const overrides: Partial<TBehaviorLogSearchQuery> = {};

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
  query: TBehaviorLogSearchQuery;
  selected: boolean;
  onSelect: (id: number) => void;
}) {
  const event = props.event;
  const status = eventStatus(event);
  let currentEvent: TOption<string>;
  let durationClass = "event-duration";
  let durationTitle: TOption<string>;
  let durationLabel = "—";

  if (props.selected) {
    currentEvent = "true";
  }

  if (isSlowEvent(event)) {
    durationClass += " slow";
    durationTitle = "Slow event";
  }

  if (event.durationMs !== null) {
    durationLabel = formatDuration(event.durationMs);
  }

  const onClick = (click: MouseEvent) => {
    if (
      click.target instanceof Element &&
      click.target.closest("a, button, input, select, summary, details") !== null
    ) {
      return;
    }

    props.onSelect(event.id);
  };
  const onKeyDown = (key: KeyboardEvent) => {
    if (key.target !== key.currentTarget || (key.key !== "Enter" && key.key !== " ")) {
      return;
    }

    key.preventDefault();
    props.onSelect(event.id);
  };

  return (
    <article
      class={eventClass(event, props.selected)}
      data-event-id={String(event.id)}
      aria-current={currentEvent}
      tabindex={0}
      onClick={onClick}
      onKeyDown={onKeyDown}
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
              {event.level !== LOG_LEVELS.info && (
                <span class={`badge level-${event.level}`}>{event.level}</span>
              )}
              {event.success === false && <span class="badge result-failure">Failure</span>}
              {isStartedEvent(event) && <span class="event-state">{status.label}</span>}
            </div>
            {event.summary !== null && <p class="event-summary">{event.summary}</p>}
            {event.error !== null && <p class="event-error">{event.error}</p>}
            <div class="event-turn">
              <a href={turnUrl(props.query, event)} title={`Filter to turn ${event.turnId}`}>
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
          <div class={durationClass} title={durationTitle}>
            {durationLabel}
          </div>
          <LocalTime ms={event.createdAtMs} />
          <span class="event-chevron" aria-hidden="true">
            ›
          </span>
        </div>
      </div>
    </article>
  );
}

export function EventInspector(props: {
  event: TOption<TPersistedBehaviorLogEvent>;
  query: TBehaviorLogSearchQuery;
  open: boolean;
  onClose: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  let className = "event-inspector";

  if (props.open) {
    className += " open";
  }

  useEffect(() => {
    if (contentRef.current !== null) {
      contentRef.current.scrollTop = 0;
    }
  }, [props.event?.id]);

  return (
    <aside class={className} aria-label="Event details">
      <div class="inspector-heading">
        <h2>Event details</h2>
        <button
          class="button secondary small inspector-close"
          type="button"
          onClick={props.onClose}
        >
          Close
        </button>
      </div>
      <div id="event-inspector-content" aria-live="polite" ref={contentRef}>
        {props.event === undefined && (
          <div class="inspector-empty">
            <strong>Select an event</strong>
            <p>Choose an event from the timeline to inspect its context and raw payload.</p>
          </div>
        )}
        {props.event !== undefined && (
          <EventInspectorContent event={props.event} query={props.query} />
        )}
      </div>
    </aside>
  );
}

function EventInspectorContent(props: {
  event: TPersistedBehaviorLogEvent;
  query: TBehaviorLogSearchQuery;
}) {
  const event = props.event;
  const status = eventStatus(event);
  const metadataEntries = Object.entries(event.metadata);
  let duration = "Not reported";
  let durationClass: TOption<string>;

  if (event.durationMs !== null) {
    duration = formatDuration(event.durationMs);
  }

  if (isSlowEvent(event)) {
    durationClass = "warning";
  }

  return (
    <div class="inspector-content">
      <div class="inspector-event-title">
        <strong>{event.event}</strong>
        <span class={`status-label ${status.className}`}>
          <span class="status-dot" aria-hidden="true"></span>
          {status.label}
        </span>
      </div>
      <InspectorSection title="Overview">
        <InspectorValue label="Result" value={status.label} className={status.className} />
        <InspectorValue label="Duration" value={duration} className={durationClass} />
        <div class="inspector-value">
          <span>Timestamp</span>
          <strong class="mono">
            <LocalTime ms={event.createdAtMs} />
          </strong>
        </div>
        <InspectorValue label="Level" value={event.level} />
      </InspectorSection>
      {event.event === "model.request.completed" && <ModelRequestUsage event={event} />}
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
        {metadataEntries.length === 0 && <p class="inspector-muted">No metadata recorded.</p>}
        {metadataEntries.map(([key, value]) => (
          <InspectorValue label={key} value={formatMetadataValue(value)} mono />
        ))}
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
        <CopyButton class="button secondary" label="Copy JSON" value={JSON.stringify(event)} />
        <a class="button secondary" href={turnUrl(props.query, event)}>
          Filter to this turn
        </a>
      </div>
    </div>
  );
}

function ModelRequestUsage(props: { event: TPersistedBehaviorLogEvent }) {
  const parsed = SModelRequestUsage.safeParse(props.event.metadata);
  if (!parsed.success) {
    return (
      <InspectorSection title="Prompt cache">
        <p class="inspector-muted">Usage not reported.</p>
      </InspectorSection>
    );
  }

  const usage = parsed.data;
  let percentage = "Not reported";
  if (usage.cacheHitPercent !== null) {
    percentage = `${usage.cacheHitPercent.toFixed(1)}%`;
  }

  return (
    <InspectorSection title="Prompt cache">
      <InspectorValue label="Cache hit" value={percentage} />
      <InspectorValue
        label="Input tokens (total)"
        value={usage.inputTokens.toLocaleString("en-US")}
      />
      <InspectorValue label="Cached tokens read" value={usage.cacheRead.toLocaleString("en-US")} />
      <InspectorValue
        label="Cache tokens written"
        value={usage.cacheWrite.toLocaleString("en-US")}
      />
      <InspectorValue label="Uncached input tokens" value={usage.input.toLocaleString("en-US")} />
      <InspectorValue label="Output tokens" value={usage.output.toLocaleString("en-US")} />
      <p class="inspector-muted">Cache hit is the share of input tokens reused on this request.</p>
    </InspectorSection>
  );
}

function InspectorSection(props: PropsWithChildren<{ title: string; className?: string }>) {
  let className = "inspector-section";

  if (props.className !== undefined) {
    className += ` ${props.className}`;
  }

  return (
    <section class={className}>
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
  let className = "";

  if (props.mono === true) {
    className = "mono";
  }

  if (props.className !== undefined) {
    if (className.length > 0) {
      className += " ";
    }

    className += props.className;
  }

  return (
    <div class="inspector-value">
      <span>{props.label}</span>
      <strong class={className}>{props.value}</strong>
    </div>
  );
}

export function LoadMore(props: { hasMore: boolean; onLoad: () => Promise<void> }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const onLoadRef = useRef(props.onLoad);
  const loadingRef = useRef(false);
  onLoadRef.current = props.onLoad;

  const load = async () => {
    if (loadingRef.current || onLoadRef.current === null) {
      return;
    }

    loadingRef.current = true;
    await onLoadRef.current();
    loadingRef.current = false;
  };

  useEffect(() => {
    if (!props.hasMore || buttonRef.current === null) {
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        load();
      }
    });
    observer.observe(buttonRef.current);
    return () => observer.disconnect();
  }, [props.hasMore]);

  if (!props.hasMore) {
    return <div class="result-end">End of loaded results</div>;
  }

  return (
    <div class="load-more">
      <button class="button secondary" type="button" ref={buttonRef} onClick={load}>
        Load 100 older events
      </button>
    </div>
  );
}

function CopyButton(props: { class: string; label: string; value: string; title?: string }) {
  const [label, setLabel] = useState(props.label);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.value);
      setLabel("Copied");
    } catch (_error) {
      setLabel("Copy failed");
    }

    setTimeout(() => setLabel(props.label), 1200);
  };

  return (
    <button
      class={props.class}
      type="button"
      aria-label={props.title}
      title={props.title}
      onClick={copy}
    >
      {label}
    </button>
  );
}

function LocalTime(props: { ms: number }) {
  const date = new Date(props.ms);
  return (
    <time class="local-time" datetime={date.toISOString()} title={date.toLocaleString()}>
      {formatTimestamp(date)}
    </time>
  );
}

export function shortenId(value: string): string {
  if (value.length <= 28) {
    return value;
  }

  return `${value.slice(0, 12)}…${value.slice(-10)}`;
}

function getActiveTheme(): string {
  const selected = document.documentElement.dataset.theme;

  if (selected !== undefined) {
    return selected;
  }

  if (matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }

  return "dark";
}

function turnUrl(query: TBehaviorLogSearchQuery, event: TPersistedBehaviorLogEvent): string {
  return buildLogUrl(query, {
    includeUntil: false,
    includeCursor: false,
    live: query.live,
    overrides: { range: "all", turnId: event.turnId },
  });
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
  return event.event.endsWith(".started");
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

  if (turnId.startsWith("sys:")) {
    return { label: "System", icon: "◆" };
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

function formatTimestamp(date: Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));

  if (seconds < 10) {
    return "just now";
  }

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.round(hours / 24);

  if (days < 7) {
    return `${days}d ago`;
  }

  return date.toLocaleString();
}
