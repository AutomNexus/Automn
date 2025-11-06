import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "../utils/api";
import { useNotificationDialog } from "./NotificationDialogProvider";

const COLLECTION_PREFIX = "AUTOMN_CAT_VAR_";
const CATEGORY_PREFIX = COLLECTION_PREFIX;

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

export default function CategoryVariablesManager({
  categoryId,
  categoryName,
  isEditable,
  onAuthError,
}) {
  const { confirm } = useNotificationDialog();
  const [variables, setVariables] = useState([]);
  const [prefix, setPrefix] = useState(CATEGORY_PREFIX);
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
  const canEdit = Boolean(isEditable);

  const handleResetForm = useCallback(() => {
    setEditingId(null);
    setNameInput("");
    setValueInput("");
    setIsSecure(false);
    setValueDirty(true);
    setFormError("");
  }, []);

  const loadVariables = useCallback(async () => {
    if (!categoryId) {
      setVariables([]);
      setPrefix(COLLECTION_PREFIX);
      setError("");
      return;
    }

    setIsLoading(true);
    setError("");
    try {
      const data = await apiRequest(
        `/api/collections/${encodeURIComponent(categoryId)}/variables`,
      );
      const list = Array.isArray(data?.variables) ? data.variables : [];
      setVariables(list);
      setPrefix(
        data?.collectionPrefix || data?.prefix || COLLECTION_PREFIX,
      );
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        onAuthError?.(err);
      } else {
        setError(err?.data?.error || err.message || "Failed to load variables.");
      }
    } finally {
      setIsLoading(false);
    }
  }, [categoryId, onAuthError]);

  useEffect(() => {
    loadVariables();
  }, [loadVariables]);

  useEffect(() => {
    handleResetForm();
    setFormError("");
    setIsFormVisible(false);
  }, [categoryId, canEdit, handleResetForm]);

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
    if (!canEdit || !variable) return;
    setEditingId(variable.id || null);
    setNameInput(variable.name || "");
    setIsSecure(Boolean(variable.isSecure));
    setValueInput(variable.isSecure ? "" : variable.value || "");
    setValueDirty(false);
    setFormError("");
    setIsFormVisible(true);
  };

  const handleDelete = async (variable) => {
    if (!canEdit || !variable?.id || !categoryId) return;
    const label = variable.name || variable.envName;
    const confirmed = await confirm({
      title: `Delete variable "${label}"?`,
      message: "This will remove the variable from this collection.",
      tone: "danger",
      confirmLabel: "Delete variable",
    });
    if (!confirmed) return;

    setIsSaving(true);
    try {
      await apiRequest(
        `/api/collections/${encodeURIComponent(categoryId)}/variables/${encodeURIComponent(variable.id)}`,
        { method: "DELETE" },
      );
      if (editingId === variable.id) {
        handleResetForm();
      }
      await loadVariables();
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        onAuthError?.(err);
      } else {
        setFormError(err?.data?.error || err.message || "Failed to delete variable.");
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canEdit || isSaving || !categoryId) return;

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

      if (editingId) {
        await apiRequest(
          `/api/collections/${encodeURIComponent(categoryId)}/variables/${encodeURIComponent(editingId)}`,
          { method: "PUT", body: payload },
        );
      } else {
        await apiRequest(`/api/collections/${encodeURIComponent(categoryId)}/variables`, {
          method: "POST",
          body: payload,
        });
      }

      setFormError("");
      await loadVariables();
      handleResetForm();
      setIsFormVisible(false);
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        onAuthError?.(err);
      } else {
        setFormError(err?.data?.error || err.message || "Failed to save variable.");
      }
    } finally {
      setIsSaving(false);
    }
  };

  const headingLabel = categoryName
    ? `Variables for ${categoryName}`
    : "Collection variables";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-[color:var(--color-text-strong)]">
            {headingLabel}
          </h4>
          <p className="text-xs text-[color:var(--color-text-muted)]">
            {canEdit
              ? "Variables defined here are available to every script in this collection."
              : "Variables are available to scripts in this collection. Editing is disabled."}
          </p>
        </div>
        {canEdit && !isFormVisible && !editingId && (
          <button
            type="button"
            onClick={() => setIsFormVisible(true)}
            className="rounded border px-3 py-1 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-strong)] transition hover:bg-[color:var(--color-surface-3)]"
            style={SECONDARY_BUTTON_STYLE}
          >
            + Add variable
          </button>
        )}
      </div>

      {canEdit && (isFormVisible || editingId) && (
        <div className="rounded border p-4" style={PANEL_STYLE}>
          <div className="flex items-start justify-between gap-4">
            <h5 className="text-sm font-semibold text-[color:var(--color-text-strong)]">
              {editingId ? "Edit variable" : "Add a new variable"}
            </h5>
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
                    {prefix}
                  </span>
                  <input
                    className="flex-1 bg-transparent px-2 py-1 font-mono text-[11px] text-[color:var(--color-text-strong)] focus:outline-none"
                    value={nameInput}
                    onChange={handleNameChange}
                  />
                </div>
                <p className="mt-1 text-[11px] text-[color:var(--color-text-muted)]">
                  Normalized: {normalizedName ? `${prefix}${normalizedName}` : "—"}
                </p>
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
                  Value
                </label>
                <textarea
                  rows={isSecure ? 3 : 2}
                  className="mt-1 w-full rounded border border-[color:var(--color-input-border)] bg-[color:var(--color-input-bg)] px-3 py-2 text-xs text-[color:var(--color-input-text)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
                  value={valueInput}
                  onChange={handleValueChange}
                  placeholder={isSecure ? "Enter secret value" : "Enter value"}
                />
                <label className="mt-2 inline-flex items-center gap-2 text-xs text-[color:var(--color-text-muted)]">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[color:var(--color-accent)]"
                    checked={isSecure}
                    onChange={handleSecureToggle}
                  />
                  Store securely (value hidden from UI)
                </label>
              </div>
            </div>
            {formError && (
              <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {formError}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
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
      ) : variables.length === 0 ? (
        <div
          className="rounded border border-dashed px-4 py-6 text-center text-sm"
          style={{
            ...PANEL_STYLE,
            color: "var(--color-text-muted)",
          }}
        >
          No variables defined for this collection yet.
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
                {canEdit && <th className="px-3 py-2 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody
              className="divide-y divide-[color:var(--color-divider)]"
              style={{
                background: "var(--color-surface-1)",
                borderColor: "var(--color-panel-border)",
              }}
            >
              {variables.map((variable) => (
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
                  {canEdit && (
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
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
