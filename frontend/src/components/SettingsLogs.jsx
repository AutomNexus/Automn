import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "../utils/api";

const INPUT_CLASSES =
  "w-full rounded-lg border border-[color:var(--color-input-border)] bg-[color:var(--color-input-bg)] px-3 py-2 text-sm text-[color:var(--color-input-text)] placeholder:text-[color:var(--color-input-placeholder)] transition focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]";
const PANEL_CLASSES =
  "rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-surface-2)] shadow-sm";
const SECTION_HEADING_CLASSES = "text-lg font-semibold text-[color:var(--color-text-strong)]";
const SECTION_SUBTITLE_CLASSES = "text-sm text-[color:var(--color-text-muted)]";

const RESULT_OPTIONS = [
  { value: "", label: "All results" },
  { value: "success", label: "Success" },
  { value: "error", label: "Error" },
  { value: "running", label: "Running" },
  { value: "pending", label: "Pending" },
];

const HTTP_METHOD_OPTIONS = [
  { value: "", label: "All HTTP types" },
  { value: "GET", label: "GET" },
  { value: "POST", label: "POST" },
  { value: "PUT", label: "PUT" },
  { value: "PATCH", label: "PATCH" },
  { value: "DELETE", label: "DELETE" },
];

const DATE_RANGE_OPTIONS = [
  { value: "24h", label: "Last 24 hours" },
  { value: "week", label: "Last week" },
  { value: "month", label: "Last month" },
  { value: "year", label: "Last year" },
  { value: "all", label: "All time" },
  { value: "custom", label: "Custom" },
];

const PAGE_SIZE = 50;

function formatDateTime(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function getStatusTone(status) {
  const normalized = (status || "").toLowerCase();
  if (normalized === "success") {
    return "text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-500/10 dark:border-emerald-500/40";
  }
  if (normalized === "error") {
    return "text-rose-700 bg-rose-50 border-rose-200 dark:text-rose-300 dark:bg-rose-500/10 dark:border-rose-500/40";
  }
  if (normalized === "running" || normalized === "pending") {
    return "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-200 dark:bg-amber-500/10 dark:border-amber-500/40";
  }
  return "text-slate-700 bg-slate-100 border-slate-200 dark:text-slate-300 dark:bg-slate-600/20 dark:border-slate-500/40";
}

function getMethodBadgeTone(method) {
  const normalized = (method || "").toUpperCase();
  const baseClasses =
    "inline-flex items-center justify-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide shadow-sm";

  switch (normalized) {
    case "GET":
      return `${baseClasses} border-emerald-300 bg-emerald-100 text-emerald-700 dark:border-emerald-400/60 dark:bg-emerald-400/15 dark:text-emerald-100`;
    case "POST":
      return `${baseClasses} border-sky-300 bg-sky-100 text-sky-700 dark:border-sky-400/60 dark:bg-sky-400/15 dark:text-sky-100`;
    case "PUT":
      return `${baseClasses} border-indigo-300 bg-indigo-100 text-indigo-700 dark:border-indigo-400/60 dark:bg-indigo-400/15 dark:text-indigo-100`;
    case "DELETE":
      return `${baseClasses} border-rose-300 bg-rose-100 text-rose-700 dark:border-rose-400/60 dark:bg-rose-400/15 dark:text-rose-100`;
    case "PATCH":
      return `${baseClasses} border-amber-300 bg-amber-100 text-amber-700 dark:border-amber-400/60 dark:bg-amber-400/15 dark:text-amber-100`;
    default:
      return `${baseClasses} border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-500/60 dark:bg-slate-500/20 dark:text-slate-100`;
  }
}

function TagBadge({ children }) {
  if (!children) return <span className="text-[color:var(--color-text-muted)]">None</span>;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[color:var(--color-panel-border)] bg-[color:var(--color-badge-muted-bg)] px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-[color:var(--color-badge-muted-text)]">
      <span className="h-2 w-2 rounded-full bg-[color:var(--color-text-muted)]" />
      {children}
    </span>
  );
}

function StatusBadge({ status }) {
  const tone = getStatusTone(status);
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${tone}`}>
      <span className="h-2 w-2 rounded-full bg-current" />
      {status || "Unknown"}
    </span>
  );
}

function RequestBadge({ method, fallback }) {
  if (!method && !fallback) return <span className="text-[color:var(--color-text-muted)]">Unknown</span>;
  if (!method) {
    return (
      <span className="inline-flex items-center rounded-full border border-[color:var(--color-panel-border)] bg-[color:var(--color-badge-muted-bg)] px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-strong)]">
        {fallback}
      </span>
    );
  }
  return <span className={getMethodBadgeTone(method)}>{method}</span>;
}

export default function SettingsLogs({ onAuthError }) {
  const [events, setEvents] = useState([]);
  const [scripts, setScripts] = useState([]);
  const [runnerHosts, setRunnerHosts] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [filters, setFilters] = useState({
    collectionId: "",
    scriptId: "",
    runnerHostId: "",
    result: "",
    httpType: "",
    errorTag: "",
    search: "",
    dateRange: "24h",
    customFrom: "",
    customTo: "",
  });
  const [currentPage, setCurrentPage] = useState(1);
  const queryFilters = useMemo(
    () => ({
      collectionId: filters.collectionId,
      scriptId: filters.scriptId,
      runnerHostId: filters.runnerHostId,
      result: filters.result,
      httpType: filters.httpType,
      errorTag: filters.errorTag,
      search: filters.search,
    }),
    [
      filters.collectionId,
      filters.errorTag,
      filters.httpType,
      filters.result,
      filters.runnerHostId,
      filters.scriptId,
      filters.search,
    ],
  );

  const loadScripts = useCallback(async () => {
    try {
      const data = await apiRequest("/api/scripts");
      setScripts(Array.isArray(data) ? data : []);
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
        return;
      }
      console.error("Failed to load scripts", err);
    }
  }, [onAuthError]);

  const loadRunnerHosts = useCallback(async () => {
    try {
      const data = await apiRequest("/api/runners");
      const normalized = Array.isArray(data?.runnerHosts)
        ? data.runnerHosts.map((runner) => ({
            id: runner.id,
            name: runner.name || runner.id,
          }))
        : [];
      setRunnerHosts(normalized);
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        console.error("Failed to load runner hosts", err);
      }
    }
  }, [onAuthError]);

  const loadEvents = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (queryFilters.collectionId) params.set("collectionId", queryFilters.collectionId);
      if (queryFilters.scriptId) params.set("scriptId", queryFilters.scriptId);
      if (queryFilters.runnerHostId) params.set("runnerHostId", queryFilters.runnerHostId);
      if (queryFilters.result) params.set("result", queryFilters.result);
      if (queryFilters.httpType) params.set("httpType", queryFilters.httpType);
      if (queryFilters.errorTag) params.set("errorTag", queryFilters.errorTag);
      if (queryFilters.search) params.set("search", queryFilters.search);
      params.set("limit", "200");

      const query = params.toString();
      const data = await apiRequest(`/api/logs${query ? `?${query}` : ""}`);
      setEvents(Array.isArray(data?.events) ? data.events : []);
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        console.error("Failed to load logs", err);
        setError(err?.message || "Failed to load logs");
      }
      setEvents([]);
    } finally {
      setIsLoading(false);
    }
  }, [onAuthError, queryFilters]);

  useEffect(() => {
    loadScripts();
    loadRunnerHosts();
  }, [loadScripts, loadRunnerHosts]);

  useEffect(() => {
    const timer = setTimeout(() => {
      loadEvents();
    }, 250);
    return () => clearTimeout(timer);
  }, [loadEvents, queryFilters]);

  const collectionOptions = useMemo(() => {
    const options = new Map();
    options.set("", "All collections");
    scripts.forEach((script) => {
      if (script.collectionId) {
        options.set(script.collectionId, script.collection?.name || "Unnamed collection");
      }
    });
    return Array.from(options.entries()).map(([value, label]) => ({ value, label }));
  }, [scripts]);

  const scriptOptions = useMemo(() => {
    const options = [{ value: "", label: "All scripts" }];
    scripts
      .filter((script) => !filters.collectionId || script.collectionId === filters.collectionId)
      .forEach((script) => {
        options.push({ value: script.id, label: script.name || script.endpoint });
      });
    return options;
  }, [scripts, filters.collectionId]);

  const errorTagOptions = useMemo(() => {
    const tags = new Set();
    events.forEach((event) => {
      if (Array.isArray(event.errorTags)) {
        event.errorTags.forEach((tag) => {
          if (typeof tag === "string" && tag.trim()) {
            tags.add(tag);
          }
        });
      }
    });
    const options = [{ value: "", label: "All tags" }];
    Array.from(tags).sort().forEach((tag) => options.push({ value: tag, label: tag }));
    return options;
  }, [events]);

  const runnerHostOptions = useMemo(() => {
    const entries = new Map();
    entries.set("", "All runners");

    runnerHosts.forEach((runner) => {
      entries.set(runner.id, runner.name || runner.id);
    });

    events.forEach((event) => {
      if (event.runnerHostId && !entries.has(event.runnerHostId)) {
        entries.set(event.runnerHostId, event.runnerName || event.runnerHostId);
      }
    });

    const options = [{ value: "", label: "All runners" }];
    const namedOptions = Array.from(entries.entries())
      .filter(([value]) => value)
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));

    return options.concat(namedOptions);
  }, [runnerHosts, events]);

  const filteredEvents = useMemo(() => {
    const now = Date.now();
    let start = null;
    let end = null;

    switch (filters.dateRange) {
      case "24h":
        start = now - 24 * 60 * 60 * 1000;
        end = now;
        break;
      case "week":
        start = now - 7 * 24 * 60 * 60 * 1000;
        end = now;
        break;
      case "month":
        start = now - 30 * 24 * 60 * 60 * 1000;
        end = now;
        break;
      case "year":
        start = now - 365 * 24 * 60 * 60 * 1000;
        end = now;
        break;
      case "custom":
        if (filters.customFrom) {
          const parsed = new Date(filters.customFrom);
          if (!Number.isNaN(parsed.getTime())) {
            start = parsed.getTime();
          }
        }
        if (filters.customTo) {
          const parsed = new Date(filters.customTo);
          if (!Number.isNaN(parsed.getTime())) {
            end = parsed.getTime();
          }
        }
        break;
      default:
        start = null;
        end = null;
    }

    return events.filter((event) => {
      if (!event.timestamp) return true;
      const eventTime = new Date(event.timestamp).getTime();
      if (Number.isNaN(eventTime)) return true;
      if (start !== null && eventTime < start) return false;
      if (end !== null && eventTime > end) return false;
      return true;
    });
  }, [events, filters.customFrom, filters.customTo, filters.dateRange]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(filteredEvents.length / PAGE_SIZE)),
    [filteredEvents.length],
  );

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const paginatedEvents = useMemo(() => {
    const startIndex = (currentPage - 1) * PAGE_SIZE;
    return filteredEvents.slice(startIndex, startIndex + PAGE_SIZE);
  }, [filteredEvents, currentPage]);

  useEffect(() => {
    if (!selectedEvent) return;
    const stillPresent = filteredEvents.some((event) => event.runId === selectedEvent.runId);
    if (!stillPresent) {
      setSelectedEvent(null);
    }
  }, [filteredEvents, selectedEvent]);

  const startEntry = filteredEvents.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const endEntry = filteredEvents.length === 0 ? 0 : Math.min(currentPage * PAGE_SIZE, filteredEvents.length);

  const handleFilterChange = (key, value) => {
    setFilters((prev) => {
      if (key === "collectionId") {
        return { ...prev, collectionId: value, scriptId: "" };
      }
      if (key === "dateRange") {
        return {
          ...prev,
          dateRange: value,
          customFrom: value === "custom" ? prev.customFrom : "",
          customTo: value === "custom" ? prev.customTo : "",
        };
      }
      return { ...prev, [key]: value };
    });
    setCurrentPage(1);
  };

  return (
    <div className="flex h-full flex-col gap-6">
      <div className="space-y-2">
        <h3 className={SECTION_HEADING_CLASSES}>Consolidated Logs</h3>
        <p className={SECTION_SUBTITLE_CLASSES}>
          Review recent activity across the scripts you can access. Filter by collection, script, runner, HTTP method,
          result, or error tag, and search within log summaries.
        </p>
      </div>

      <div className={`${PANEL_CLASSES} p-4`}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <label className="space-y-1 text-sm text-[color:var(--color-text-strong)]">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Collection</span>
            <select
              className={INPUT_CLASSES}
              value={filters.collectionId}
              onChange={(event) => handleFilterChange("collectionId", event.target.value)}
            >
              {collectionOptions.map((option) => (
                <option key={option.value || "all"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1 text-sm text-[color:var(--color-text-strong)] xl:col-span-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Date Range</span>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)]">
              <select
                className={INPUT_CLASSES}
                value={filters.dateRange}
                onChange={(event) => handleFilterChange("dateRange", event.target.value)}
              >
                {DATE_RANGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {filters.dateRange === "custom" ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <input
                    type="datetime-local"
                    className={INPUT_CLASSES}
                    value={filters.customFrom}
                    onChange={(event) => handleFilterChange("customFrom", event.target.value)}
                    placeholder="Start"
                  />
                  <input
                    type="datetime-local"
                    className={INPUT_CLASSES}
                    value={filters.customTo}
                    onChange={(event) => handleFilterChange("customTo", event.target.value)}
                    placeholder="End"
                  />
                </div>
              ) : null}
            </div>
          </label>

          <label className="space-y-1 text-sm text-[color:var(--color-text-strong)]">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Runner</span>
            <select
              className={INPUT_CLASSES}
              value={filters.runnerHostId}
              onChange={(event) => handleFilterChange("runnerHostId", event.target.value)}
            >
              {runnerHostOptions.map((option) => (
                <option key={option.value || "all"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1 text-sm text-[color:var(--color-text-strong)]">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Script</span>
            <select
              className={INPUT_CLASSES}
              value={filters.scriptId}
              onChange={(event) => handleFilterChange("scriptId", event.target.value)}
            >
              {scriptOptions.map((option) => (
                <option key={option.value || "all"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1 text-sm text-[color:var(--color-text-strong)]">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Result</span>
            <select
              className={INPUT_CLASSES}
              value={filters.result}
              onChange={(event) => handleFilterChange("result", event.target.value)}
            >
              {RESULT_OPTIONS.map((option) => (
                <option key={option.value || "all"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1 text-sm text-[color:var(--color-text-strong)]">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">HTTP Type</span>
            <select
              className={INPUT_CLASSES}
              value={filters.httpType}
              onChange={(event) => handleFilterChange("httpType", event.target.value)}
            >
              {HTTP_METHOD_OPTIONS.map((option) => (
                <option key={option.value || "all"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1 text-sm text-[color:var(--color-text-strong)]">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Error Tag</span>
            <select
              className={INPUT_CLASSES}
              value={filters.errorTag}
              onChange={(event) => handleFilterChange("errorTag", event.target.value)}
            >
              {errorTagOptions.map((option) => (
                <option key={option.value || "all"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1 text-sm text-[color:var(--color-text-strong)]">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Search</span>
            <input
              type="search"
              placeholder="Search logs, scripts, tags"
              className={INPUT_CLASSES}
              value={filters.search}
              onChange={(event) => handleFilterChange("search", event.target.value)}
            />
          </label>
        </div>
      </div>

      <div className={`${PANEL_CLASSES} flex-1 space-y-3 p-4`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--color-panel-border)] pb-3">
          <div className="space-y-0.5">
            <h4 className="text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">Log Events</h4>
            <p className="text-sm text-[color:var(--color-text-strong)]">
              Showing {filteredEvents.length} entr{filteredEvents.length === 1 ? "y" : "ies"} matching your filters.
            </p>
          </div>
          <button
            className="rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-input-bg)] px-4 py-2 text-sm font-semibold text-[color:var(--color-text-strong)] transition hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            onClick={loadEvents}
            disabled={isLoading}
          >
            {isLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {error && (
          <div className="rounded border border-[color:var(--color-action-danger-border)] bg-[color:var(--color-action-danger-bg)] px-4 py-3 text-sm text-[color:var(--color-action-danger-text)]">
            {error}
          </div>
        )}

        <div className="overflow-hidden rounded border border-[color:var(--color-panel-border)]">
          <table className="min-w-[880px] w-full table-fixed divide-y divide-[color:var(--color-divider)] text-sm text-[color:var(--color-text-strong)]">
            <thead className="bg-[color:var(--color-surface-2)] text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">
              <tr>
                <th className="w-32 px-4 py-2 text-left">Result</th>
                <th className="w-48 px-4 py-2 text-left">Event Date</th>
                <th className="px-4 py-2 text-left">Script</th>
                <th className="w-56 px-4 py-2 text-left">Target Runner</th>
                <th className="w-32 px-4 py-2 text-left">Request Type</th>
                <th className="w-32 px-4 py-2 text-left">Error Tag</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-divider)] bg-[color:var(--color-surface-1)] text-[color:var(--color-text-strong)]">
              {isLoading && (
                <tr>
                  <td className="px-4 py-6 text-center text-sm text-[color:var(--color-text-muted)]" colSpan={6}>
                    Loading logs...
                  </td>
                </tr>
              )}
              {!isLoading && filteredEvents.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-sm text-[color:var(--color-text-muted)]" colSpan={6}>
                    No log events match your filters yet.
                  </td>
                </tr>
              )}
              {!isLoading &&
                paginatedEvents.map((event) => (
                  <tr
                    key={event.runId}
                    onClick={() => setSelectedEvent(event)}
                    className="cursor-pointer transition hover:bg-[color:var(--color-surface-3)]"
                  >
                    <td className="px-4 py-3">
                      <StatusBadge status={event.result} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-1 text-[color:var(--color-text-strong)]">
                        <div className="font-semibold">{formatDateTime(event.timestamp)}</div>
                        {event.message ? (
                          <div className="line-clamp-1 text-xs text-[color:var(--color-text-muted)]" title={event.message}>
                            {event.message}
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-1">
                        <div className="font-semibold text-[color:var(--color-text-strong)]">{event.scriptName}</div>
                        <div className="text-xs text-[color:var(--color-text-muted)]">{event.collectionName}</div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-1">
                        <div className="font-semibold text-[color:var(--color-text-strong)]">
                          {event.runnerName || event.runnerHostId || "Unassigned"}
                        </div>
                        {event.runnerHostId ? (
                          <div className="text-xs text-[color:var(--color-text-muted)]">{event.runnerHostId}</div>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <RequestBadge method={event.httpType} fallback={event.requestType} />
                    </td>
                    <td className="px-4 py-3">
                      <TagBadge>{event.errorTag}</TagBadge>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 px-2 py-3 text-sm text-[color:var(--color-text-muted)]">
          <span>
            Showing {startEntry}-{endEntry} of {filteredEvents.length} entr{filteredEvents.length === 1 ? "y" : "ies"}.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
              disabled={currentPage === 1 || filteredEvents.length === 0}
              className="rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-input-bg)] px-3 py-1.5 text-sm font-semibold text-[color:var(--color-text-strong)] transition hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              Previous
            </button>
            <span className="text-[color:var(--color-text-strong)]">Page {currentPage} of {totalPages}</span>
            <button
              type="button"
              onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
              disabled={currentPage === totalPages || filteredEvents.length === 0}
              className="rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-input-bg)] px-3 py-1.5 text-sm font-semibold text-[color:var(--color-text-strong)] transition hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {selectedEvent ? (
        <div className={`${PANEL_CLASSES} p-5`}>
          <div className="mb-4 flex items-start justify-between gap-3 border-b border-[color:var(--color-panel-border)] pb-3">
            <div className="space-y-1">
              <p className="text-[11px] uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">Log Details</p>
              <h5 className="text-xl font-semibold text-[color:var(--color-text-strong)]">{selectedEvent.scriptName}</h5>
              <p className="text-sm text-[color:var(--color-text-muted)]">{selectedEvent.collectionName}</p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedEvent(null)}
              className="rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-input-bg)] px-3 py-1.5 text-sm font-semibold text-[color:var(--color-text-strong)] transition hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-accent)]"
            >
              Close
            </button>
          </div>

          <dl className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <DetailRow label="Timestamp" value={formatDateTime(selectedEvent.timestamp)} />
            <DetailRow label="Result" value={<StatusBadge status={selectedEvent.result} />} />
            <DetailRow
              label="Target Runner"
              value={
                selectedEvent.runnerHostId ? (
                  <div className="space-y-0.5">
                    <div className="font-semibold text-[color:var(--color-text-strong)]">
                      {selectedEvent.runnerName || selectedEvent.runnerHostId}
                    </div>
                    <p className="text-xs text-[color:var(--color-text-muted)]">{selectedEvent.runnerHostId}</p>
                  </div>
                ) : (
                  <span className="text-[color:var(--color-text-muted)]">Unassigned</span>
                )
              }
            />
            <DetailRow
              label="Request Origin"
              value={
                <div className="space-y-1">
                  <RequestBadge method={selectedEvent.httpType} fallback={selectedEvent.requestOrigin} />
                  {selectedEvent.triggeredByUserName ? (
                    <p className="text-xs text-[color:var(--color-text-muted)]">Triggered by {selectedEvent.triggeredByUserName}</p>
                  ) : selectedEvent.triggeredBy ? (
                    <p className="text-xs text-[color:var(--color-text-muted)]">Triggered by {selectedEvent.triggeredBy}</p>
                  ) : null}
                </div>
              }
            />
            <DetailRow label="Endpoint" value={selectedEvent.scriptEndpoint || "Unknown"} />
            <DetailRow
              label="Error Tags"
              value={
                selectedEvent.errorTags?.length ? (
                  <div className="flex flex-wrap gap-2">
                    {selectedEvent.errorTags.map((tag) => (
                      <TagBadge key={tag}>{tag}</TagBadge>
                    ))}
                  </div>
                ) : (
                  <span className="text-[color:var(--color-text-muted)]">None</span>
                )
              }
            />
          </dl>

          {selectedEvent.message ? (
            <div className={`${PANEL_CLASSES} mt-4 p-4 text-sm text-[color:var(--color-text-strong)]`}>
              <p className="text-[11px] uppercase tracking-[0.08em] text-[color:var(--color-text-muted)]">Message</p>
              <p className="whitespace-pre-wrap text-[color:var(--color-text-strong)]">{selectedEvent.message}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className={`${PANEL_CLASSES} space-y-1 p-3`}>
      <p className="text-[11px] uppercase tracking-wide text-[color:var(--color-text-muted)]">{label}</p>
      <div className="text-sm text-[color:var(--color-text-strong)]">{value || <span className="text-[color:var(--color-text-muted)]">Unknown</span>}</div>
    </div>
  );
}
