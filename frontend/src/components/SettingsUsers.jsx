import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../utils/api";
import { useNotificationDialog } from "./NotificationDialogProvider";

const initialFormState = {
  username: "",
  password: "",
  confirmPassword: "",
  isAdmin: false,
  requirePasswordChange: true,
};

function formatTimestamp(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function SettingsUsers({ currentUser, onAuthError }) {
  const { confirm } = useNotificationDialog();
  const [users, setUsers] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState(initialFormState);
  const [formError, setFormError] = useState("");
  const [formSuccess, setFormSuccess] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const updateUserInState = (updatedUser) => {
    if (!updatedUser) return;
    setUsers((prev) =>
      prev
        .map((item) => (item.id === updatedUser.id ? updatedUser : item))
        .sort((a, b) => (a.username || "").localeCompare(b.username || "")),
    );
  };

  const loadUsers = async () => {
    setIsLoading(true);
    setError("");
    try {
      const data = await apiRequest("/api/users");
      const list = Array.isArray(data?.users) ? data.users : [];
      list.sort((a, b) => (a.username || "").localeCompare(b.username || ""));
      setUsers(list);
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setError(err?.data?.error || err.message || "Failed to load users");
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const resetForm = () => {
    setForm(initialFormState);
    setFormError("");
    setFormSuccess("");
  };

  const handleCloseCreatePanel = () => {
    resetForm();
    setIsCreateOpen(false);
  };

  const handleInputChange = (event) => {
    const { name, value, type, checked } = event.target;
    setForm((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value,
    }));
    if (formError) setFormError("");
    if (formSuccess) setFormSuccess("");
  };

  const handleCreateUser = async (event) => {
    event.preventDefault();
    if (isSubmitting) return;

    const username = form.username.trim();
    if (!username) {
      setFormError("Username is required.");
      return;
    }

    if (!form.password || form.password.length < 8) {
      setFormError("Password must be at least 8 characters long.");
      return;
    }

    if (form.password !== form.confirmPassword) {
      setFormError("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);
    setFormError("");
    setFormSuccess("");

    try {
      const response = await apiRequest("/api/users", {
        method: "POST",
        body: {
          username,
          password: form.password,
          isAdmin: form.isAdmin,
          requirePasswordChange: form.requirePasswordChange,
        },
      });

      const createdUser = response?.user;
      if (createdUser) {
        setUsers((prev) => {
          const next = [...prev.filter((user) => user.id !== createdUser.id), createdUser];
          next.sort((a, b) => (a.username || "").localeCompare(b.username || ""));
          return next;
        });
      }

      setFormSuccess(`User "${username}" created.`);
      setForm(initialFormState);
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setFormError(err?.data?.error || err.message || "Failed to create user");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleActive = async (user) => {
    const nextActive = !user.isActive;
    try {
      setError("");
      const response = await apiRequest(`/api/users/${user.id}`, {
        method: "PATCH",
        body: { isActive: nextActive },
      });
      const updated = response?.user;
      if (updated) {
        updateUserInState(updated);
      }
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setError(err?.data?.error || err.message || "Failed to update user");
      }
    }
  };

  const handleRequireReset = async (user) => {
    try {
      setError("");
      const response = await apiRequest(`/api/users/${user.id}`, {
        method: "PATCH",
        body: { mustChangePassword: true },
      });
      const updated = response?.user;
      if (updated) {
        updateUserInState(updated);
      }
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setError(
          err?.data?.error || err.message || "Failed to require password change",
        );
      }
    }
  };

  const handleChangeRole = async (user, makeAdmin) => {
    try {
      setError("");
      const response = await apiRequest(`/api/users/${user.id}`, {
        method: "PATCH",
        body: { isAdmin: makeAdmin },
      });
      const updated = response?.user;
      if (updated) {
        updateUserInState(updated);
      }
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setError(err?.data?.error || err.message || "Failed to change user role");
      }
    }
  };

  const handleRenameUser = async (user) => {
    const proposed = window.prompt(
      `Rename "${user.username}" to:`,
      user.username || "",
    );
    if (proposed === null) return;

    const nextUsername = proposed.trim();
    if (!nextUsername) {
      setError("Username is required.");
      return;
    }

    if (nextUsername === user.username) {
      return;
    }

    try {
      setError("");
      const response = await apiRequest(`/api/users/${user.id}`, {
        method: "PATCH",
        body: { username: nextUsername },
      });
      const updated = response?.user;
      if (updated) {
        updateUserInState(updated);
      }
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setError(err?.data?.error || err.message || "Failed to rename user");
      }
    }
  };

  const handleDeleteUser = async (user) => {
    const confirmed = await confirm({
      title: `Delete user "${user.username}"?`,
      message: "This action cannot be undone.",
      tone: "danger",
      confirmLabel: "Delete user",
    });
    if (!confirmed) return;

    try {
      setError("");
      await apiRequest(`/api/users/${user.id}`, { method: "DELETE" });
      setUsers((prev) =>
        prev
          .filter((item) => item.id !== user.id)
          .sort((a, b) => (a.username || "").localeCompare(b.username || "")),
      );
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setError(err?.data?.error || err.message || "Failed to delete user");
      }
    }
  };

  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => (a.username || "").localeCompare(b.username || ""));
  }, [users]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-100">User management</h3>
          <p className="mt-1 text-sm text-slate-400">
            Create new accounts and control access to Automn.
          </p>
        </div>
        {isCreateOpen ? (
          <button
            type="button"
            onClick={handleCloseCreatePanel}
            className="rounded border border-slate-700 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300 transition hover:bg-slate-800"
          >
            Close
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              resetForm();
              setIsCreateOpen(true);
            }}
            className="rounded border border-slate-700 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300 transition hover:bg-slate-800"
          >
            + Add user
          </button>
        )}
      </div>

      {isCreateOpen && (
        <form
          onSubmit={handleCreateUser}
          className="space-y-4 rounded border border-slate-800 bg-slate-900/40 p-4"
        >
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-sm font-medium text-slate-200">
              Username
              <input
                className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70"
                name="username"
                value={form.username}
                onChange={handleInputChange}
                autoComplete="off"
                required
              />
            </label>
            <label className="text-sm font-medium text-slate-200">
              Password
              <input
                type="password"
                className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70"
                name="password"
                value={form.password}
                onChange={handleInputChange}
                autoComplete="new-password"
                required
              />
            </label>
            <label className="text-sm font-medium text-slate-200">
              Confirm password
              <input
                type="password"
                className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70"
                name="confirmPassword"
                value={form.confirmPassword}
                onChange={handleInputChange}
                autoComplete="new-password"
                required
              />
            </label>
            <div className="flex flex-col justify-center gap-3 rounded border border-slate-800 bg-slate-900/40 p-3 text-sm text-slate-200">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="isAdmin"
                  checked={form.isAdmin}
                  onChange={handleInputChange}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-sky-500 focus:ring-sky-500"
                />
                <span>Grant administrator access</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="requirePasswordChange"
                  checked={form.requirePasswordChange}
                  onChange={handleInputChange}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-sky-500 focus:ring-sky-500"
                />
                <span>Require password change on first login</span>
              </label>
            </div>
          </div>

          {formError && <p className="text-sm text-red-400">{formError}</p>}
          {formSuccess && <p className="text-sm text-emerald-400">{formSuccess}</p>}

          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded border border-sky-500/60 bg-sky-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-sky-300 transition disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? "Creating..." : "Create user"}
            </button>
            <button
              type="button"
              onClick={resetForm}
              disabled={isSubmitting}
              className="rounded border border-slate-700 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed"
            >
              Reset
            </button>
          </div>
        </form>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Existing users
          </h4>
          <button
            type="button"
            onClick={loadUsers}
            disabled={isLoading}
            className="rounded border border-slate-700 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed"
          >
            {isLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="overflow-hidden rounded border border-slate-800">
          <table className="min-w-full divide-y divide-slate-800 text-sm">
            <thead className="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left">Username</th>
                <th className="px-4 py-2 text-left">Role</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Last login</th>
                <th className="px-4 py-2" aria-label="actions" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 bg-slate-900/30 text-slate-200">
              {sortedUsers.map((user) => {
                const isCurrent = currentUser?.id === user.id;
                return (
                  <tr key={user.id} className={user.isActive ? "" : "opacity-70"}>
                    <td className="px-4 py-2 font-medium text-slate-100">{user.username}</td>
                  <td className="px-4 py-2 text-slate-300">
                    {user.isAdmin ? "Administrator" : "User"}
                  </td>
                  <td className="px-4 py-2">
                    <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                          user.isActive
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-slate-700/60 text-slate-300"
                        }`}
                      >
                        {user.isActive ? "Active" : "Disabled"}
                      </span>
                      {user.mustChangePassword && (
                        <span className="ml-2 inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-200">
                          Change password
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-slate-400">
                      {formatTimestamp(user.lastLogin)}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleRenameUser(user)}
                          className="rounded border border-slate-700 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-200 transition hover:bg-slate-800"
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          onClick={() => handleChangeRole(user, !user.isAdmin)}
                          className="rounded border border-slate-700 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-200 transition hover:bg-slate-800"
                        >
                          {user.isAdmin ? "Make user" : "Make admin"}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleActive(user)}
                          className="rounded border border-slate-700 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-200 transition hover:bg-slate-800"
                        >
                          {user.isActive ? "Disable" : "Enable"}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRequireReset(user)}
                          className="rounded border border-amber-500/50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-200 transition hover:bg-amber-500/10"
                          disabled={user.mustChangePassword}
                        >
                          Require reset
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteUser(user)}
                          disabled={isCurrent}
                          className="button-danger rounded border px-3 py-1 text-xs font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Delete
                        </button>
                        {isCurrent && (
                          <span className="text-[11px] uppercase tracking-wide text-slate-500">
                            (You)
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!sortedUsers.length && !isLoading && (
                <tr>
                  <td
                    className="px-4 py-6 text-center text-sm text-slate-400"
                    colSpan={5}
                  >
                    No users found.
                  </td>
                </tr>
              )}
              {isLoading && (
                <tr>
                  <td
                    className="px-4 py-6 text-center text-sm text-slate-400"
                    colSpan={5}
                  >
                    Loading users…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
