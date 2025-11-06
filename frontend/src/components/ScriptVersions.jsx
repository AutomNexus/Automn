import { useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { apiRequest } from "../utils/api";

const mapLanguageToMonaco = (language) => {
  switch (language) {
    case "node":
      return "javascript";
    case "python":
      return "python";
    case "powershell":
      return "powershell";
    default:
      return "javascript";
  }
};

const normalizeVersionSummary = (entry) => {
  if (!entry) return null;
  const createdAt = entry.createdAt || entry.created_at || null;
  return {
    version: entry.version,
    createdAt,
    created_at: createdAt,
    createdByUserId:
      entry.createdByUserId ||
      entry.created_by_user_id ||
      entry.updatedByUserId ||
      entry.updated_by_user_id ||
      null,
    createdByUsername:
      entry.createdByUsername ||
      entry.created_by_username ||
      entry.updatedByUsername ||
      entry.updated_by_username ||
      "",
  };
};

const normalizeVersionDetail = (entry) => {
  if (!entry) return null;
  const summary = normalizeVersionSummary(entry);
  return {
    ...summary,
    code: entry.code || "",
  };
};

export default function ScriptVersions({ script, onAuthError }) {
  const [versions, setVersions] = useState([]);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [versionsError, setVersionsError] = useState("");
  const [selectedVersion, setSelectedVersion] = useState(null);
  const [activeVersion, setActiveVersion] = useState(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [diffError, setDiffError] = useState("");
  const activeVersionRef = useRef(null);

  const monacoLanguage = useMemo(
    () => mapLanguageToMonaco(script?.language),
    [script?.language]
  );

  useEffect(() => {
    let isCancelled = false;

    const initialize = async () => {
      if (!script?.id) {
        setVersions([]);
        setSelectedVersion(null);
        setActiveVersion(null);
        activeVersionRef.current = null;
        setVersionsError("");
        setDiffError("");
        setIsLoadingDiff(false);
        return;
      }

      setIsLoadingVersions(true);
      setVersionsError("");
      setSelectedVersion(null);
      setActiveVersion(null);
      activeVersionRef.current = null;
      setDiffError("");
      setIsLoadingDiff(false);

      try {
        const data = await apiRequest(`/api/scripts/${script.id}/versions`);
        if (!isCancelled) {
          setVersions(
            Array.isArray(data)
              ? data.map(normalizeVersionSummary).filter(Boolean)
              : [],
          );
        }
      } catch (err) {
        if (!isCancelled) {
          if (onAuthError && (err.status === 401 || err.status === 403)) {
            onAuthError(err);
          } else {
            console.error(err);
            setVersionsError(
              err?.data?.error || err.message || "Failed to load versions",
            );
          }
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingVersions(false);
        }
      }
    };

    initialize();

    return () => {
      isCancelled = true;
    };
  }, [script?.id, onAuthError]);

  const handleToggleVersion = async (versionNumber) => {
    if (!script?.id || versionNumber == null) return;
    if (activeVersion === versionNumber) {
      setActiveVersion(null);
      activeVersionRef.current = null;
      setSelectedVersion(null);
      setDiffError("");
      setIsLoadingDiff(false);
      return;
    }

    const currentScriptId = script.id;
    activeVersionRef.current = versionNumber;
    setActiveVersion(versionNumber);
    setIsLoadingDiff(true);
    setDiffError("");
    setSelectedVersion(null);

    try {
      const body = await apiRequest(
        `/api/scripts/${currentScriptId}/versions/${versionNumber}`,
      );

      if (script?.id !== currentScriptId) {
        return;
      }

      if (activeVersionRef.current === versionNumber) {
        setSelectedVersion(normalizeVersionDetail(body));
      }
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        console.error(err);
      }
      if (script?.id === currentScriptId && activeVersionRef.current === versionNumber) {
        setDiffError(
          err?.data?.error || err.message || "Failed to load version",
        );
        setSelectedVersion(null);
      }
    } finally {
      if (script?.id === currentScriptId && activeVersionRef.current === versionNumber) {
        setIsLoadingDiff(false);
      }
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sky-400 font-semibold mb-2">Version History</h3>
        {isLoadingVersions && (
          <p className="text-sm text-slate-400">Loading versions…</p>
        )}
        {versionsError && (
          <p className="text-sm text-red-400">{versionsError}</p>
        )}
        {!isLoadingVersions && !versions.length && !versionsError && (
          <p className="text-gray-500">No previous versions.</p>
        )}
        <ul className="space-y-2">
          {versions.map((v) => {
            const isSelected = activeVersion === v.version;
            const createdAt = v.createdAt || v.created_at;
            const createdByLabel = v.createdByUsername || "Unknown";

            return (
              <li
                key={v.version}
                className={`border rounded p-3 transition-colors ${
                  isSelected
                    ? "border-sky-500 bg-slate-800/60"
                    : "border-slate-800 bg-slate-900/40 hover:bg-slate-800/40"
                }`}
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-mono text-sm text-slate-200">
                      v{v.version}
                    </p>
                    <p className="text-xs text-slate-400">
                      {createdAt ? new Date(createdAt).toLocaleString() : "Unknown time"}
                    </p>
                    <p className="text-xs text-slate-500">
                      Created by {createdByLabel}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleToggleVersion(v.version)}
                      disabled={isLoadingDiff && !isSelected}
                      className={`rounded border px-3 py-1 text-xs font-semibold uppercase tracking-wide transition-colors ${
                        isSelected
                          ? "border-sky-400 text-sky-300"
                          : "border-sky-400/60 text-sky-300 hover:bg-sky-500/10"
                      } ${
                        isLoadingDiff && !isSelected
                          ? "opacity-60 cursor-not-allowed"
                          : ""
                      }`}
                    >
                      {isSelected ? "Hide Diff" : "View diff"}
                    </button>
                    <button className="rounded border border-emerald-500/50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-200 transition-colors hover:bg-emerald-500/10">
                      Restore
                    </button>
                  </div>
                </div>
                {isSelected && (
                  <div className="mt-3 overflow-hidden rounded border border-slate-800 bg-slate-900/40">
                    <div className="border-b border-slate-800 px-3 py-2">
                      <h4 className="text-sm font-semibold text-slate-200">
                        {`Comparing v${v.version} to current`}
                      </h4>
                      <p className="text-xs text-slate-500">
                        Created by {selectedVersion?.createdByUsername || "Unknown"}
                      </p>
                      {diffError && (
                        <p className="text-xs text-red-400">{diffError}</p>
                      )}
                      {isLoadingDiff && activeVersion === v.version && (
                        <p className="text-xs text-slate-400">Loading diff…</p>
                      )}
                    </div>
                    <div className="h-[420px]">
                      {diffError ? (
                        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-red-300">
                          <p>Failed to load diff. Please try again.</p>
                        </div>
                      ) : selectedVersion?.version === v.version ? (
                        <DiffEditor
                          key={selectedVersion.version}
                          original={selectedVersion.code || ""}
                          modified={script?.code || ""}
                          language={monacoLanguage}
                          theme="vs-dark"
                          options={{
                            readOnly: true,
                            renderSideBySide: true,
                            fontSize: 13,
                            minimap: { enabled: false },
                            automaticLayout: true,
                          }}
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-400">
                          <p>Loading diff…</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
