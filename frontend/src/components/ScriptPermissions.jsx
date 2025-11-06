import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../utils/api";

function sortByUsername(items) {
  return [...items].sort((a, b) =>
    (a.username || "").localeCompare(b.username || "", undefined, {
      sensitivity: "base",
    }),
  );
}

function normalizePermission(entry) {
  if (!entry) {
    return null;
  }

  return {
    userId: entry.userId,
    username: entry.username,
    isAdmin: Boolean(entry.isAdmin),
    canRead: Boolean(entry.canRead),
    canWrite: Boolean(entry.canWrite),
    canDelete: Boolean(entry.canDelete),
    canRun: Boolean(entry.canRun),
    canClearLogs: Boolean(entry.canClearLogs),
  };
}

export default function ScriptPermissions({
  script,
  onAuthError,
  onSecurityChange,
  renderApiSection,
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [permissions, setPermissions] = useState([]);
  const [availableUsers, setAvailableUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [scriptInfo, setScriptInfo] = useState(null);
  const [requireAuth, setRequireAuth] = useState(true);
  const [inheritFromCategory, setInheritFromCategory] = useState(true);
  const [categoryInfo, setCategoryInfo] = useState(null);
  const [includeAutomnResponse, setIncludeAutomnResponse] = useState(false);
  const [includeRunId, setIncludeRunId] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const loadPermissions = async () => {
      if (!script?.id) {
        setPermissions([]);
        setAvailableUsers([]);
        setScriptInfo(null);
        setError("");
        setSaveStatus("");
        setSelectedUserId("");
        setRequireAuth(true);
        setInheritFromCategory(true);
        setCategoryInfo(null);
        setIncludeAutomnResponse(false);
        setIncludeRunId(true);
        return;
      }

      setIsLoading(true);
      setError("");
      setSaveStatus("");
      setSelectedUserId("");

      try {
        const payload = await apiRequest(`/api/scripts/${script.id}/permissions`);
        if (cancelled) return;

        const normalizedPermissions = Array.isArray(payload?.permissions)
          ? sortByUsername(payload.permissions.map(normalizePermission).filter(Boolean))
          : [];

        const normalizedUsers = Array.isArray(payload?.users)
          ? sortByUsername(
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
        setScriptInfo(payload?.script || null);
        const requiresAuth = payload?.script?.requireAuthentication;
        setRequireAuth(requiresAuth === undefined ? true : Boolean(requiresAuth));
        const inherits = payload?.script?.inheritCategoryPermissions;
        setInheritFromCategory(
          inherits === undefined ? true : Boolean(inherits),
        );
        const includeAutomn = payload?.script?.includeAutomnResponseData;
        setIncludeAutomnResponse(
          includeAutomn === undefined ? false : Boolean(includeAutomn),
        );
        const includeRunIdValue = payload?.script?.includeRunIdInResponse;
        setIncludeRunId(
          includeRunIdValue === undefined ? true : Boolean(includeRunIdValue),
        );
        setCategoryInfo(payload?.category || null);
      } catch (err) {
        if (cancelled) return;
        if (onAuthError && (err.status === 401 || err.status === 403)) {
          onAuthError(err);
          return;
        }
        console.error("Failed to load script permissions", err);
        setError(err?.data?.error || err.message || "Failed to load permissions");
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    loadPermissions();

    return () => {
      cancelled = true;
    };
  }, [script?.id, onAuthError]);

  const canModify = useMemo(
    () => Boolean(script?.permissions?.manage),
    [script?.permissions?.manage],
  );

  const handleRequireAuthChange = (event) => {
    setRequireAuth(event.target.checked);
    setSaveStatus("");
  };

  const handleInheritChange = (event) => {
    setInheritFromCategory(event.target.checked);
    setSaveStatus("");
  };

  const handleIncludeAutomnChange = (event) => {
    setIncludeAutomnResponse(event.target.checked);
    setSaveStatus("");
  };

  const handleIncludeRunIdChange = (event) => {
    setIncludeRunId(event.target.checked);
    setSaveStatus("");
  };

  useEffect(() => {
    if (!canModify) {
      setSaveStatus("");
    }
  }, [canModify]);

  const handleToggle = (userId, field) => {
    if (inheritFromCategory) return;
    setPermissions((prev) =>
      sortByUsername(
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

  const handleRemove = (userId) => {
    if (inheritFromCategory) return;
    setPermissions((prev) => prev.filter((entry) => entry.userId !== userId));
    const removedUsers = permissions
      .filter((entry) => entry.userId === userId)
      .map((entry) => ({
        id: entry.userId,
        username: entry.username,
        isAdmin: entry.isAdmin,
      }));
    setAvailableUsers((prev) =>
      sortByUsername([
        ...prev,
        ...removedUsers,
      ]).filter(
        (user, index, list) =>
          list.findIndex((candidate) => candidate.id === user.id) === index,
      ),
    );
  };

  const handleAddUser = () => {
    if (inheritFromCategory) return;
    if (!selectedUserId) return;
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

    setPermissions((prev) => sortByUsername([...prev, nextPermission]));
    setAvailableUsers((prev) => prev.filter((candidate) => candidate.id !== user.id));
    setSelectedUserId("");
  };

  const handleSave = async () => {
    if (!script?.id) return;
    setIsSaving(true);
    setSaveStatus("");
    setError("");

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
        requireAuthentication: Boolean(requireAuth),
        inheritCategoryPermissions: Boolean(inheritFromCategory),
        includeAutomnResponseData: Boolean(includeAutomnResponse),
        includeRunIdInResponse: Boolean(includeRunId),
      };

      const response = await apiRequest(`/api/scripts/${script.id}/permissions`, {
        method: "POST",
        body: payload,
      });

      const normalizedPermissions = Array.isArray(response?.permissions)
        ? sortByUsername(response.permissions.map(normalizePermission).filter(Boolean))
        : [];

      setPermissions(normalizedPermissions);
      setAvailableUsers((prev) =>
        sortByUsername(
          prev.filter(
            (candidate) =>
              !normalizedPermissions.some((entry) => entry.userId === candidate.id),
          ),
        ),
      );
      const nextRequireAuth =
        typeof response?.script?.requireAuthentication === "boolean"
          ? response.script.requireAuthentication
          : Boolean(requireAuth);
      setRequireAuth(nextRequireAuth);
      const nextInherit =
        typeof response?.script?.inheritCategoryPermissions === "boolean"
          ? response.script.inheritCategoryPermissions
          : inheritFromCategory;
      setInheritFromCategory(Boolean(nextInherit));
      const nextIncludeAutomn =
        typeof response?.script?.includeAutomnResponseData === "boolean"
          ? response.script.includeAutomnResponseData
          : includeAutomnResponse;
      setIncludeAutomnResponse(Boolean(nextIncludeAutomn));
      const nextIncludeRunId =
        typeof response?.script?.includeRunIdInResponse === "boolean"
          ? response.script.includeRunIdInResponse
          : includeRunId;
      setIncludeRunId(Boolean(nextIncludeRunId));
      setScriptInfo(response?.script || scriptInfo);
      onSecurityChange?.(script.id, {
        requireAuthentication: nextRequireAuth,
        inheritCategoryPermissions: Boolean(nextInherit),
        includeAutomnResponseData: Boolean(nextIncludeAutomn),
        includeRunIdInResponse: Boolean(nextIncludeRunId),
        acceptedMethods: Array.isArray(response?.script?.acceptedMethods)
          ? response.script.acceptedMethods
          : scriptInfo?.acceptedMethods,
      });
      setSaveStatus("Security settings updated");
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
        return;
      }
      console.error("Failed to update script security settings", err);
      setError(
        err?.data?.error || err.message || "Failed to update security settings",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const creatorLabel =
    scriptInfo?.createdByUsername ||
    script?.createdByUsername ||
    scriptInfo?.ownerUsername ||
    script?.ownerUsername ||
    "";

  const apiSectionContent = renderApiSection
    ? renderApiSection({
        requireAuth,
        isSaving,
        isLoading,
        script,
        canModify,
      })
    : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1 text-sm text-slate-300">
        <p>
          Manage which users can access this script and what actions they may perform.
        </p>
        {creatorLabel ? (
          <p className="text-slate-400">
            Created by {" "}
            <span className="font-semibold text-slate-200">{creatorLabel}</span>
          </p>
        ) : null}
      </div>

      {error && <p className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p>}
      {saveStatus && !error && (
        <p className="rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-200">
          {saveStatus}
        </p>
      )}

      {isLoading ? (
        <p className="text-sm text-slate-400">Loading security settings…</p>
      ) : canModify ? (
        <div className="space-y-6">
          <section className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold uppercase tracking-wide text-slate-200">
                API access
              </h2>
              <p className="text-sm text-slate-400">
                Control how external requests interact with this script.
              </p>
            </div>
            <div className="space-y-4 rounded border border-slate-800 bg-slate-900/40 p-4">
              <label className="flex items-start gap-3 text-sm text-slate-200">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 flex-shrink-0 accent-sky-400"
                  checked={requireAuth}
                  onChange={handleRequireAuthChange}
                  disabled={isSaving}
                />
                <div>
                  <div className="font-semibold text-slate-100">
                    Require authentication for this endpoint
                  </div>
                  <p className="mt-1 text-xs text-slate-400">
                    When enabled, requests must be authenticated with a signed-in user or this script&apos;s API token. Disable
                    this to allow public access without credentials.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 text-sm text-slate-200">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 flex-shrink-0 accent-sky-400"
                  checked={includeAutomnResponse}
                  onChange={handleIncludeAutomnChange}
                  disabled={isSaving}
                />
                <div>
                  <div className="font-semibold text-slate-100">
                    Include Automn metadata in responses
                  </div>
                  <p className="mt-1 text-xs text-slate-400">
                    Adds stdout, stderr, notifications, and timing details to responses alongside the script return value.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 text-sm text-slate-200">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 flex-shrink-0 accent-sky-400"
                  checked={includeRunId}
                  onChange={handleIncludeRunIdChange}
                  disabled={isSaving}
                />
                <div>
                  <div className="font-semibold text-slate-100">
                    Include run ID in responses
                  </div>
                  <p className="mt-1 text-xs text-slate-400">
                    Shares the run identifier so clients can stream logs or reference the execution later. This applies even when
                    metadata is hidden.
                  </p>
                </div>
              </label>

              {apiSectionContent ? (
                <div className="space-y-3">
                  {!requireAuth && (
                    <p className="text-xs text-slate-400">
                      API tokens are disabled while authentication is turned off.
                    </p>
                  )}
                  <div
                    className={`rounded border border-slate-800 bg-slate-950/40 p-4 transition ${
                      requireAuth ? "" : "pointer-events-none opacity-50"
                    }`}
                    aria-disabled={!requireAuth}
                  >
                    {apiSectionContent}
                  </div>
                </div>
              ) : null}
            </div>
          </section>

          <section className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold uppercase tracking-wide text-slate-200">
                User permissions
              </h2>
              <p className="text-sm text-slate-400">
                Decide which Automn users can view, run, or administer this script.
              </p>
            </div>
            <div className="space-y-4 rounded border border-slate-800 bg-slate-900/40 p-4">
              <div className="space-y-2">
                <label className="flex items-start gap-3 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 flex-shrink-0 accent-sky-400"
                    checked={inheritFromCategory}
                    onChange={handleInheritChange}
                    disabled={isSaving}
                  />
                  <div>
                    <div className="font-semibold text-slate-100">
                      Use parent collection permissions
                    </div>
                    <p className="mt-1 text-xs text-slate-400">
                      {categoryInfo?.name
                        ? `Permissions inherit from the “${categoryInfo.name}” collection.`
                        : "Permissions inherit from the parent collection."}{" "}
                      Disable this option to assign script-specific access rules.
                    </p>
                  </div>
                </label>
                {inheritFromCategory && (
                  <p className="text-xs text-slate-400">
                    Script-specific permissions are disabled while inheritance is enabled.
                  </p>
                )}
              </div>

              <div
                className={
                  inheritFromCategory ? "pointer-events-none opacity-60 space-y-4" : "space-y-4"
                }
              >
                <div className="space-y-2">
                  <label className="text-sm font-semibold text-slate-200" htmlFor="permission-user-select">
                    Add user
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <select
                      id="permission-user-select"
                      value={selectedUserId}
                      onChange={(event) => setSelectedUserId(event.target.value)}
                      className="flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 disabled:opacity-60"
                      disabled={!availableUsers.length || isSaving || inheritFromCategory}
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
                    onClick={handleAddUser}
                    disabled={!selectedUserId || isSaving || inheritFromCategory}
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
                                onChange={() => handleToggle(entry.userId, field)}
                                disabled={isSaving || inheritFromCategory}
                              />
                            </td>
                          ))}
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              onClick={() => handleRemove(entry.userId)}
                              disabled={isSaving || inheritFromCategory}
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
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={isSaving}
                  className="rounded border border-emerald-500/60 px-4 py-2 text-sm font-semibold uppercase tracking-wide text-emerald-200 transition-colors hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSaving ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : (
        <p className="text-sm text-slate-400">
          You do not have permission to update script security settings.
        </p>
      )}

    </div>
  );
}
