import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "../utils/api";
import { useNotificationDialog } from "./NotificationDialogProvider";
import CategoryVariablesManager from "./CategoryVariablesManager";

const DEFAULT_COLLECTION_ID = "category-general";
const DEFAULT_CATEGORY_ID = DEFAULT_COLLECTION_ID;

const LANGUAGE_OPTIONS = [
  { value: "", label: "No default" },
  { value: "node", label: "Node JS" },
  { value: "python", label: "Python" },
  { value: "powershell", label: "PowerShell" },
];

const normalizeCategory = (entry) => ({
  id: entry.id,
  name: entry.name || "",
  description: entry.description || "",
  defaultLanguage: entry.defaultLanguage || "",
  isSystem: Boolean(entry.isSystem),
  scriptCount: Number(entry.scriptCount) || 0,
  defaultRunnerHostId: entry.defaultRunnerHostId || "",
  defaultRunner: entry.defaultRunner || null,
});

const normalizePermission = (entry) => ({
  userId: entry.userId,
  username: entry.username,
  isAdmin: Boolean(entry.isAdmin),
  canRead: Boolean(entry.canRead),
  canWrite: Boolean(entry.canWrite),
  canDelete: Boolean(entry.canDelete),
  canRun: Boolean(entry.canRun),
  canClearLogs: Boolean(entry.canClearLogs),
});

const sortCategories = (items) => {
  return [...items].sort((a, b) => {
    if (a.isSystem && !b.isSystem) return -1;
    if (!a.isSystem && b.isSystem) return 1;
    return (a.name || "").localeCompare(b.name || "", undefined, {
      sensitivity: "base",
    });
  });
};

const sortUsersByName = (items) =>
  [...items].sort((a, b) =>
    (a.username || "").localeCompare(b.username || "", undefined, {
      sensitivity: "base",
    }),
  );

export default function SettingsCategories({ onAuthError, onCategoryChange }) {
  const { confirm } = useNotificationDialog();
  const [categories, setCategories] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const [createForm, setCreateForm] = useState({
    name: "",
    description: "",
    defaultLanguage: "",
    defaultRunnerHostId: "",
  });
  const [createError, setCreateError] = useState("");
  const [createStatus, setCreateStatus] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const [selectedCategoryId, setSelectedCategoryId] = useState(null);
  const [editForm, setEditForm] = useState({
    name: "",
    description: "",
    defaultLanguage: "",
    isSystem: false,
    defaultRunnerHostId: "",
  });
  const [editError, setEditError] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const [permissions, setPermissions] = useState([]);
  const [availableUsers, setAvailableUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [permissionsError, setPermissionsError] = useState("");
  const [permissionsStatus, setPermissionsStatus] = useState("");
  const [isLoadingPermissions, setIsLoadingPermissions] = useState(false);
  const [isSavingPermissions, setIsSavingPermissions] = useState(false);
  const [runnerOptions, setRunnerOptions] = useState([]);
  const [runnersLoaded, setRunnersLoaded] = useState(false);
  const [runnerError, setRunnerError] = useState("");

  const selectedCategory = useMemo(
    () => categories.find((category) => category.id === selectedCategoryId) || null,
    [categories, selectedCategoryId],
  );

  const mergedRunnerOptions = useMemo(() => {
    const entries = new Map(runnerOptions.map((runner) => [runner.id, runner]));
    if (selectedCategory?.defaultRunnerHostId && !entries.has(selectedCategory.defaultRunnerHostId)) {
      entries.set(selectedCategory.defaultRunnerHostId, {
        id: selectedCategory.defaultRunnerHostId,
        name:
          (selectedCategory.defaultRunner?.name || selectedCategory.defaultRunnerHostId),
        adminOnly: Boolean(selectedCategory.defaultRunner?.adminOnly),
        status: selectedCategory.defaultRunner?.status || "unknown",
        disabled: false,
      });
    }
    return Array.from(entries.values()).sort((a, b) =>
      (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }),
    );
  }, [
    runnerOptions,
    selectedCategory?.defaultRunnerHostId,
    selectedCategory?.defaultRunner?.name,
    selectedCategory?.defaultRunner?.adminOnly,
    selectedCategory?.defaultRunner?.status,
  ]);

  const notifyCategoryChange = useCallback(() => {
    if (typeof onCategoryChange === "function") {
      onCategoryChange();
    }
  }, [onCategoryChange]);

  const loadRunnerOptions = useCallback(async () => {
    setRunnerError("");
    setRunnersLoaded(false);
    try {
      const response = await apiRequest("/api/runners");
      const list = Array.isArray(response?.runnerHosts)
        ? response.runnerHosts
        : [];
      const normalized = list
        .map((runner) => ({
          id: runner.id,
          name: runner.name || runner.id,
          adminOnly: Boolean(runner.adminOnly),
          status: runner.status || "pending",
          disabled: Boolean(runner.disabledAt),
        }))
        .sort((a, b) =>
          (a.name || "").localeCompare(b.name || "", undefined, {
            sensitivity: "base",
          }),
        );
      setRunnerOptions(normalized);
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setRunnerError(err?.data?.error || err.message || "Failed to load runners");
      }
    } finally {
      setRunnersLoaded(true);
    }
  }, [onAuthError]);

  const loadCategories = async () => {
    setIsLoading(true);
    setError("");
    try {
      const response = await apiRequest("/api/collections");
      const list = Array.isArray(response?.collections)
        ? response.collections.map(normalizeCategory)
        : Array.isArray(response?.categories)
          ? response.categories.map(normalizeCategory)
          : [];
      const sorted = sortCategories(list);
      setCategories(sorted);

      if (sorted.length === 0) {
        setSelectedCategoryId(null);
      } else if (!sorted.some((category) => category.id === selectedCategoryId)) {
        setSelectedCategoryId(sorted[0].id);
      }
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setError(err?.data?.error || err.message || "Failed to load collections");
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadCategories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadRunnerOptions();
  }, [loadRunnerOptions]);

  useEffect(() => {
    if (!selectedCategory) {
      setEditForm({
        name: "",
        description: "",
        defaultLanguage: "",
        isSystem: false,
        defaultRunnerHostId: "",
      });
      setPermissions([]);
      setAvailableUsers([]);
      setPermissionsError("");
      setPermissionsStatus("");
      return;
    }

    setEditForm({
      name: selectedCategory.name,
      description: selectedCategory.description,
      defaultLanguage: selectedCategory.defaultLanguage || "",
      isSystem: selectedCategory.isSystem,
      defaultRunnerHostId: selectedCategory.defaultRunnerHostId || "",
    });
    setEditError("");
    setEditStatus("");
    if (selectedCategory.isSystem) {
      setPermissions([]);
      setAvailableUsers([]);
      setSelectedUserId("");
      setPermissionsError("");
      setPermissionsStatus("");
      setIsLoadingPermissions(false);
      return;
    }
    loadPermissionsForCategory(selectedCategory.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategoryId, categories]);

  const loadPermissionsForCategory = async (categoryId) => {
    if (!categoryId) {
      setPermissions([]);
      setAvailableUsers([]);
      return;
    }

    setIsLoadingPermissions(true);
    setPermissionsError("");
    setPermissionsStatus("");
    setSelectedUserId("");

    try {
      const payload = await apiRequest(`/api/collections/${categoryId}/permissions`);
      const normalizedPermissions = Array.isArray(payload?.permissions)
        ? sortUsersByName(payload.permissions.map(normalizePermission))
        : [];
      const normalizedUsers = Array.isArray(payload?.users)
        ? sortUsersByName(
          payload.users.map((user) => ({
            id: user.id,
            username: user.username,
            isAdmin: Boolean(user.isAdmin),
          })),
        )
        : [];

      setPermissions(normalizedPermissions);
      setAvailableUsers(
        normalizedUsers.filter(
          (user) => !normalizedPermissions.some((perm) => perm.userId === user.id),
        ),
      );
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setPermissionsError(
          err?.data?.error || err.message || "Failed to load collection permissions",
        );
      }
    } finally {
      setIsLoadingPermissions(false);
    }
  };

  const handleCreateCategory = async (event) => {
    event.preventDefault();
    if (isCreating) return;

    const name = createForm.name.trim();
    if (!name) {
      setCreateError("Collection name is required.");
      return;
    }

    setIsCreating(true);
    setCreateError("");
    setCreateStatus("");

    try {
      await apiRequest("/api/collections", {
        method: "POST",
        body: {
          name,
          description: createForm.description.trim(),
          defaultLanguage: createForm.defaultLanguage,
          defaultRunnerHostId: createForm.defaultRunnerHostId || null,
        },
      });

      setCreateStatus(`Category "${name}" created.`);
      setCreateForm({
        name: "",
        description: "",
        defaultLanguage: "",
        defaultRunnerHostId: "",
      });
      await loadCategories();
      notifyCategoryChange();
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setCreateError(err?.data?.error || err.message || "Failed to create collection");
      }
    } finally {
      setIsCreating(false);
    }
  };

  const handleCloseCreatePanel = () => {
    setIsCreateOpen(false);
    setCreateError("");
    setCreateStatus("");
    setCreateForm({
      name: "",
      description: "",
      defaultLanguage: "",
      defaultRunnerHostId: "",
    });
  };

  const handleUpdateCategory = async () => {
    if (!selectedCategory) return;
    if (editForm.isSystem) {
      setEditError("The default collection cannot be modified.");
      return;
    }

    const trimmedName = editForm.name.trim();
    if (!trimmedName) {
      setEditError("Collection name is required.");
      return;
    }

    setIsSavingEdit(true);
    setEditError("");
    setEditStatus("");

    try {
      await apiRequest(`/api/collections/${selectedCategory.id}`, {
        method: "PUT",
        body: {
          name: trimmedName,
          description: editForm.description.trim(),
          defaultLanguage: editForm.defaultLanguage,
          defaultRunnerHostId: editForm.defaultRunnerHostId || null,
        },
      });

      setEditStatus("Collection updated.");
      await loadCategories();
      notifyCategoryChange();
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setEditError(err?.data?.error || err.message || "Failed to update collection");
      }
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleDeleteCategory = async () => {
    if (!selectedCategory || selectedCategory.isSystem) return;
    if (isDeleting) return;

    const confirmed = await confirm({
      title: `Delete collection "${selectedCategory.name}"?`,
      message: "Scripts will be moved to General.",
      tone: "warn",
      confirmLabel: "Delete collection",
    });
    if (!confirmed) return;

    setIsDeleting(true);
    setEditError("");
    setEditStatus("");

    try {
      await apiRequest(`/api/collections/${selectedCategory.id}`, {
        method: "DELETE",
      });

      setSelectedCategoryId(null);
      await loadCategories();
      notifyCategoryChange();
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setEditError(err?.data?.error || err.message || "Failed to delete collection");
      }
    } finally {
      setIsDeleting(false);
    }
  };

  const handlePermissionToggle = (userId, field) => {
    if (selectedCategory?.isSystem) return;
    setPermissions((prev) =>
      sortUsersByName(
        prev.map((entry) => {
          if (entry.userId !== userId) return entry;
          const next = { ...entry };
          if (field === "canRead") {
            const nextValue = !next.canRead;
            next.canRead = nextValue;
            if (!nextValue) {
              next.canWrite = false;
              next.canDelete = false;
              next.canRun = false;
              next.canClearLogs = false;
            }
            return next;
          }

          const toggledValue = !next[field];
          next[field] = toggledValue;
          if (toggledValue) {
            next.canRead = true;
          }
          return next;
        }),
      ),
    );
  };

  const handlePermissionRemove = (userId) => {
    if (selectedCategory?.isSystem) return;
    setPermissions((prev) => prev.filter((entry) => entry.userId !== userId));
    const removed = permissions.find((entry) => entry.userId === userId);
    if (removed) {
      setAvailableUsers((prev) =>
        sortUsersByName([
          ...prev,
          {
            id: removed.userId,
            username: removed.username,
            isAdmin: removed.isAdmin,
          },
        ]).filter(
          (user, index, list) =>
            list.findIndex((candidate) => candidate.id === user.id) === index,
        ),
      );
    }
  };

  const handleAddPermissionUser = () => {
    if (!selectedUserId) return;
    if (selectedCategory?.isSystem) return;
    const user = availableUsers.find((candidate) => candidate.id === selectedUserId);
    if (!user) return;

    const nextPermission = normalizePermission({
      userId: user.id,
      username: user.username,
      isAdmin: Boolean(user.isAdmin),
      canRead: true,
      canWrite: false,
      canDelete: false,
      canRun: false,
      canClearLogs: false,
    });

    setPermissions((prev) => sortUsersByName([...prev, nextPermission]));
    setAvailableUsers((prev) => prev.filter((candidate) => candidate.id !== user.id));
    setSelectedUserId("");
  };

  const handleSavePermissions = async () => {
    if (!selectedCategoryId) return;
    if (isSavingPermissions) return;
    if (selectedCategory?.isSystem) return;

    setIsSavingPermissions(true);
    setPermissionsError("");
    setPermissionsStatus("");

    try {
      const payload = {
        permissions: permissions.map((entry) => ({
          userId: entry.userId,
          canRead: entry.canRead,
          canWrite: entry.canWrite,
          canDelete: entry.canDelete,
          canRun: entry.canRun,
          canClearLogs: entry.canClearLogs,
        })),
      };

      const response = await apiRequest(
        `/api/collections/${selectedCategoryId}/permissions`,
        {
          method: "POST",
          body: payload,
        },
      );

      const normalizedPermissions = Array.isArray(response?.permissions)
        ? sortUsersByName(response.permissions.map(normalizePermission))
        : [];
      setPermissions(normalizedPermissions);

      setAvailableUsers((prev) =>
        sortUsersByName(
          prev.filter(
            (user) => !normalizedPermissions.some((entry) => entry.userId === user.id),
          ),
        ),
      );

      setPermissionsStatus("Permissions updated.");
      notifyCategoryChange();
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setPermissionsError(
          err?.data?.error || err.message || "Failed to update collection permissions",
        );
      }
    } finally {
      setIsSavingPermissions(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Create collection</h2>
            <p className="text-sm text-slate-400">
              Group scripts into reusable categories and assign default permissions.
            </p>
          </div>
          {isCreateOpen ? (
            <button
              type="button"
              onClick={handleCloseCreatePanel}
              className="rounded border border-slate-700 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300 transition-colors hover:bg-slate-800"
            >
              Close
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setIsCreateOpen(true);
                setCreateError("");
                setCreateStatus("");
              }}
              className="rounded border border-slate-700 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300 transition-colors hover:bg-slate-800"
            >
              + Add collection
            </button>
          )}
        </div>
        {isCreateOpen && (
          <form
            onSubmit={handleCreateCategory}
            className="space-y-3 rounded border border-slate-800 bg-slate-900/40 p-4"
          >
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm text-slate-300">
                <span className="block text-slate-400">Name</span>
                <input
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70"
                  value={createForm.name}
                  onChange={(event) => {
                    setCreateForm((prev) => ({ ...prev, name: event.target.value }));
                    setCreateError("");
                    setCreateStatus("");
                  }}
                  placeholder="Operations"
                />
              </label>
              <label className="text-sm text-slate-300">
                <span className="block text-slate-400">Default language</span>
                <select
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70"
                  value={createForm.defaultLanguage}
                  onChange={(event) => {
                    setCreateForm((prev) => ({
                      ...prev,
                      defaultLanguage: event.target.value,
                    }));
                    setCreateError("");
                    setCreateStatus("");
                  }}
                >
                  {LANGUAGE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block text-sm text-slate-300">
              <span className="block text-slate-400">Description</span>
              <textarea
                className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70"
                rows={2}
                value={createForm.description}
                onChange={(event) => {
                  setCreateForm((prev) => ({ ...prev, description: event.target.value }));
                  setCreateError("");
                  setCreateStatus("");
                }}
                placeholder="Describe how this collection should be used"
              />
            </label>
            <label className="block text-sm text-slate-300">
              <span className="block text-slate-400">Default runner</span>
              {runnerError && (
                <span className="mt-1 block text-xs text-rose-300">{runnerError}</span>
              )}
              {runnersLoaded ? (
                runnerOptions.length > 0 ? (
                  <select
                    className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70"
                    value={createForm.defaultRunnerHostId}
                    onChange={(event) => {
                      setCreateForm((prev) => ({
                        ...prev,
                        defaultRunnerHostId: event.target.value,
                      }));
                      setCreateError("");
                      setCreateStatus("");
                    }}
                  >
                    <option value="">No default runner</option>
                    {runnerOptions.map((runner) => (
                      <option key={runner.id} value={runner.id}>
                        {runner.name}
                        {runner.adminOnly ? " (Admin only)" : ""}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="mt-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-400">
                    No runners available.
                  </div>
                )
              ) : (
                <div className="mt-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-400">
                  Loading runners…
                </div>
              )}
            </label>
            {createError && (
              <p className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                {createError}
              </p>
            )}
            {createStatus && (
              <p className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
                {createStatus}
              </p>
            )}
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={isCreating}
                className="rounded border border-sky-500/60 px-4 py-2 text-sm font-semibold uppercase tracking-wide text-sky-300 transition-colors hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isCreating ? "Creating…" : "Create collection"}
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Existing collections</h2>
            <p className="text-sm text-slate-400">
              Select a collection to view its settings and manage permissions.
            </p>
          </div>
          <button
            type="button"
            onClick={loadCategories}
            className="rounded border border-slate-700 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300 transition-colors hover:bg-slate-800/60"
            disabled={isLoading}
          >
            Refresh
          </button>
        </div>
        {error && (
          <p className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {error}
          </p>
        )}
        {isLoading ? (
          <p className="text-sm text-slate-400">Loading collections…</p>
        ) : categories.length === 0 ? (
          <p className="text-sm text-slate-400">No collections have been created yet.</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
            <aside className="space-y-2 rounded border border-slate-800 bg-slate-900/40 p-3">
              {categories.map((category) => {
                const isActive = category.id === selectedCategoryId;
                return (
                  <button
                    key={category.id}
                    type="button"
                    onClick={() => setSelectedCategoryId(category.id)}
                    className={`w-full rounded border px-3 py-2 text-left text-sm transition-colors ${isActive
                        ? "border-sky-500/60 bg-sky-500/10 text-sky-200"
                        : "border-transparent bg-slate-900 text-slate-300 hover:border-slate-700 hover:bg-slate-800"
                      }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{category.name || "Untitled"}</span>
                      {category.isSystem && (
                        <span className="rounded-full border border-slate-600 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-300">
                          Default
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-slate-400">
                      {category.scriptCount === 1
                        ? "1 script"
                        : `${category.scriptCount} scripts`}
                    </div>
                  </button>
                );
              })}
            </aside>

            {selectedCategory ? (
              selectedCategory.isSystem ? (
                <div className="space-y-4 rounded border border-slate-800 bg-slate-900/40 p-4">
                  <div className="space-y-2">
                    <h3 className="text-base font-semibold text-slate-100">
                      {selectedCategory.name || "General"}
                    </h3>
                    <p className="text-sm text-slate-300">
                      All users automatically have access to this collection. Its settings and permissions are managed by the system and cannot be modified.
                    </p>
                    {selectedCategory.description && (
                      <p className="text-sm text-slate-400">
                        {selectedCategory.description}
                      </p>
                    )}
                  </div>
                  <div className="grid gap-3 text-sm text-slate-300 sm:grid-cols-2">
                    <div className="rounded border border-slate-800 bg-slate-900/60 p-3">
                      <div className="text-xs uppercase tracking-wide text-slate-400">
                        Scripts
                      </div>
                      <div className="mt-1 text-slate-100">
                        {selectedCategory.scriptCount === 1
                          ? "1 script"
                          : `${selectedCategory.scriptCount} scripts`}
                      </div>
                    </div>
                    <div className="rounded border border-slate-800 bg-slate-900/60 p-3">
                      <div className="text-xs uppercase tracking-wide text-slate-400">
                        Default language
                      </div>
                      <div className="mt-1 text-slate-100">
                        {selectedCategory.defaultLanguage || "None"}
                      </div>
                    </div>
                    {selectedCategory.defaultRunnerHostId ? (
                      <div className="rounded border border-slate-800 bg-slate-900/60 p-3 sm:col-span-2">
                        <div className="text-xs uppercase tracking-wide text-slate-400">
                          Default runner
                        </div>
                        <div className="mt-1 text-slate-100">
                          {selectedCategory.defaultRunner?.name ||
                            selectedCategory.defaultRunnerHostId}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <CategoryVariablesManager
                    categoryId={selectedCategory.id}
                    categoryName={selectedCategory.name}
                    isEditable={false}
                    onAuthError={onAuthError}
                  />
                  <p className="text-xs text-slate-500">
                    User access to the General collection is granted automatically.
                  </p>
                </div>
              ) : (
                <div className="space-y-6 rounded border border-slate-800 bg-slate-900/40 p-4">
                  <div className="space-y-3">
                    <h3 className="text-base font-semibold text-slate-100">Edit collection</h3>
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="text-sm text-slate-300">
                        <span className="block text-slate-400">Name</span>
                        <input
                          className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70 disabled:opacity-60"
                          value={editForm.name}
                          onChange={(event) => {
                            setEditForm((prev) => ({
                              ...prev,
                              name: event.target.value,
                            }));
                            setEditError("");
                            setEditStatus("");
                          }}
                          disabled={editForm.isSystem || isSavingEdit}
                        />
                      </label>
                      <label className="text-sm text-slate-300">
                        <span className="block text-slate-400">Default language</span>
                        <select
                          className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70 disabled:opacity-60"
                          value={editForm.defaultLanguage}
                          onChange={(event) => {
                            setEditForm((prev) => ({
                              ...prev,
                              defaultLanguage: event.target.value,
                            }));
                            setEditError("");
                            setEditStatus("");
                          }}
                          disabled={editForm.isSystem || isSavingEdit}
                        >
                          {LANGUAGE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label className="block text-sm text-slate-300">
                      <span className="block text-slate-400">Description</span>
                      <textarea
                        className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70 disabled:opacity-60"
                        rows={3}
                        value={editForm.description}
                        onChange={(event) => {
                          setEditForm((prev) => ({
                            ...prev,
                            description: event.target.value,
                          }));
                          setEditError("");
                          setEditStatus("");
                        }}
                        disabled={isSavingEdit}
                      />
                    </label>
                    <label className="block text-sm text-slate-300">
                      <span className="block text-slate-400">Default runner</span>
                      {runnerError && (
                        <span className="mt-1 block text-xs text-rose-300">{runnerError}</span>
                      )}
                      {runnersLoaded ? (
                        mergedRunnerOptions.length > 0 ? (
                          <select
                            className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70 disabled:opacity-60"
                            value={editForm.defaultRunnerHostId}
                            onChange={(event) => {
                              setEditForm((prev) => ({
                                ...prev,
                                defaultRunnerHostId: event.target.value,
                              }));
                              setEditError("");
                              setEditStatus("");
                            }}
                            disabled={isSavingEdit || editForm.isSystem}
                          >
                            <option value="">No default runner</option>
                            {mergedRunnerOptions.map((runner) => (
                              <option key={runner.id} value={runner.id}>
                                {runner.name}
                                {runner.adminOnly ? " (Admin only)" : ""}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <div className="mt-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-400">
                            No runners available.
                          </div>
                        )
                      ) : (
                        <div className="mt-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-400">
                          Loading runners…
                        </div>
                      )}
                    </label>
                    {editError && (
                      <p className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                        {editError}
                      </p>
                    )}
                    {editStatus && (
                      <p className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
                        {editStatus}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={handleUpdateCategory}
                        disabled={isSavingEdit || editForm.isSystem}
                        className="rounded border border-sky-500/60 px-4 py-2 text-sm font-semibold uppercase tracking-wide text-sky-300 transition-colors hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isSavingEdit ? "Saving…" : "Save changes"}
                      </button>
                      <button
                        type="button"
                        onClick={handleDeleteCategory}
                        disabled={isDeleting || editForm.isSystem}
                        className="button-danger rounded border px-4 py-2 text-sm font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isDeleting ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>

                  <CategoryVariablesManager
                    categoryId={selectedCategory.id}
                    categoryName={selectedCategory.name}
                    isEditable
                    onAuthError={onAuthError}
                  />

                  <div className="space-y-3">
                    <h3 className="text-base font-semibold text-slate-100">User permissions</h3>
                    {permissionsError && (
                      <p className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                        {permissionsError}
                      </p>
                    )}
                    {permissionsStatus && (
                      <p className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
                        {permissionsStatus}
                      </p>
                    )}

                    {isLoadingPermissions ? (
                      <p className="text-sm text-slate-400">Loading permissions…</p>
                    ) : (
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <label className="text-sm font-semibold text-slate-200" htmlFor="collection-permission-select">
                            Add user
                          </label>
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <select
                              id="collection-permission-select"
                              value={selectedUserId}
                              onChange={(event) => setSelectedUserId(event.target.value)}
                              className="flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 disabled:opacity-60"
                              disabled={!availableUsers.length || isSavingPermissions}
                            >
                              <option value="">
                                {availableUsers.length
                                  ? "Select a user to add"
                                  : "All active users already have entries"}
                              </option>
                              {availableUsers.map((user) => (
                                <option key={user.id} value={user.id}>
                                  {user.username}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={handleAddPermissionUser}
                              disabled={!selectedUserId || isSavingPermissions}
                              className="rounded border border-sky-500/60 px-3 py-2 text-sm font-semibold uppercase tracking-wide text-sky-300 transition-colors hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Add
                            </button>
                          </div>
                        </div>

                        <div className="overflow-x-auto">
                          <table className="min-w-full divide-y divide-slate-800 text-sm">
                            <thead>
                              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                                <th className="px-3 py-2">User</th>
                                <th className="px-3 py-2">Read</th>
                                <th className="px-3 py-2">Write</th>
                                <th className="px-3 py-2">Delete</th>
                                <th className="px-3 py-2">Clear Logs</th>
                                <th className="px-3 py-2">Run</th>
                                <th className="px-3 py-2" aria-label="Actions" />
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                              {permissions.length ? (
                                permissions.map((entry) => (
                                  <tr key={entry.userId} className="text-slate-200">
                                    <td className="px-3 py-2">
                                      <div className="font-semibold">{entry.username}</div>
                                      {entry.isAdmin && (
                                        <div className="text-xs text-slate-400">Administrator</div>
                                      )}
                                    </td>
                                    {["canRead", "canWrite", "canDelete", "canClearLogs", "canRun"].map((field) => (
                                      <td key={field} className="px-3 py-2">
                                        <input
                                          type="checkbox"
                                          className="h-4 w-4 accent-sky-400"
                                          checked={Boolean(entry[field])}
                                          onChange={() => handlePermissionToggle(entry.userId, field)}
                                          disabled={isSavingPermissions}
                                        />
                                      </td>
                                    ))}
                                    <td className="px-3 py-2 text-right">
                                      <button
                                        type="button"
                                        onClick={() => handlePermissionRemove(entry.userId)}
                                        disabled={isSavingPermissions}
                                        className="rounded border border-rose-500/40 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-rose-200 transition-colors hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                                      >
                                        Remove
                                      </button>
                                    </td>
                                  </tr>
                                ))
                              ) : (
                                <tr>
                                  <td colSpan={6} className="px-3 py-4 text-center text-slate-400">
                                    No delegated users yet.
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>

                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={handleSavePermissions}
                            disabled={isSavingPermissions}
                            className="rounded border border-emerald-500/60 px-4 py-2 text-sm font-semibold uppercase tracking-wide text-emerald-200 transition-colors hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {isSavingPermissions ? "Saving…" : "Save permissions"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )
            ) : (
              <div className="rounded border border-dashed border-slate-800 bg-slate-900/40 p-6 text-center text-sm text-slate-400">
                Select a collection to manage its settings.
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
