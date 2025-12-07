import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../utils/api";

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatDuration(duration) {
  if (duration === null || duration === undefined) return "—";
  return `${duration} ms`;
}

function formatVersion(value) {
  if (value === null || value === undefined) return "—";
  return `v${value}`;
}

function formatPayload(value) {
  if (value === null || value === undefined) return "—";

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "—";
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch (err) {
      return value;
    }
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    return String(value);
  }
}

function getLogLevelTone(level) {
  const normalized = (level || "").toLowerCase();
  if (normalized === "error") return "text-red-400";
  if (normalized === "warn" || normalized === "warning") return "text-amber-300";
  if (normalized === "success") return "text-emerald-300";
  if (normalized === "debug") return "text-indigo-300";
  return "text-sky-300";
}

function getLogTypeTone(type) {
  const normalized = (type || "").toLowerCase();
  if (normalized === "authentication") {
    return "border-amber-500/70 bg-amber-900/20 text-amber-200";
  }
  return "border-slate-700 bg-slate-900/60 text-slate-300";
}

function getMethodBadgeTone(method) {
  const normalized = (method || "").toUpperCase();
  const baseClasses =
    "ml-2 inline-flex items-center justify-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide shadow-sm transition-colors";

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

export default function ScriptAnalytics({
  script,
  refreshKey = 0,
  onRefresh,
  onAuthError,
}) {
  const [runs, setRuns] = useState([]);
  const [stats, setStats] = useState({ totalRuns: 0, avgDuration: 0, successRate: 0 });
  const [activeRunId, setActiveRunId] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  const loadRuns = useCallback(async ({ showLoading = true } = {}) => {
    if (!script?.endpoint) {
      setRuns([]);
      setStats({ totalRuns: 0, avgDuration: 0, successRate: 0 });
      setActiveRunId(null);
      setIsLoading(false);
      return;
    }

    if (showLoading) {
      setIsLoading(true);
    }
    try {
      const data = await apiRequest(`/api/logs/${encodeURIComponent(script.endpoint)}`);
      const fetchedRuns = data?.runs || data?.history || [];
      setRuns(fetchedRuns);
      setStats({
        totalRuns: data?.totalRuns ?? fetchedRuns.length ?? 0,
        avgDuration: data?.avgDuration ?? 0,
        successRate: data?.successRate ?? 0,
      });
      setActiveRunId((prevId) => {
        if (prevId && fetchedRuns.some((run) => run.run_id === prevId)) {
          return prevId;
        }
        return fetchedRuns[0]?.run_id ?? null;
      });
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        console.error("Failed to load analytics:", err);
      }
      setRuns([]);
      setStats({ totalRuns: 0, avgDuration: 0, successRate: 0 });
      setActiveRunId(null);
    } finally {
      if (showLoading) {
        setIsLoading(false);
      }
    }
  }, [script?.endpoint]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns, refreshKey]);

  const handleManualRefresh = () => {
    if (!script?.endpoint) return;
    if (onRefresh) {
      setIsLoading(true);
      onRefresh();
    } else {
      loadRuns();
    }
  };

  useEffect(() => {
    if (!script?.endpoint) return undefined;

    const hasActiveRuns = runs.some((run) =>
      ["running", "pending", "queued"].includes((run.status || "").toLowerCase()),
    );

    const refreshInterval = hasActiveRuns ? 3000 : 10000;
    const intervalId = setInterval(() => {
      loadRuns({ showLoading: false });
    }, refreshInterval);

    return () => clearInterval(intervalId);
  }, [script?.endpoint, runs, loadRuns]);

  const getStatusTone = useCallback((status) => {
    const normalized = (status || "").toLowerCase();
    if (normalized === "success" || normalized === "completed") return "text-green-400";
    if (normalized === "running" || normalized === "in_progress") return "text-amber-300";
    if (normalized === "pending" || normalized === "queued") return "text-sky-300";
    if (normalized === "error" || normalized === "failed") return "text-red-400";
    return "text-slate-300";
  }, []);

  const activeRun = runs.find((run) => run.run_id === activeRunId) || runs[0] || null;
  const hasRuns = runs.length > 0;

  return (
    <div className="flex h-full flex-col gap-4 p-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sky-400 font-semibold">Run Analytics</h3>
          <p className="text-xs text-slate-500">Tap a run to inspect its logs and output.</p>
        </div>
        <button
          type="button"
          onClick={handleManualRefresh}
          disabled={isLoading}
          className={`rounded border border-slate-700 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition ${
            isLoading
              ? "cursor-not-allowed bg-slate-800/60 text-slate-500"
              : "bg-slate-800/50 text-slate-200 hover:bg-slate-800"
          }`}
        >
          {isLoading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <div className="grid gap-3 text-sm text-gray-300 sm:grid-cols-3">
        <div className="rounded border border-slate-800 bg-slate-900/40 px-3 py-2">
          <div className="text-xs uppercase tracking-wide text-slate-500">Total runs</div>
          <div className="text-base font-semibold text-slate-100">{stats.totalRuns}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-3 py-2">
          <div className="text-xs uppercase tracking-wide text-slate-500">Avg duration</div>
          <div className="text-base font-semibold text-slate-100">{stats.avgDuration} ms</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-3 py-2">
          <div className="text-xs uppercase tracking-wide text-slate-500">Success rate</div>
          <div
            className={`text-base font-semibold ${
              stats.successRate >= 80 ? "text-green-400" : "text-yellow-400"
            }`}
          >
            {stats.successRate}%
          </div>
        </div>
      </div>

      <div className="grid flex-1 gap-4 md:grid-cols-[minmax(0,240px)_1fr] md:items-stretch">
        <div className="flex h-full flex-col overflow-hidden rounded-md border border-slate-800 bg-slate-900/40">
          <div className="border-b border-slate-800 px-3 py-2 text-xs uppercase tracking-wide text-slate-400">
            Recent runs
          </div>
          {hasRuns ? (
            <ul className="flex-1 divide-y divide-slate-800 overflow-y-auto text-sm">
              {runs.map((run) => {
                const runKey = run.run_id || `run-${run.start_time}`;
                const isActive = (run.run_id || null) === activeRun?.run_id;
                const statusTone = getStatusTone(run.status);
                const authenticationFlag = hasAuthenticationLog(run);
                const methodLabel =
                  typeof run.http_method === "string" && run.http_method.trim()
                    ? run.http_method.trim().toUpperCase()
                    : null;
                return (
                  <li key={runKey}>
                    <button
                      type="button"
                      onClick={() => setActiveRunId(run.run_id ?? null)}
                    className={`w-full border-l-2 px-3 py-2 text-left transition-colors ${
                      isActive
                        ? "border-sky-400 bg-slate-800/60"
                        : "border-transparent hover:bg-slate-800/40"
                    }`}
                  >
                      <div className="flex items-center justify-between gap-3 text-xs">
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[11px] font-semibold uppercase tracking-wide ${statusTone}`}
                          >
                            {run.status || "unknown"}
                          </span>
                          {authenticationFlag && (
                            <span
                              className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${getLogTypeTone(
                                "authentication",
                              )}`}
                            >
                              Authentication
                            </span>
                          )}
                        </div>
                        <span className="text-[11px] text-slate-500">
                          {formatDuration(run.duration_ms)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-xs text-slate-300">
                        <div className="flex items-center gap-2 truncate">
                          <span className="truncate">{formatDate(run.start_time)}</span>
                          {methodLabel && (
                            <span className={getMethodBadgeTone(methodLabel)}>{methodLabel}</span>
                          )}
                        </div>

                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="flex flex-1 items-center justify-center px-4 text-xs text-slate-500">
              {isLoading ? "Loading run history..." : "No run history yet."}
            </div>
          )}
        </div>

        <div className="flex h-full min-w-0 flex-col rounded-md border border-slate-800 bg-slate-900/40 p-3 text-sm text-slate-200">
          {activeRun ? (
            <div className="space-y-4">
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-semibold text-sky-300">Run details</h4>
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    <span className="font-mono break-all text-slate-400">
                      {activeRun.run_id || "(legacy run)"}
                    </span>
                    <span className="rounded border border-slate-700 px-2 py-0.5 font-semibold uppercase tracking-wide text-slate-300">
                      {formatVersion(activeRun.code_version)}
                    </span>
                  </div>
                </div>
                <div className="mt-2 grid gap-2 text-xs text-slate-400 sm:grid-cols-2">
                  <div>
                    <span className="text-slate-500">Started:</span>{" "}
                    {formatDate(activeRun.start_time)}
                  </div>
                  <div>
                    <span className="text-slate-500">Status:</span>{" "}
                    <span className={`font-semibold ${getStatusTone(activeRun.status)}`}>
                      {activeRun.status || "unknown"}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">Duration:</span>{" "}
                    {formatDuration(activeRun.duration_ms)}
                  </div>
                  <div>
                    <span className="text-slate-500">Exit code:</span>{" "}
                    {activeRun.exit_code ?? "—"}
                  </div>
                  <div>
                    <span className="text-slate-500">HTTP method:</span>{" "}
                    {activeRun.http_method || "—"}
                  </div>
                  <div>
                    <span className="text-slate-500">Code version:</span>{" "}
                    {formatVersion(activeRun.code_version)}
                  </div>
                </div>
              </div>

              <div>
                <h5 className="text-xs uppercase tracking-wide text-slate-400">Input payload</h5>
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-slate-950/60 p-2 text-xs text-slate-200">
                  {formatPayload(activeRun.input)}
                </pre>
              </div>

              <div>
                <h5 className="text-xs uppercase tracking-wide text-slate-400">Return payload</h5>
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-slate-950/60 p-2 text-xs text-slate-200">
                  {formatPayload(activeRun.return)}
                </pre>
              </div>

              <div>
                <h5 className="text-xs uppercase tracking-wide text-slate-400">AutomnLog events</h5>
                {activeRun.automn_logs?.length ? (
                  <ul className="mt-1 space-y-2">
                    {activeRun.automn_logs.map((log, index) => (
                      <li
                        key={`${log.timestamp || index}-${index}`}
                        className="rounded border border-slate-800 bg-slate-950/50 p-2"
                      >
                        <div className="flex items-center justify-between text-xs">
                          <div className="flex items-center gap-2">
                            <span
                              className={`font-semibold uppercase ${getLogLevelTone(log.level)}`}
                            >
                              {log.level || "info"}
                            </span>
                            <span
                              className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${getLogTypeTone(log.type)}`}
                            >
                              {log.type || "general"}
                            </span>
                          </div>
                          <span className="font-mono text-[11px] text-slate-500">
                            {log.timestamp ? formatDate(log.timestamp) : `#${log.order ?? index + 1}`}
                          </span>
                        </div>
                        <div className="mt-1 text-sm text-slate-200">{log.message || "—"}</div>
                        {log.context && Object.keys(log.context).length > 0 && (
                          <pre className="mt-1 max-h-32 overflow-auto rounded bg-slate-900/80 p-2 text-[11px] text-slate-300">
                            {JSON.stringify(log.context, null, 2)}
                          </pre>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="mt-1 text-xs text-slate-500">No AutomnLog events recorded.</div>
                )}
              </div>

              <div>
                <h5 className="text-xs uppercase tracking-wide text-slate-400">AutomnNotify events</h5>
                {activeRun.automn_notifications?.length ? (
                  <ul className="mt-1 space-y-2">
                    {activeRun.automn_notifications.map((note, index) => {
                      const levelTone =
                        note.level === "error"
                          ? "text-red-400"
                          : note.level === "warn"
                          ? "text-amber-300"
                          : "text-sky-300";
                      const audience =
                        note.audience ||
                        note?.raw?.audience ||
                        note?.raw?.target ||
                        note?.raw?.user ||
                        null;
                      const timestamp = note.timestamp
                        ? formatDate(note.timestamp)
                        : `#${note.order ?? index + 1}`;
                      return (
                        <li
                          key={`${note.timestamp || index}-${index}`}
                          className="rounded border border-slate-800 bg-slate-950/50 p-2"
                        >
                          <div className="flex items-center justify-between text-xs">
                            <span className={`font-semibold uppercase ${levelTone}`}>
                              {note.level || "info"}
                            </span>
                            <span className="font-mono text-[11px] text-slate-500">
                              {timestamp}
                            </span>
                          </div>
                          <div className="mt-1 text-sm text-slate-200">
                            {note.message || "—"}
                          </div>
                          {audience && (
                            <div className="mt-1 text-[11px] text-slate-400">
                              Target: {audience}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div className="mt-1 text-xs text-slate-500">No AutomnNotify events recorded.</div>
                )}
              </div>

              <div>
                <h5 className="text-xs uppercase tracking-wide text-slate-400">STDOUT</h5>
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-slate-950/60 p-2 text-xs text-slate-200 whitespace-pre-wrap">
                  {activeRun.stdout ? activeRun.stdout : "—"}
                </pre>
              </div>

              <div>
                <h5 className="text-xs uppercase tracking-wide text-slate-400">STDERR</h5>
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-slate-950/60 p-2 text-xs text-slate-200 whitespace-pre-wrap">
                  {activeRun.stderr ? activeRun.stderr : "—"}
                </pre>
              </div>
            </div>
          ) : (
            <div className="text-gray-500">Select a run to view detailed logs.</div>
          )}
        </div>
      </div>
    </div>
  );
}
