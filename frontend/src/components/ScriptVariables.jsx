import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "../utils/api";
import { useNotificationDialog } from "./NotificationDialogProvider";

const SCRIPT_PREFIX = "AUTOMN_VAR_";
const COLLECTION_PREFIX = "AUTOMN_CAT_VAR_";
const CATEGORY_PREFIX = COLLECTION_PREFIX;
const GLOBAL_PREFIX = "AUTOMN_GLOBAL_VAR_";

const PANEL_STYLE = {
  borderColor: "var(--color-panel-border)",
  background: "var(--color-surface-1)",
};

const INPUT_CONTAINER_STYLE = {
  borderColor: "var(--color-input-border)",
  background: "var(--color-input-bg)",
  color: "var(--color-input-text)",
};

const PREFIX_SEGMENT_STYLE = {
  background: "var(--color-surface-2)",
  borderRight: "1px solid var(--color-input-border)",
  color: "var(--color-text-muted)",
};

const PRIMARY_BUTTON_STYLE = {
  background: "var(--color-accent)",
  color: "var(--color-app-bg)",
};

const SECONDARY_BUTTON_STYLE = {
  borderColor: "var(--color-border)",
  background: "var(--color-surface-2)",
  color: "var(--color-text-strong)",
};

function normalizeName(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

export default function ScriptVariables({
  script,
  onAuthError,
  onVariablesChange,
}) {
  const { confirm } = useNotificationDialog();
  const [scriptVariables, setScriptVariables] = useState([]);
  const [categoryVariables, setCategoryVariables] = useState([]);
  const [globalVariables, setGlobalVariables] = useState([]);
  const [jobVariables, setJobVariables] = useState([]);
  const [scriptPrefix, setScriptPrefix] = useState(SCRIPT_PREFIX);
  const [categoryPrefix, setCategoryPrefix] = useState(COLLECTION_PREFIX);
  const [globalPrefix, setGlobalPrefix] = useState(GLOBAL_PREFIX);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [nameInput, setNameInput] = useState("");
  const [valueInput, setValueInput] = useState("");
  const [isSecure, setIsSecure] = useState(false);
  const [valueDirty, setValueDirty] = useState(true);
  const [isFormVisible, setIsFormVisible] = useState(false);

  const normalizedName = useMemo(() => normalizeName(nameInput), [nameInput]);
  const handleResetForm = useCallback(() => {
    setEditingId(null);
    setNameInput("");
    setValueInput("");
    setIsSecure(false);
    setValueDirty(true);
    setFormError("");
  }, []);

  const loadVariables = useCallback(
    async ({ cancelRef, silent = false } = {}) => {
      const scriptId = script?.id;
      if (!scriptId) {
        if (!cancelRef?.current) {
          setScriptVariables([]);
          setCategoryVariables([]);
          setGlobalVariables([]);
          setJobVariables([]);
          setScriptPrefix(SCRIPT_PREFIX);
          setCategoryPrefix(COLLECTION_PREFIX);
          setGlobalPrefix(GLOBAL_PREFIX);
          if (onVariablesChange) {
            onVariablesChange(null, { variableCount: 0 });
          }
        }
        return;
      }

      if (!silent) {
        setIsLoading(true);
      }

      try {
        const data = await apiRequest(
          `/api/scripts/${encodeURIComponent(scriptId)}/variables`,
        );
        if (cancelRef?.current) return;
        const scriptList = Array.isArray(data?.scriptVariables)
          ? data.scriptVariables
          : Array.isArray(data?.variables)
          ? data.variables
          : [];
        const categoryList = Array.isArray(data?.collectionVariables)
          ? data.collectionVariables
          : Array.isArray(data?.categoryVariables)
          ? data.categoryVariables
          : [];
        const globalList = Array.isArray(data?.globalVariables)
          ? data.globalVariables
          : [];
        const jobList = Array.isArray(data?.jobVariables) ? data.jobVariables : [];

        setScriptVariables(scriptList);
        setCategoryVariables(categoryList);
        setGlobalVariables(globalList);
        setJobVariables(jobList);
        setScriptPrefix(data?.scriptPrefix || data?.prefix || SCRIPT_PREFIX);
        setCategoryPrefix(
          data?.collectionPrefix || data?.categoryPrefix || COLLECTION_PREFIX,
        );
        setGlobalPrefix(data?.globalPrefix || GLOBAL_PREFIX);
        if (onVariablesChange) {
          const counts = data?.counts || {};
          const totalCount =
            counts.total ?? scriptList.length + categoryList.length + globalList.length;
          onVariablesChange(scriptId, {
            variableCount: totalCount,
          });
        }
        setError("");
      } catch (err) {
        if (cancelRef?.current) return;
        if (err.status === 401 || err.status === 403) {
          onAuthError?.(err);
          return;
        }
        setError(
          err?.data?.error || err.message || "Failed to load variables.",
        );
      } finally {
        if (cancelRef?.current) return;
        if (!silent) {
          setIsLoading(false);
        }
      }
    },
    [script?.id, onAuthError, onVariablesChange],
  );

  useEffect(() => {
    const cancelRef = { current: false };
    loadVariables({ cancelRef });
    return () => {
      cancelRef.current = true;
    };
  }, [loadVariables]);

  useEffect(() => {
    handleResetForm();
    setError("");
    setFormError("");
    setIsFormVisible(false);
  }, [script?.id, handleResetForm]);

  const handleNameChange = (event) => {
    setNameInput(event.target.value);
    if (formError) setFormError("");
  };

  const handleValueChange = (event) => {
    setValueInput(event.target.value);
    setValueDirty(true);
    if (formError) setFormError("");
  };

  const handleSecureToggle = (event) => {
    setIsSecure(event.target.checked);
    if (formError) setFormError("");
  };

  const handleEdit = (variable) => {
    if (!variable) return;
    setEditingId(variable.id || null);
    setNameInput(variable.name || "");
    setIsSecure(Boolean(variable.isSecure));
    setValueInput(variable.isSecure ? "" : variable.value || "");
    setValueDirty(false);
    setFormError("");
    setIsFormVisible(true);
  };

  const handleDelete = async (variable) => {
    if (!script?.id || !variable?.id) return;
    const label = variable.name || variable.envName;
    const confirmed = await confirm({
      title: `Delete variable "${label}"?`,
      message: "This will remove the variable for the script.",
      tone: "danger",
      confirmLabel: "Delete variable",
    });
    if (!confirmed) return;

    setIsSaving(true);
    try {
      await apiRequest(
        `/api/scripts/${encodeURIComponent(script.id)}/variables/${encodeURIComponent(
          variable.id,
        )}`,
        { method: "DELETE" },
      );
      if (editingId === variable.id) {
        handleResetForm();
      }
      await loadVariables({ silent: true });
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        onAuthError?.(err);
      } else {
        setFormError(
          err?.data?.error || err.message || "Failed to delete variable.",
        );
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!script?.id || isSaving) return;

    const normalized = normalizeName(nameInput);
    if (!normalized) {
      setFormError("Variable name is required.");
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        name: nameInput,
        isSecure,
      };

      if (!editingId || valueDirty) {
        payload.value = valueInput;
      }

      const scriptId = encodeURIComponent(script.id);
      if (editingId) {
        await apiRequest(
          `/api/scripts/${scriptId}/variables/${encodeURIComponent(editingId)}`,
          {
            method: "PUT",
            body: payload,
          },
        );
      } else {
        await apiRequest(`/api/scripts/${scriptId}/variables`, {
          method: "POST",
          body: payload,
        });
      }

      setFormError("");
      await loadVariables({ silent: true });
      handleResetForm();
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        onAuthError?.(err);
      } else {
        setFormError(
          err?.data?.error || err.message || "Failed to save variable.",
        );
      }
    } finally {
      setIsSaving(false);
    }
  };

  if (!script?.id) {
    return (
      <div
        className="rounded border border-dashed p-6 text-sm"
        style={{
          ...PANEL_STYLE,
          color: "var(--color-text-muted)",
        }}
      >
        Save the script before configuring variables.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {!isFormVisible && !editingId && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setIsFormVisible(true)}
            className="rounded border px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-text-strong)] transition hover:bg-[color:var(--color-surface-3)]"
            style={SECONDARY_BUTTON_STYLE}
          >
            + Add variable
          </button>
        </div>
      )}

      {(isFormVisible || editingId) && (
        <div
          className="rounded border p-4"
          style={PANEL_STYLE}
        >
          <div className="flex items-start justify-between gap-4">
            <h3 className="text-sm font-semibold text-[color:var(--color-text-strong)]">
              {editingId ? "Edit variable" : "Add a new variable"}
            </h3>
            {!editingId && (
              <button
                type="button"
                onClick={() => {
                  handleResetForm();
                  setIsFormVisible(false);
                }}
                className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)] transition hover:text-[color:var(--color-text-strong)]"
              >
                Close
              </button>
            )}
          </div>
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
                  Name
                </label>
                <div
                  className="mt-1 flex overflow-hidden rounded border text-xs"
                  style={INPUT_CONTAINER_STYLE}
                >
                  <span
                    className="inline-flex items-center px-2 font-mono text-[11px]"
                    style={PREFIX_SEGMENT_STYLE}
                  >
                    {scriptPrefix}
                  </span>
                  <input
                    className="w-full bg-transparent px-2 py-1.5 font-mono text-[13px] focus:outline-none placeholder:text-[color:var(--color-input-placeholder)]"
                    style={{ color: "var(--color-input-text)" }}
                    value={nameInput}
                    onChange={handleNameChange}
                    autoComplete="off"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
                  Value
                </label>
                <input
                  className="mt-1 w-full rounded border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent-strong)] placeholder:text-[color:var(--color-input-placeholder)]"
                  style={INPUT_CONTAINER_STYLE}
                  value={valueInput}
                  onChange={handleValueChange}
                />
                {editingId && isSecure && !valueDirty && (
                  <p className="mt-1 text-[11px] text-[color:var(--color-text-muted)]">
                    Leave blank to keep the existing encrypted value.
                  </p>
                )}
              </div>
              <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border focus:ring-2 focus:ring-[color:var(--color-accent-strong)]"
                  style={{
                    borderColor: "var(--color-input-border)",
                    background: "var(--color-input-bg)",
                  }}
                  checked={isSecure}
                  onChange={handleSecureToggle}
                />
                Secured (encrypted & masked)
              </label>
            </div>
          {formError && (
            <div className="rounded border border-red-500/50 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {formError}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className="rounded px-4 py-1.5 text-sm font-semibold transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              style={PRIMARY_BUTTON_STYLE}
              disabled={isSaving || !normalizedName}
            >
              {editingId ? "Update variable" : "Add variable"}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={handleResetForm}
                className="rounded border px-4 py-1.5 text-sm font-semibold transition hover:bg-[color:var(--color-surface-3)] disabled:cursor-not-allowed disabled:opacity-60"
                style={SECONDARY_BUTTON_STYLE}
                disabled={isSaving}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>
      )}

      {error && (
        <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      {isLoading ? (
        <div
          className="rounded border px-4 py-6 text-center text-sm"
          style={{
            ...PANEL_STYLE,
            color: "var(--color-text-muted)",
          }}
        >
          Loading variables…
        </div>
      ) : scriptVariables.length === 0 ? (
        <div
          className="rounded border border-dashed px-4 py-6 text-center text-sm"
          style={{
            ...PANEL_STYLE,
            color: "var(--color-text-muted)",
          }}
        >
          No script variables configured yet. Add one above to expose it to your script.
        </div>
      ) : (
        <div
          className="overflow-hidden rounded border"
          style={PANEL_STYLE}
        >
          <table
            className="min-w-full divide-y divide-[color:var(--color-divider)] text-sm"
            style={{ borderColor: "var(--color-panel-border)" }}
          >
            <thead className="bg-[color:var(--color-surface-2)] text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">
              <tr>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Environment</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-left">Value</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody
              className="divide-y divide-[color:var(--color-divider)]"
              style={{
                background: "var(--color-surface-1)",
                borderColor: "var(--color-panel-border)",
              }}
            >
              {scriptVariables.map((variable) => (
                <tr key={variable.id || variable.envName}>
                  <td className="px-3 py-2 font-mono text-xs text-[color:var(--color-text-strong)]">
                    {variable.name || "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-[color:var(--color-accent)]">
                    {variable.envName}
                  </td>
                  <td className="px-3 py-2 text-[color:var(--color-text-muted)]">
                    {variable.isSecure ? "Secured" : "Plain"}
                  </td>
                  <td className="px-3 py-2 text-[color:var(--color-text-strong)]">
                    {variable.isSecure
                      ? variable.maskedValue || "Not set"
                      : variable.value || "Not set"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => handleEdit(variable)}
                        className="rounded border px-3 py-1 text-xs font-semibold transition hover:bg-[color:var(--color-surface-3)] disabled:cursor-not-allowed disabled:opacity-60"
                        style={SECONDARY_BUTTON_STYLE}
                        disabled={isSaving}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(variable)}
                        className="button-danger rounded border px-3 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={isSaving}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-[color:var(--color-text-strong)]">
          Collection variables
        </h4>
        <p className="text-xs text-[color:var(--color-text-muted)]">
          Variables inherited from the script&apos;s collection are read-only.
        </p>
        {categoryVariables.length === 0 ? (
          <div
            className="rounded border border-dashed px-4 py-4 text-center text-xs"
            style={{
              ...PANEL_STYLE,
              color: "var(--color-text-muted)",
            }}
          >
            No collection variables available.
          </div>
        ) : (
          <div className="overflow-hidden rounded border" style={PANEL_STYLE}>
            <table
              className="min-w-full divide-y divide-[color:var(--color-divider)] text-sm"
              style={{ borderColor: "var(--color-panel-border)" }}
            >
              <thead className="bg-[color:var(--color-surface-2)] text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">
                <tr>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Environment</th>
                  <th className="px-3 py-2 text-left">Type</th>
                  <th className="px-3 py-2 text-left">Value</th>
                </tr>
              </thead>
              <tbody
                className="divide-y divide-[color:var(--color-divider)]"
                style={{
                  background: "var(--color-surface-1)",
                  borderColor: "var(--color-panel-border)",
                }}
              >
                {categoryVariables.map((variable) => (
                  <tr key={variable.id || variable.envName}>
                    <td className="px-3 py-2 font-mono text-xs text-[color:var(--color-text-strong)]">
                      {variable.name || "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-[color:var(--color-accent)]">
                      {variable.envName}
                    </td>
                    <td className="px-3 py-2 text-[color:var(--color-text-muted)]">
                      {variable.isSecure ? "Secured" : "Plain"}
                    </td>
                    <td className="px-3 py-2 text-[color:var(--color-text-strong)]">
                      {variable.isSecure
                        ? variable.maskedValue || "Not set"
                        : variable.value || "Not set"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-[color:var(--color-text-strong)]">
          Global variables
        </h4>
        <p className="text-xs text-[color:var(--color-text-muted)]">
          Variables defined globally are available to every script and cannot be edited here.
        </p>
        {globalVariables.length === 0 ? (
          <div
            className="rounded border border-dashed px-4 py-4 text-center text-xs"
            style={{
              ...PANEL_STYLE,
              color: "var(--color-text-muted)",
            }}
          >
            No global variables available.
          </div>
        ) : (
          <div className="overflow-hidden rounded border" style={PANEL_STYLE}>
            <table
              className="min-w-full divide-y divide-[color:var(--color-divider)] text-sm"
              style={{ borderColor: "var(--color-panel-border)" }}
            >
              <thead className="bg-[color:var(--color-surface-2)] text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">
                <tr>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Environment</th>
                  <th className="px-3 py-2 text-left">Type</th>
                  <th className="px-3 py-2 text-left">Value</th>
                </tr>
              </thead>
              <tbody
                className="divide-y divide-[color:var(--color-divider)]"
                style={{
                  background: "var(--color-surface-1)",
                  borderColor: "var(--color-panel-border)",
                }}
              >
                {globalVariables.map((variable) => (
                  <tr key={variable.id || variable.envName}>
                    <td className="px-3 py-2 font-mono text-xs text-[color:var(--color-text-strong)]">
                      {variable.name || "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-[color:var(--color-accent)]">
                      {variable.envName}
                    </td>
                    <td className="px-3 py-2 text-[color:var(--color-text-muted)]">
                      {variable.isSecure ? "Secured" : "Plain"}
                    </td>
                    <td className="px-3 py-2 text-[color:var(--color-text-strong)]">
                      {variable.isSecure
                        ? variable.maskedValue || "Not set"
                        : variable.value || "Not set"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-[color:var(--color-text-strong)]">
          Job variables
        </h4>
        <p className="text-xs text-[color:var(--color-text-muted)]">
          These runtime variables are injected for every execution and reflect the current run context.
        </p>
        {jobVariables.length === 0 ? (
          <div
            className="rounded border border-dashed px-4 py-4 text-center text-xs"
            style={{
              ...PANEL_STYLE,
              color: "var(--color-text-muted)",
            }}
          >
            No job-level variables defined.
          </div>
        ) : (
          <div className="overflow-hidden rounded border" style={PANEL_STYLE}>
            <table
              className="min-w-full divide-y divide-[color:var(--color-divider)] text-sm"
              style={{ borderColor: "var(--color-panel-border)" }}
            >
              <thead className="bg-[color:var(--color-surface-2)] text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">
                <tr>
                  <th className="px-3 py-2 text-left">Environment</th>
                  <th className="px-3 py-2 text-left">Details</th>
                </tr>
              </thead>
              <tbody
                className="divide-y divide-[color:var(--color-divider)]"
                style={{
                  background: "var(--color-surface-1)",
                  borderColor: "var(--color-panel-border)",
                }}
              >
                {jobVariables.map((variable) => (
                  <tr key={variable.envName}>
                    <td className="px-3 py-2 font-mono text-xs text-[color:var(--color-accent)]">
                      {variable.envName}
                    </td>
                    <td className="px-3 py-2 text-xs text-[color:var(--color-text-strong)]">
                      <div className="font-semibold text-[color:var(--color-text-strong)]">
                        {variable.label || variable.envName}
                      </div>
                      <div className="text-[color:var(--color-text-muted)]">
                        {variable.description || "Provided at runtime."}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
