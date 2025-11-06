import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "../utils/api";

const STATUS_LABELS = {
  installed: "Installed",
  installing: "Installing",
  not_installed: "Not installed",
  pending: "Pending",
  error: "Error",
  unknown: "Unknown",
};

const STATUS_STYLES = {
  installed:
    "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-400/60 dark:bg-emerald-500/10 dark:text-emerald-200",
  installing:
    "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-400/60 dark:bg-sky-500/10 dark:text-sky-200",
  not_installed:
    "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-400/60 dark:bg-amber-500/10 dark:text-amber-200",
  pending:
    "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-600/40 dark:bg-slate-700/10 dark:text-slate-200",
  error:
    "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-400/60 dark:bg-rose-500/10 dark:text-rose-200",
  unknown:
    "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-600/40 dark:bg-slate-800/30 dark:text-slate-200",
};

const NODE_LANGUAGES = new Set(["node"]);

function normalizeStatus(status) {
  if (!status) {
    return "unknown";
  }
  const normalized = String(status).toLowerCase();
  if (normalized === "not-installed") {
    return "not_installed";
  }
  if (STATUS_LABELS[normalized]) {
    return normalized;
  }
  return "unknown";
}

function formatTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleString();
}

export default function ScriptPackages({ script, onAuthError, onPackagesChange }) {
  const scriptId = script?.id || null;
  const language =
    typeof script?.language === "string" ? script.language.trim().toLowerCase() : "";
  const isNodeLanguage = NODE_LANGUAGES.has(language);
  const basePackageCount = Number(script?.packageCount) || 0;

  const [packages, setPackages] = useState(
    Array.isArray(script?.packages) ? script.packages : [],
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [checkError, setCheckError] = useState(script?.packageCheckError ?? null);
  const [isChecking, setIsChecking] = useState(false);
  const [installMissing, setInstallMissing] = useState(true);
  const [effectiveRunnerHostId, setEffectiveRunnerHostId] = useState(
    script?.packageRunnerHostId ||
      script?.runnerHostId ||
      (script?.inheritCategoryRunner ? script?.categoryDefaultRunnerHostId || null : null) ||
      null,
  );

  useEffect(() => {
    setPackages(Array.isArray(script?.packages) ? script.packages : []);
    setCheckError(script?.packageCheckError ?? null);
    setEffectiveRunnerHostId(
      script?.packageRunnerHostId ||
        script?.runnerHostId ||
        (script?.inheritCategoryRunner ? script?.categoryDefaultRunnerHostId || null : null) ||
        null,
    );
    setError("");
    setInstallMissing(true);
  }, [
    scriptId,
    script?.packages,
    script?.packageCheckError,
    script?.packageRunnerHostId,
    script?.runnerHostId,
    script?.inheritCategoryRunner,
    script?.categoryDefaultRunnerHostId,
  ]);

  const supportsPackages = useMemo(() => {
    if (!scriptId) return false;
    if (isNodeLanguage) return true;
    return basePackageCount > 0 || packages.length > 0;
  }, [scriptId, isNodeLanguage, basePackageCount, packages.length]);

  const sortedPackages = useMemo(() => {
    if (!Array.isArray(packages)) return [];
    return [...packages].sort((a, b) => {
      const left = (a?.name || "").toLowerCase();
      const right = (b?.name || "").toLowerCase();
      return left.localeCompare(right);
    });
  }, [packages]);

  const loadPackages = useCallback(
    async ({ cancelRef, silent = false } = {}) => {
      if (!scriptId) {
        if (!cancelRef?.current) {
          setPackages([]);
          setCheckError(null);
          setEffectiveRunnerHostId(
            script?.packageRunnerHostId ||
              script?.runnerHostId ||
              (script?.inheritCategoryRunner
                ? script?.categoryDefaultRunnerHostId || null
                : null) ||
              null,
          );
          setError("");
        }
        return;
      }

      if (!silent) {
        setIsLoading(true);
        setError("");
      }

      try {
        const response = await apiRequest(
          `/api/scripts/${encodeURIComponent(scriptId)}/packages`,
        );
        if (cancelRef?.current) return;
        const list = Array.isArray(response?.packages) ? response.packages : [];
        setPackages(list);
        const count = Number(response?.packageCount ?? list.length) || 0;
        const nextCheckError = response?.checkError || null;
        setCheckError(nextCheckError);
        setEffectiveRunnerHostId(response?.effectiveRunnerHostId || null);
        if (onPackagesChange) {
          onPackagesChange(scriptId, {
            packageCount: count,
            packageCheckError: nextCheckError,
            packages: list,
          });
        }
      } catch (err) {
        if (cancelRef?.current) return;
        if (err.status === 401 || err.status === 403) {
          onAuthError?.(err);
          return;
        }
        setError(
          err?.data?.error || err.message || "Failed to load package information.",
        );
      } finally {
        if (cancelRef?.current) return;
        if (!silent) {
          setIsLoading(false);
        }
      }
    },
    [
      scriptId,
      onAuthError,
      onPackagesChange,
      script?.packageRunnerHostId,
      script?.runnerHostId,
      script?.inheritCategoryRunner,
      script?.categoryDefaultRunnerHostId,
    ],
  );

  useEffect(() => {
    if (!supportsPackages) {
      return;
    }
    const cancelRef = { current: false };
    loadPackages({ cancelRef });
    return () => {
      cancelRef.current = true;
    };
  }, [supportsPackages, loadPackages]);

  const handleCheckPackages = useCallback(async () => {
    if (!scriptId) return;
    setIsChecking(true);
    setError("");
    try {
      const response = await apiRequest(
        `/api/scripts/${encodeURIComponent(scriptId)}/packages/check`,
        {
          method: "POST",
          body: { installMissing },
        },
      );
      const list = Array.isArray(response?.packages) ? response.packages : [];
      setPackages(list);
      const count = Number(response?.packageCount ?? list.length) || 0;
      const nextCheckError = response?.checkError || null;
      setCheckError(nextCheckError);
      setEffectiveRunnerHostId(response?.effectiveRunnerHostId || effectiveRunnerHostId || null);
      if (onPackagesChange) {
        onPackagesChange(scriptId, {
          packageCount: count,
          packageCheckError: nextCheckError,
          packages: list,
        });
      }
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        onAuthError?.(err);
      } else {
        setError(err?.data?.error || err.message || "Failed to check packages.");
      }
    } finally {
      setIsChecking(false);
    }
  }, [
    scriptId,
    installMissing,
    onAuthError,
    onPackagesChange,
    effectiveRunnerHostId,
  ]);

  const handleToggleInstallMissing = (event) => {
    setInstallMissing(event.target.checked);
  };

  if (!scriptId) {
    return (
      <div className="rounded border border-slate-300 bg-white/80 p-4 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300">
        Save this script before managing npm packages.
      </div>
    );
  }

  if (!supportsPackages) {
    return (
      <div className="rounded border border-slate-300 bg-white/80 p-4 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300">
        Package detection is only available for Node.js scripts.
      </div>
    );
  }

  const canCheckPackages = Boolean(effectiveRunnerHostId);
  const packageCount = sortedPackages.length;
  const summaryRunnerText = canCheckPackages
    ? effectiveRunnerHostId
    : "Not assigned";

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded border border-slate-200 bg-white/85 p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950/40 dark:shadow-none sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Detected npm packages
          </h3>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {packageCount === 0
              ? "No dependencies detected from the current script source yet."
              : `${packageCount} package${packageCount === 1 ? "" : "s"} detected in the script.`}
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Runner host:{" "}
            <span className="font-semibold text-slate-900 dark:text-slate-200">{summaryRunnerText}</span>
          </p>
          {!isNodeLanguage && (
            <p className="text-xs text-slate-500 dark:text-slate-500">
              Package data is read-only because this script uses the {language || "current"}
              {language ? " runtime." : " runtime."}
            </p>
          )}
        </div>
        <div className="flex flex-col items-start gap-3 sm:items-end">
          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 rounded border border-slate-300 bg-white text-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-400/70 dark:border-slate-600 dark:bg-slate-900 dark:text-sky-400 dark:focus:ring-sky-500/70"
              checked={installMissing}
              onChange={handleToggleInstallMissing}
              disabled={isChecking}
            />
            <span>Install missing packages during checks</span>
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => loadPackages({ silent: false })}
              disabled={isLoading || isChecking}
              className={`rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-700 transition dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-200 ${
                isLoading || isChecking
                  ? "cursor-not-allowed opacity-70"
                  : "hover:border-sky-500 hover:text-sky-600 dark:hover:text-sky-300"
              }`}
            >
              {isLoading ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              onClick={handleCheckPackages}
              disabled={!canCheckPackages || isChecking}
              className={`rounded border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition ${
                !canCheckPackages || isChecking
                  ? "cursor-not-allowed border-slate-300 text-slate-400 dark:border-slate-800 dark:text-slate-600"
                  : "border-sky-500 text-sky-600 hover:bg-sky-50 dark:text-sky-200 dark:hover:bg-sky-500/10"
              }`}
            >
              {isChecking ? "Checking…" : "Check packages"}
            </button>
          </div>
          {!canCheckPackages && (
            <p className="text-xs text-amber-600 dark:text-amber-300">
              Assign this script to a runner before checking packages.
            </p>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-400/40 dark:bg-rose-500/10 dark:text-rose-200">
          {error}
        </div>
      )}

      {checkError && !error && (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-400/40 dark:bg-amber-500/10 dark:text-amber-200">
          {checkError}
        </div>
      )}

      {isLoading && !sortedPackages.length ? (
        <div className="text-sm text-slate-600 dark:text-slate-400">Loading package status…</div>
      ) : sortedPackages.length ? (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-950/40">
          {sortedPackages.map((pkg) => {
            const statusKey = normalizeStatus(pkg?.status);
            const statusLabel = STATUS_LABELS[statusKey] || STATUS_LABELS.unknown;
            const statusStyle = STATUS_STYLES[statusKey] || STATUS_STYLES.unknown;
            const updatedAt = formatTimestamp(pkg?.updatedAt);
            return (
              <li
                key={pkg.name || statusLabel}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-1">
                  <div className="font-mono text-sm text-slate-900 dark:text-slate-100">{pkg.name}</div>
                  {updatedAt && (
                    <div className="text-xs text-slate-500 dark:text-slate-500">
                      Last updated {updatedAt}
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-start gap-1 sm:items-end">
                  <span
                    className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${statusStyle}`}
                  >
                    {statusLabel}
                  </span>
                  {pkg?.message && (
                    <span className="max-w-md text-left text-xs text-slate-600 dark:text-slate-400 sm:text-right">
                      {pkg.message}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rounded border border-slate-300 bg-white/80 p-4 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300">
          No npm packages detected yet. Update your script and check again.
        </div>
      )}
    </div>
  );
}
