/** @jsxImportSource hono/jsx/dom */

import type {
  TBehaviorLogSearchQuery,
  TLogFilterOptions,
  TLogLiveUpdate,
  TLogReaderError,
  TLogReaderResult,
  TPersistedBehaviorLogEvent,
  TRecentTurn,
} from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "hono/jsx/dom";
import type { TLogViewerPage } from "../types";
import { buildLogUrl } from "./url";
import {
  ErrorPage,
  EventInspector,
  EventRows,
  LiveStatus,
  LoadMore,
  PageHeader,
  RecentTurns,
  SearchForm,
  shortenId,
} from "./views";

const LIVE_INTERVAL_MS = 5_000;
const ERROR_RETRY_MS = 5_000;
const CLOCK_INTERVAL_MS = 30_000;
const PHONE_QUERY = "(max-width: 760px)";

type TViewState =
  | { kind: "loading" }
  | { kind: "error"; error: TLogReaderError }
  | {
      kind: "ready";
      dbPath: string;
      query: TBehaviorLogSearchQuery;
      filters: TLogFilterOptions;
    };

type TScrollAnchor = { element: Element; top: number };

export function App() {
  const [search, setSearch] = useState(location.search);
  const [loadCount, setLoadCount] = useState(0);
  const [view, setView] = useState<TViewState>({ kind: "loading" });
  const [events, setEvents] = useState<TPersistedBehaviorLogEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [recentTurns, setRecentTurns] = useState<TRecentTurn[]>([]);
  const [selectedId, setSelectedId] = useState<TOption<number>>(undefined);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [warning, setWarning] = useState<TOption<string>>(undefined);
  const [phone, setPhone] = useState(matchMedia(PHONE_QUERY).matches);
  const [, setClock] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef(events);
  const viewRef = useRef(view);
  const scrollAnchorRef = useRef<TScrollAnchor>(null);
  eventsRef.current = events;
  viewRef.current = view;

  const navigate = (url: string) => {
    const target = new URL(url, location.href);

    if (target.href !== location.href) {
      history.pushState(null, "", target);
    }

    setSearch(target.search);
    setLoadCount((count) => count + 1);
  };

  useEffect(() => {
    const phoneQuery = matchMedia(PHONE_QUERY);
    const onPopState = () => setSearch(location.search);
    const onPhoneChange = () => {
      setPhone(phoneQuery.matches);
      setInspectorOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setInspectorOpen(false);
      }
    };
    /* In-app links are plain anchors; route them here instead of reloading the page. */
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      ) {
        return;
      }

      const link = event.target.closest("a");

      if (link === null || link.origin !== location.origin || link.pathname !== "/") {
        return;
      }

      event.preventDefault();
      navigate(link.href);
    };
    const clock = setInterval(() => setClock((tick) => tick + 1), CLOCK_INTERVAL_MS);

    addEventListener("popstate", onPopState);
    phoneQuery.addEventListener("change", onPhoneChange);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onClick);

    return () => {
      clearInterval(clock);
      removeEventListener("popstate", onPopState);
      phoneQuery.removeEventListener("change", onPhoneChange);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onClick);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetchResult<TLogViewerPage>(`/api/logs${search}`).then((result) => {
      if (cancelled) {
        return;
      }

      if (!result.success) {
        setView({ kind: "error", error: result.error });
        return;
      }

      const { dbPath, query, page } = result.data;
      setView({
        kind: "ready",
        dbPath,
        query,
        filters: page.filters,
      });
      setEvents(page.events);
      setRecentTurns(page.recentTurns);
      setHasMore(page.hasMore);
      setSelectedId(page.events[0]?.id);
      setInspectorOpen(false);
      setWarning(undefined);
    });

    return () => {
      cancelled = true;
    };
  }, [search, loadCount]);

  useEffect(() => {
    if (view.kind !== "error") {
      return;
    }

    const timer = setTimeout(() => setLoadCount((count) => count + 1), ERROR_RETRY_MS);
    return () => clearTimeout(timer);
  }, [view]);

  useEffect(() => {
    if (view.kind !== "ready" || !view.query.live) {
      return;
    }

    const query = view.query;
    let stopped = false;

    const poll = async () => {
      const newest = eventsRef.current?.[0];
      let afterCreatedAt = query.until;
      let afterId = 0;

      if (newest !== undefined) {
        afterCreatedAt = newest.createdAtMs;
        afterId = newest.id;
      }

      const endpoint = buildLogUrl(query, {
        includeUntil: true,
        includeCursor: false,
        live: true,
        path: "/api/logs/new",
      });
      const result = await fetchResult<TLogLiveUpdate>(
        `${endpoint}&afterCreatedAt=${afterCreatedAt}&afterId=${afterId}`,
      );

      if (stopped) {
        return;
      }

      if (!result.success) {
        setWarning(result.error.message);
      } else {
        const update = result.data;
        setWarning(undefined);
        setRecentTurns(update.recentTurns);

        if (update.events.length > 0) {
          scrollAnchorRef.current = captureScrollAnchor(listRef.current);
          setEvents((current) => [...update.events, ...current]);
        }
      }

      timer = setTimeout(poll, LIVE_INTERVAL_MS);
    };
    let timer = setTimeout(poll, LIVE_INTERVAL_MS);

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [view]);

  /* Keep the row under the reader in place when live events land above it. */
  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    const list = listRef.current;
    scrollAnchorRef.current = null;

    if (anchor === null || list === null) {
      return;
    }

    const delta = anchor.element.getBoundingClientRect().top - anchor.top;

    if (list.scrollTop > 0) {
      list.scrollTop += delta;
    } else {
      scrollBy(0, delta);
    }
  }, [events]);

  if (view.kind === "loading") {
    return <div class="log-viewer-shell"></div>;
  }

  if (view.kind === "error") {
    return <ErrorPage error={view.error} onRetry={() => setLoadCount((count) => count + 1)} />;
  }

  const query = view.query;
  const loadOlder = async () => {
    const last = events[events.length - 1];

    if (last === undefined) {
      return;
    }

    const url = buildLogUrl(
      { ...query, beforeCreatedAt: last.createdAtMs, beforeId: last.id },
      { includeUntil: true, includeCursor: true, live: false, path: "/api/logs" },
    );
    const result = await fetchResult<TLogViewerPage>(url);

    /* A navigation replaced the page while this request was in flight. */
    if (viewRef.current !== view) {
      return;
    }

    if (!result.success) {
      setWarning(result.error.message);
      return;
    }

    setEvents((current) => [...current, ...result.data.page.events]);
    setHasMore(result.data.page.hasMore);
  };

  return (
    <div class="log-viewer-shell">
      <div class="sticky-top">
        <PageHeader dbPath={view.dbPath} query={query} />
        {warning !== undefined && <div class="transient-warning">{warning}</div>}
        <SearchForm
          key={search}
          query={query}
          filters={view.filters}
          phone={phone}
          onSearch={navigate}
        />
      </div>
      <div class="workspace-grid">
        <RecentTurns turns={recentTurns} query={query} phone={phone} />
        <main class="event-workspace">
          <div class="results-heading">
            <div class="results-title">
              <strong>{events.length} events</strong>
              {query.turnId !== undefined && (
                <span>
                  Turn <code>{shortenId(query.turnId)}</code>
                </span>
              )}
            </div>
            <div class="results-actions">
              {query.live && <LiveStatus />}
              <span class="sort-label">Newest first</span>
            </div>
          </div>
          <div id="events-list" ref={listRef}>
            <EventRows
              events={events}
              query={query}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id);
                setInspectorOpen(true);
              }}
            />
            {events.length > 0 && <LoadMore hasMore={hasMore} onLoad={loadOlder} />}
          </div>
        </main>
        <EventInspector
          event={events.find((event) => event.id === selectedId)}
          query={query}
          open={inspectorOpen}
          onClose={() => setInspectorOpen(false)}
        />
      </div>
    </div>
  );
}

function captureScrollAnchor(list: HTMLDivElement | null): TScrollAnchor | null {
  if (list === null || (list.scrollTop === 0 && scrollY === 0)) {
    return null;
  }

  const element = list.querySelector("[data-event-id]");

  if (element === null) {
    return null;
  }

  return { element, top: element.getBoundingClientRect().top };
}

async function fetchResult<T>(url: string): Promise<TLogReaderResult<T>> {
  try {
    const response = await fetch(url);
    return await response.json();
  } catch (error) {
    return {
      success: false,
      error: {
        kind: "unavailable",
        message: "Cannot reach the log viewer",
        detail: String(error),
        dbPath: "",
      },
    };
  }
}
