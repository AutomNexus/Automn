import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "../utils/api";

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
  if (!children) return <span className="text-slate-400">None</span>;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-slate-100 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-slate-700 dark:border-slate-600 dark:bg-slate-700/60 dark:text-slate-100">
      <span className="h-2 w-2 rounded-full bg-slate-500 dark:bg-slate-300" />
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
  if (!method && !fallback) return <span className="text-slate-400">Unknown</span>;
  if (!method) {
    return (
      <span className="inline-flex items-center rounded-full border border-slate-300 bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-700 dark:border-slate-500 dark:bg-slate-600/40 dark:text-slate-100">
        {fallback}
      </span>
    );
  }
  return <span className={getMethodBadgeTone(method)}>{method}</span>;
}

export default function SettingsLogs({ onAuthError }) {
  const [events, setEvents] = useState([]);
  const [scripts, setScripts] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [filters, setFilters] = useState({
    collectionId: "",
    scriptId: "",
    result: "",
    httpType: "",
    errorTag: "",
    search: "",
  });

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

  const loadEvents = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (filters.collectionId) params.set("collectionId", filters.collectionId);
      if (filters.scriptId) params.set("scriptId", filters.scriptId);
      if (filters.result) params.set("result", filters.result);
      if (filters.httpType) params.set("httpType", filters.httpType);
      if (filters.errorTag) params.set("errorTag", filters.errorTag);
      if (filters.search) params.set("search", filters.search);
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
  }, [filters, onAuthError]);

  useEffect(() => {
    loadScripts();
  }, [loadScripts]);

  useEffect(() => {
    const timer = setTimeout(() => {
      loadEvents();
    }, 250);
    return () => clearTimeout(timer);
  }, [filters, loadEvents]);

  useEffect(() => {
    if (!selectedEvent) return;
    const stillPresent = events.some((event) => event.runId === selectedEvent.runId);
    if (!stillPresent) {
      setSelectedEvent(null);
    }
  }, [events, selectedEvent]);

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

  const handleFilterChange = (key, value) => {
    setFilters((prev) => {
      if (key === "collectionId") {
        return { ...prev, collectionId: value, scriptId: "" };
      }
      return { ...prev, [key]: value };
    });
  };

  return (
    <div className="flex h-full flex-col gap-6">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold text-slate-100">Consolidated Logs</h3>
        <p className="text-sm text-slate-400">
          Review recent activity across the scripts you can access. Filter by collection, script, HTTP method, result,
          or error tag, and search within log summaries.
        </p>
      </div>

      <div className="rounded border border-slate-800 bg-slate-900/40 p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <label className="space-y-1 text-sm text-slate-200">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Collection</span>
            <select
              className="w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 transition focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
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

          <label className="space-y-1 text-sm text-slate-200">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Script</span>
            <select
              className="w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 transition focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
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

          <label className="space-y-1 text-sm text-slate-200">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Result</span>
            <select
              className="w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 transition focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
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

          <label className="space-y-1 text-sm text-slate-200">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">HTTP Type</span>
            <select
              className="w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 transition focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
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

          <label className="space-y-1 text-sm text-slate-200">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Error Tag</span>
            <select
              className="w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 transition focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
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

          <label className="space-y-1 text-sm text-slate-200">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Search</span>
            <input
              type="search"
              placeholder="Search logs, scripts, tags"
              className="w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 transition focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
              value={filters.search}
              onChange={(event) => handleFilterChange("search", event.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="flex-1 space-y-3 rounded border border-slate-800 bg-slate-900/40 p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="space-y-0.5">
            <h4 className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-400">Log Events</h4>
            <p className="text-sm text-slate-300">
              Showing {events.length} entr{events.length === 1 ? "y" : "ies"} matching your filters.
            </p>
          </div>
          <button
            className="rounded border border-slate-700 bg-slate-950/60 px-4 py-2 text-sm font-semibold text-slate-100 transition hover:border-sky-500 hover:text-sky-200 disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            onClick={loadEvents}
            disabled={isLoading}
          >
            {isLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {error && (
          <div className="rounded border border-rose-800/60 bg-rose-900/30 px-4 py-3 text-sm text-rose-100">
            {error}
          </div>
        )}

        <div className="overflow-hidden rounded border border-slate-800">
          <table className="min-w-[760px] w-full divide-y divide-slate-800 text-sm">
            <thead className="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left">Datetime</th>
                <th className="px-4 py-2 text-left">Script</th>
                <th className="px-4 py-2 text-left">Request Type</th>
                <th className="px-4 py-2 text-left">Result</th>
                <th className="px-4 py-2 text-left">Error Tag</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 bg-slate-900/30 text-slate-200">
              {isLoading && (
                <tr>
                  <td className="px-4 py-6 text-center text-sm text-slate-400" colSpan={5}>
                    Loading logs...
                  </td>
                </tr>
              )}
              {!isLoading && events.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-sm text-slate-400" colSpan={5}>
                    No log events match your filters yet.
                  </td>
                </tr>
              )}
              {!isLoading &&
                events.map((event) => (
                  <tr
                    key={event.runId}
                    onClick={() => setSelectedEvent(event)}
                    className="cursor-pointer transition hover:bg-slate-800/60"
                  >
                    <td className="px-4 py-3">
                      <div className="space-y-1 text-slate-200">
                        <div className="font-semibold">{formatDateTime(event.timestamp)}</div>
                        {event.message ? (
                          <div className="line-clamp-1 text-xs text-slate-400" title={event.message}>
                            {event.message}
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-1">
                        <div className="font-semibold text-slate-100">{event.scriptName}</div>
                        <div className="text-xs text-slate-400">{event.collectionName}</div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <RequestBadge method={event.httpType} fallback={event.requestType} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={event.result} />
                    </td>
                    <td className="px-4 py-3">
                      <TagBadge>{event.errorTag}</TagBadge>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {selectedEvent ? (
        <div className="rounded border border-slate-800 bg-slate-900/40 p-5 shadow-sm">
          <div className="mb-4 flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
            <div className="space-y-1">
              <p className="text-[11px] uppercase tracking-[0.08em] text-slate-400">Log Details</p>
              <h5 className="text-xl font-semibold text-slate-50">{selectedEvent.scriptName}</h5>
              <p className="text-sm text-slate-400">{selectedEvent.collectionName}</p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedEvent(null)}
              className="rounded border border-slate-700 bg-slate-950/60 px-3 py-1.5 text-sm font-semibold text-slate-100 transition hover:border-sky-500 hover:text-sky-200"
            >
              Close
            </button>
          </div>

          <dl className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <DetailRow label="Timestamp" value={formatDateTime(selectedEvent.timestamp)} />
            <DetailRow label="Result" value={<StatusBadge status={selectedEvent.result} />} />
            <DetailRow
              label="Request Origin"
              value={
                <div className="space-y-1">
                  <RequestBadge method={selectedEvent.httpType} fallback={selectedEvent.requestOrigin} />
                  {selectedEvent.triggeredByUserName ? (
                    <p className="text-xs text-slate-400">Triggered by {selectedEvent.triggeredByUserName}</p>
                  ) : selectedEvent.triggeredBy ? (
                    <p className="text-xs text-slate-400">Triggered by {selectedEvent.triggeredBy}</p>
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
                  <span className="text-slate-500">None</span>
                )
              }
            />
          </dl>

          {selectedEvent.message ? (
            <div className="mt-4 rounded border border-slate-800 bg-slate-950/40 p-4 text-sm text-slate-100">
              <p className="text-[11px] uppercase tracking-[0.08em] text-slate-400">Message</p>
              <p className="whitespace-pre-wrap text-slate-100">{selectedEvent.message}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="space-y-1 rounded border border-slate-800 bg-slate-950/40 p-3">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <div className="text-sm text-slate-100">{value || <span className="text-slate-500">Unknown</span>}</div>
    </div>
  );
}
