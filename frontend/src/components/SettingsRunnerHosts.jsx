import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../utils/api";
import { useNotificationDialog } from "./NotificationDialogProvider";

const initialFormState = {
  id: "",
  name: "",
  secret: "",
  adminOnly: false,
};

const initialEditState = {
  name: "",
  adminOnly: false,
};

const STATUS_BADGES = {
  emerald: "border-emerald-500/60 bg-emerald-500/10 text-emerald-200",
  rose: "border-rose-500/60 bg-rose-500/10 text-rose-200",
  amber: "border-amber-500/60 bg-amber-500/10 text-amber-200",
  orange:
    "border-orange-300 bg-orange-100 text-orange-700 dark:border-orange-500/60 dark:bg-orange-500/10 dark:text-orange-200",
  slate: "border-slate-700 bg-slate-800/70 text-slate-200",
};

const createImageIcon = (src, alt) => ({ type: "image", src, alt });
const createEmojiIcon = (label) => ({ type: "emoji", label });

const RUNTIME_ICON_RULES = [
  {
    test: (value) => value.includes("node"),
    icon: createImageIcon("/nodejs.svg", "Node.js"),
  },
  {
    test: (value) => value.includes("javascript"),
    icon: createImageIcon("/nodejs.svg", "JavaScript"),
  },
  {
    test: (value) => value.includes("typescript"),
    icon: createImageIcon("/nodejs.svg", "TypeScript"),
  },
  {
    test: (value) => value.includes("python"),
    icon: createImageIcon("/python.svg", "Python"),
  },
  {
    test: (value) => value.includes("powershell") || value.includes("pwsh"),
    icon: createImageIcon("/powershell.svg", "PowerShell"),
  },
];

const DEFAULT_RUNTIME_ICON = createEmojiIcon("⚙️");

const getRuntimeIcon = (runtimeName) => {
  if (!runtimeName) {
    return DEFAULT_RUNTIME_ICON;
  }

  const normalized = String(runtimeName).trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_RUNTIME_ICON;
  }

  for (const { test, icon } of RUNTIME_ICON_RULES) {
    try {
      if (test(normalized)) {
        return icon;
      }
    } catch {
      // Ignore individual matcher failures and continue through the list.
    }
  }

  return DEFAULT_RUNTIME_ICON;
};

const renderRuntimeIcon = (
  icon,
  { imageClassName = "h-6 w-6", emojiClassName = "text-lg", ariaHidden = true } = {},
) => {
  if (!icon) return null;

  if (icon.type === "image") {
    return (
      <img
        src={icon.src}
        alt={icon.alt || ""}
        aria-hidden={ariaHidden}
        className={imageClassName}
      />
    );
  }

  return (
    <span aria-hidden={ariaHidden} className={emojiClassName}>
      {icon.label}
    </span>
  );
};

const RUNTIME_CARD_STYLE = {
  background: "var(--color-surface-1)",
  border: "1px solid var(--color-panel-border)",
};

const RUNTIME_ICON_STYLE = {
  background: "var(--color-surface-2)",
  border: "1px solid var(--color-panel-border)",
};

const OS_ICON_RULES = [
  {
    test: (value) => value.includes("win"),
    icon: createImageIcon("/os-icons/windows.png", "Windows"),
    label: "Windows",
  },
  {
    test: (value) => value.includes("mac") || value.includes("darwin"),
    icon: createImageIcon("/os-icons/apple.png", "macOS"),
    label: "macOS",
  },
  {
    test: (value) => value.includes("linux"),
    icon: createImageIcon("/os-icons/linux.png", "Linux"),
    label: "Linux",
  },
];

const DEFAULT_OS_INDICATOR = {
  icon: createEmojiIcon("🖥️"),
  label: "Unknown",
};

const extractOsCandidates = (host) => {
  if (!host || typeof host !== "object") {
    return [];
  }

  const rawValues = [host.runnerOs, host.runnerPlatform];
  return rawValues
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
};

const getOsIndicator = (host) => {
  const candidates = extractOsCandidates(host);
  for (const raw of candidates) {
    const normalized = raw.toLowerCase();
    for (const rule of OS_ICON_RULES) {
      try {
        if (rule.test(normalized)) {
          return { icon: rule.icon, label: rule.label };
        }
      } catch {
        // Ignore matcher errors and continue checking the next rule.
      }
    }
  }

  if (candidates.length > 0) {
    return { icon: DEFAULT_OS_INDICATOR.icon, label: candidates[0] };
  }

  return DEFAULT_OS_INDICATOR;
};

const RUNTIME_DISPLAY_NAMES = {
  node: "Node.js",
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  powershell: "PowerShell",
  pwsh: "PowerShell",
};

const formatRuntimeName = (value) => {
  if (!value && value !== 0) {
    return "";
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return "";
  }
  const lookupKey = trimmed.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(RUNTIME_DISPLAY_NAMES, lookupKey)) {
    return RUNTIME_DISPLAY_NAMES[lookupKey];
  }
  return trimmed;
};

const normalizeRuntimeVersion = (value) => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || "—";
  }
  if (value === null || value === undefined) {
    return "—";
  }
  const stringValue = String(value).trim();
  return stringValue || "—";
};

function formatTimestamp(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function classifyStatus(host) {
  if (!host) {
    return { label: "Unknown", tone: "slate" };
  }

  if (host.status === "disabled" || host.disabledAt) {
    return { label: "Disabled", tone: "rose" };
  }

  if (host.isHealthy) {
    return { label: "Healthy", tone: "emerald" };
  }

  if (host.status === "pending") {
    return { label: "Pending", tone: "amber" };
  }

  if (host.status === "healthy" && host.isStale) {
    return { label: "Offline", tone: "orange" };
  }

  const statusLabel = host.status
    ? host.status.charAt(0).toUpperCase() + host.status.slice(1)
    : "Unknown";
  return { label: statusLabel, tone: "slate" };
}

export default function SettingsRunnerHosts({ onAuthError }) {
  const { confirm } = useNotificationDialog();
  const [hosts, setHosts] = useState([]);
  const [heartbeatWindowMs, setHeartbeatWindowMs] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState(initialFormState);
  const [formError, setFormError] = useState("");
  const [formSuccess, setFormSuccess] = useState("");
  const [generatedSecret, setGeneratedSecret] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [disablingHostId, setDisablingHostId] = useState("");
  const [enablingHostId, setEnablingHostId] = useState("");
  const [deletingHostId, setDeletingHostId] = useState("");
  const [editingHostId, setEditingHostId] = useState("");
  const [editForm, setEditForm] = useState(initialEditState);
  const [editError, setEditError] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [rotatingHostId, setRotatingHostId] = useState("");
  const [disconnectingHostId, setDisconnectingHostId] = useState("");
  const [hostNotices, setHostNotices] = useState({});
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [expandedHosts, setExpandedHosts] = useState({});

  const expandHost = (hostId) => {
    if (!hostId) return;
    setExpandedHosts((prev) => {
      if (prev[hostId]) return prev;
      return { ...prev, [hostId]: true };
    });
  };

  const toggleHostExpansion = (hostId) => {
    if (!hostId) return;
    setExpandedHosts((prev) => {
      const next = { ...prev };
      if (next[hostId]) {
        delete next[hostId];
      } else {
        next[hostId] = true;
      }
      return next;
    });
  };

  const sortedHosts = useMemo(() => {
    return [...hosts].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [hosts]);

  const updateHostList = (updated) => {
    if (!updated?.id) return;
    setHosts((prev) => {
      const next = prev.filter((item) => item.id !== updated.id);
      next.push(updated);
      next.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      return next;
    });
  };

  const setHostNotice = (hostId, notice) => {
    if (!hostId) return;
    if (notice) {
      expandHost(hostId);
    }
    setHostNotices((prev) => {
      const next = { ...prev };
      if (!notice) {
        delete next[hostId];
      } else {
        next[hostId] = notice;
      }
      return next;
    });
  };

  const loadRunnerHosts = async () => {
    setIsLoading(true);
    setError("");
    try {
      const data = await apiRequest("/api/settings/runner-hosts");
      const list = Array.isArray(data?.runnerHosts) ? data.runnerHosts : [];
      setHosts(list);
      setExpandedHosts((prev) => {
        if (!prev || typeof prev !== "object") return {};
        const next = {};
        for (const host of list) {
          if (host?.id && prev[host.id]) {
            next[host.id] = true;
          }
        }
        return next;
      });
      if (Number.isFinite(Number(data?.heartbeatWindowMs))) {
        setHeartbeatWindowMs(Number(data.heartbeatWindowMs));
      }
      setHostNotices((prev) => {
        if (!prev || typeof prev !== "object") return {};
        const next = {};
        for (const host of list) {
          if (prev[host.id]) {
            next[host.id] = prev[host.id];
          }
        }
        return next;
      });
      if (editingHostId && !list.some((host) => host.id === editingHostId)) {
        setEditingHostId("");
        setEditForm(initialEditState);
        setEditError("");
      }
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setError(err?.data?.error || err.message || "Failed to load runner hosts");
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadRunnerHosts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleInputChange = (event) => {
    const { name, value, type, checked } = event.target;
    const nextValue = type === "checkbox" ? Boolean(checked) : value;
    setForm((prev) => ({
      ...prev,
      [name]: nextValue,
    }));
    if (formError) setFormError("");
    if (formSuccess) setFormSuccess("");
    if (generatedSecret) setGeneratedSecret("");
  };

  const handleCreateRunner = async (event) => {
    event.preventDefault();
    if (isSubmitting) return;

    const name = form.name.trim();
    if (!name) {
      setFormError("Runner name is required.");
      return;
    }

    const providedSecret = form.secret.trim();
    if (providedSecret && providedSecret.length < 12) {
      setFormError("Secret must be at least 12 characters long.");
      return;
    }

    const requestedId = form.id.trim();

    setIsSubmitting(true);
    setFormError("");
    setFormSuccess("");
    setGeneratedSecret("");

    try {
      const response = await apiRequest("/api/settings/runner-hosts", {
        method: "POST",
        body: {
          id: requestedId || undefined,
          name,
          secret: providedSecret || undefined,
          adminOnly: form.adminOnly,
        },
      });

      const created = response?.runnerHost;
      if (created) {
        setHosts((prev) => {
          const next = prev.filter((host) => host.id !== created.id);
          next.push(created);
          next.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
          return next;
        });
      }

      const returnedSecret = response?.secret || providedSecret;
      if (returnedSecret) {
        setGeneratedSecret(returnedSecret);
      }

      setFormSuccess(`Runner "${name}" created.`);
      setForm(initialFormState);
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setFormError(err?.data?.error || err.message || "Failed to create runner");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCloseCreatePanel = () => {
    setIsCreateOpen(false);
    setForm(initialFormState);
    setFormError("");
    setFormSuccess("");
    setGeneratedSecret("");
  };

  const handleEditFieldChange = (event) => {
    const { name, value, type, checked } = event.target;
    const nextValue = type === "checkbox" ? Boolean(checked) : value;
    setEditForm((prev) => ({
      ...prev,
      [name]: nextValue,
    }));
    if (editError) setEditError("");
  };

  const beginEditingHost = (host) => {
    if (!host?.id) return;
    expandHost(host.id);
    setEditingHostId(host.id);
    setEditForm({
      name: host.name || "",
      adminOnly: Boolean(host.adminOnly),
    });
    setEditError("");
  };

  const cancelEditingHost = () => {
    setEditingHostId("");
    setEditForm(initialEditState);
    setEditError("");
  };

  const handleSaveHost = async (event) => {
    event.preventDefault();
    if (!editingHostId || isSavingEdit) return;

    const trimmedName = (editForm.name || "").trim();
    if (!trimmedName) {
      setEditError("Runner name is required.");
      return;
    }

    setIsSavingEdit(true);
    try {
      const response = await apiRequest(`/api/settings/runner-hosts/${editingHostId}`, {
        method: "PATCH",
        body: {
          name: trimmedName,
          adminOnly: Boolean(editForm.adminOnly),
        },
      });
      const updated = response?.runnerHost;
      if (updated) {
        updateHostList(updated);
        setHostNotice(updated.id, {
          type: "success",
          message: "Runner details updated.",
        });
      }
      setEditingHostId("");
      setEditForm(initialEditState);
      setEditError("");
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setEditError(err?.data?.error || err.message || "Failed to update runner host.");
      }
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleDisableRunner = async (host) => {
    if (!host?.id) return;
    const confirmed = await confirm({
      title: `Disable runner "${host.name || host.id}"?`,
      message:
        "Active jobs will finish, but new jobs will not be dispatched.",
      tone: "warn",
      confirmLabel: "Disable runner",
    });
    if (!confirmed) return;

    setDisablingHostId(host.id);
    setError("");
    setHostNotice(host.id, null);
    try {
      const response = await apiRequest(`/api/settings/runner-hosts/${host.id}/disable`, {
        method: "POST",
      });
      const updated = response?.runnerHost;
      if (updated) {
        updateHostList(updated);
      }
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setError(err?.data?.error || err.message || "Failed to disable runner");
      }
    } finally {
      setDisablingHostId("");
    }
  };

  const handleEnableRunner = async (host) => {
    if (!host?.id) return;
    const confirmed = await confirm({
      title: `Enable runner "${host.name || host.id}"?`,
      message:
        "The runner will begin accepting jobs after it registers again.",
      tone: "info",
      confirmLabel: "Enable runner",
    });
    if (!confirmed) return;

    setEnablingHostId(host.id);
    setError("");
    setHostNotice(host.id, null);
    try {
      const response = await apiRequest(`/api/settings/runner-hosts/${host.id}/enable`, {
        method: "POST",
      });
      const updated = response?.runnerHost;
      if (updated) {
        updateHostList(updated);
      }
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setError(err?.data?.error || err.message || "Failed to enable runner");
      }
    } finally {
      setEnablingHostId("");
    }
  };

  const handleDeleteRunner = async (host) => {
    if (!host?.id) return;
    const confirmed = await confirm({
      title: `Delete runner "${host.name || host.id}"?`,
      message: "This action cannot be undone.",
      tone: "danger",
      confirmLabel: "Delete runner",
    });
    if (!confirmed) return;

    setDeletingHostId(host.id);
    try {
      await apiRequest(`/api/settings/runner-hosts/${host.id}`, {
        method: "DELETE",
      });
      setHosts((prev) => prev.filter((item) => item.id !== host.id));
      setHostNotices((prev) => {
        if (!prev[host.id]) return prev;
        const next = { ...prev };
        delete next[host.id];
        return next;
      });
      if (editingHostId === host.id) {
        cancelEditingHost();
      }
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setError(err?.data?.error || err.message || "Failed to delete runner");
      }
    } finally {
      setDeletingHostId("");
    }
  };

  const handleRotateSecret = async (host) => {
    if (!host?.id) return;
    const confirmed = await confirm({
      title: `Rotate token for "${host.name || host.id}"?`,
      message:
        "The current runner will disconnect until it is updated with the new secret.",
      tone: "warn",
      confirmLabel: "Rotate token",
    });
    if (!confirmed) return;

    setRotatingHostId(host.id);
    setHostNotice(host.id, null);
    try {
      const response = await apiRequest(`/api/settings/runner-hosts/${host.id}/rotate-secret`, {
        method: "POST",
      });
      const updated = response?.runnerHost;
      if (updated) {
        updateHostList(updated);
      }
      const nextSecret = response?.secret || "";
      setHostNotice(host.id, {
        type: "success",
        message: "Runner token rotated. Update the runner agent with the new secret.",
        secret: nextSecret,
      });
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setHostNotice(host.id, {
          type: "error",
          message:
            err?.data?.error || err.message || "Failed to rotate runner token.",
        });
      }
    } finally {
      setRotatingHostId("");
    }
  };

  const handleDisconnectRunner = async (host) => {
    if (!host?.id) return;
    const confirmed = await confirm({
      title: `Disconnect "${host.name || host.id}"?`,
      message:
        "The runner secret will be cleared and the agent must be reconfigured before it can reconnect.",
      tone: "warn",
      confirmLabel: "Disconnect runner",
    });
    if (!confirmed) return;

    setDisconnectingHostId(host.id);
    setHostNotice(host.id, null);
    try {
      const response = await apiRequest(`/api/settings/runner-hosts/${host.id}/disconnect`, {
        method: "POST",
      });
      const updated = response?.runnerHost;
      if (updated) {
        updateHostList(updated);
      }
      setHostNotice(host.id, {
        type: "success",
        message:
          "Runner disconnected. Rotate the token to generate a new secret before reconnecting.",
      });
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setHostNotice(host.id, {
          type: "error",
          message:
            err?.data?.error || err.message || "Failed to disconnect runner token.",
        });
      }
    } finally {
      setDisconnectingHostId("");
    }
  };

  return (
    <div className="space-y-6">
      {!isCreateOpen && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => {
              setIsCreateOpen(true);
              setForm(initialFormState);
              setFormError("");
              setFormSuccess("");
              setGeneratedSecret("");
            }}
            className="rounded border border-slate-700 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300 transition hover:bg-slate-800"
          >
            + Add runner
          </button>
        </div>
      )}

      {isCreateOpen && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-slate-100">Register a new runner</h3>
              <p className="mt-1 text-sm text-slate-400">
                Create a runner key to share with an Automn Runner agent. Each runner must
                authenticate with this secret before it can receive jobs.
              </p>
            </div>
            <button
              type="button"
              onClick={handleCloseCreatePanel}
              className="rounded border border-slate-700 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300 transition hover:bg-slate-800"
            >
              Close
            </button>
          </div>
          <form className="mt-4 space-y-4" onSubmit={handleCreateRunner}>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="flex flex-col text-sm text-slate-200">
                <span className="font-semibold">Runner name</span>
                <input
                  type="text"
                  name="name"
                  value={form.name}
                  onChange={handleInputChange}
                  className="mt-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-slate-500 focus:outline-none"
                  placeholder="e.g. Production runner"
                />
              </label>
              <label className="flex flex-col text-sm text-slate-200">
                <span className="font-semibold">Runner ID (optional)</span>
                <input
                  type="text"
                  name="id"
                  value={form.id}
                  onChange={handleInputChange}
                  className="mt-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-slate-500 focus:outline-none"
                  placeholder="Leave blank to auto-generate"
                />
              </label>
            </div>
            <label className="flex flex-col text-sm text-slate-200">
              <span className="font-semibold">Runner secret (optional)</span>
              <input
                type="text"
                name="secret"
                value={form.secret}
                onChange={handleInputChange}
                className="mt-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-slate-500 focus:outline-none"
                placeholder="Leave blank to generate a secure secret"
              />
              <span className="mt-1 text-xs text-slate-500">
                Minimum 12 characters. The secret is only shown once after creation.
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm text-slate-200">
              <input
                type="checkbox"
                name="adminOnly"
                checked={Boolean(form.adminOnly)}
                onChange={handleInputChange}
                className="mt-1 h-4 w-4 rounded border border-slate-600 bg-slate-900"
              />
              <span className="flex flex-col">
                <span className="font-semibold">Admin only</span>
                <span className="text-xs text-slate-500">
                  When enabled, only administrators can assign scripts to this runner.
                </span>
              </span>
            </label>
            {formError && <div className="text-sm text-rose-400">{formError}</div>}
            {formSuccess && (
              <div className="rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-200">
                <p>{formSuccess}</p>
                {generatedSecret && (
                  <p className="mt-2">
                    Secret: <code className="rounded bg-slate-900 px-2 py-1 text-emerald-100">{generatedSecret}</code>
                  </p>
                )}
              </div>
            )}
            <div className="flex items-center gap-3">
              <button
                type="submit"
                className="rounded border border-emerald-500/60 bg-emerald-500/10 px-4 py-2 text-sm font-semibold uppercase tracking-wide text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Creating..." : "Create runner"}
              </button>
              <button
                type="button"
                onClick={loadRunnerHosts}
                className="rounded border border-slate-700 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
              >
                Refresh list
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-100">Registered runners</h3>
          {heartbeatWindowMs > 0 && (
            <span className="text-xs text-slate-500">
              Heartbeat window: {Math.round(heartbeatWindowMs / 1000)} seconds
            </span>
          )}
        </div>
        {error && <div className="text-sm text-rose-400">{error}</div>}
        {isLoading ? (
          <div className="rounded border border-slate-800 bg-slate-900/50 p-4 text-sm text-slate-400">
            Loading runners...
          </div>
        ) : sortedHosts.length === 0 ? (
          <div className="rounded border border-dashed border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-400">
            No runners have been registered yet.
          </div>
        ) : (
          <div className="space-y-4">
            {sortedHosts.map((host) => {
              const status = classifyStatus(host);
              const maxConcurrencyValue = Number(host.maxConcurrency);
              const timeoutValue = Number(host.timeoutMs);
              const displayConcurrency =
                Number.isFinite(maxConcurrencyValue) && maxConcurrencyValue > 0
                  ? maxConcurrencyValue
                  : "∞";
              const displayTimeout =
                Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : "—";
              const runtimeEntries = Object.entries(host.runnerRuntimes || {})
                .map(([runtime, version]) => {
                  if (!runtime && runtime !== 0) {
                    return null;
                  }
                  const normalizedRuntime = String(runtime).trim();
                  if (!normalizedRuntime) {
                    return null;
                  }
                  return {
                    key: normalizedRuntime,
                    displayName: formatRuntimeName(normalizedRuntime),
                    version: normalizeRuntimeVersion(version),
                    icon: getRuntimeIcon(normalizedRuntime),
                  };
                })
                .filter(Boolean)
                .sort((a, b) =>
                  a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
                );
              const visibleServiceIcons = runtimeEntries.slice(0, 4);
              const remainingServiceCount = Math.max(
                runtimeEntries.length - visibleServiceIcons.length,
                0,
              );
              const { icon: osIcon, label: osLabel } = getOsIndicator(host);
              const isExpanded = Boolean(expandedHosts[host.id]);

              return (
                <div
                  key={host.id}
                  className="rounded-lg border p-3"
                  style={{
                    borderColor: "var(--color-panel-border)",
                    background: "var(--color-surface-1)",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggleHostExpansion(host.id)}
                    className="flex w-full items-center justify-between gap-4 rounded-md px-2 py-2 text-left transition hover:bg-[color:var(--color-surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500"
                    aria-expanded={isExpanded}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md border"
                        style={{
                          borderColor: "var(--color-panel-border)",
                          background: "var(--color-surface-2)",
                        }}
                      >
                        {renderRuntimeIcon(osIcon, {
                          imageClassName: "h-7 w-7",
                          emojiClassName: "text-xl",
                        })}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold text-slate-100">
                            {host.name || host.id}
                          </span>
                        </div>
                        <div className="truncate text-xs text-slate-500">
                          Runner ID: <code className="text-slate-300">{host.id}</code>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                          STATUS_BADGES[status.tone] || STATUS_BADGES.slate
                        }`}
                      >
                        {status.label}
                      </span>
                      {visibleServiceIcons.length > 0 ? (
                        <div className="flex items-center gap-1">
                          {visibleServiceIcons.map(({ key: runtimeKey, displayName, icon }) => (
                            <span
                              key={runtimeKey}
                              className="flex h-7 w-7 items-center justify-center rounded border"
                              style={{
                                borderColor: "var(--color-panel-border)",
                                background: "var(--color-surface-2)",
                              }}
                              title={displayName}
                            >
                              {renderRuntimeIcon(icon, {
                                imageClassName: "h-5 w-5",
                                emojiClassName: "text-base",
                              })}
                            </span>
                          ))}
                          {remainingServiceCount > 0 && (
                            <span className="text-[11px] font-semibold text-slate-400">
                              +{remainingServiceCount}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-500">—</span>
                      )}
                      <span
                        aria-hidden="true"
                        className={`inline-flex h-5 w-5 items-center justify-center text-slate-500 transition-transform ${
                          isExpanded ? "rotate-180" : ""
                        }`}
                      >
                        <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
                          <path
                            d="M6 8l4 4 4-4"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                    </div>
                    <span className="sr-only">
                      Operating system: {osLabel}. {isExpanded ? "Collapse details" : "Expand for details"}.
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="mt-3 space-y-3 border-t border-slate-800/60 pt-3">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div className="text-xs text-slate-500">
                          Status message: {host.statusMessage || "—"}
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <button
                            onClick={() => beginEditingHost(host)}
                            className="button-clear rounded border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors"
                            type="button"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleRotateSecret(host)}
                            disabled={rotatingHostId === host.id}
                            className="button-run rounded border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                            type="button"
                          >
                            {rotatingHostId === host.id ? "Rotating..." : "Rotate token"}
                          </button>
                          <button
                            onClick={() => handleDisconnectRunner(host)}
                            disabled={disconnectingHostId === host.id}
                            className="button-clear rounded border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                            type="button"
                          >
                            {disconnectingHostId === host.id ? "Disconnecting..." : "Disconnect"}
                          </button>
                          {host.status === "disabled" || host.disabledAt ? (
                            <button
                              onClick={() => handleEnableRunner(host)}
                              disabled={enablingHostId === host.id}
                              className="button-run rounded border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {enablingHostId === host.id ? "Enabling..." : "Enable"}
                            </button>
                          ) : (
                            <button
                              onClick={() => handleDisableRunner(host)}
                              disabled={disablingHostId === host.id}
                              className="button-danger rounded border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {disablingHostId === host.id ? "Disabling..." : "Disable"}
                            </button>
                          )}
                          <button
                            onClick={() => handleDeleteRunner(host)}
                            disabled={deletingHostId === host.id}
                            className="button-danger rounded border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {deletingHostId === host.id ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      </div>
                      {editingHostId === host.id && (
                        <form
                          className="space-y-3 rounded-md border border-slate-800/80 bg-slate-950/40 p-3"
                          onSubmit={handleSaveHost}
                        >
                          <label className="flex flex-col gap-1 text-sm text-slate-200">
                            <span className="font-semibold">Runner name</span>
                            <input
                              type="text"
                              name="name"
                              value={editForm.name}
                              onChange={handleEditFieldChange}
                              className="rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-slate-500 focus:outline-none"
                              placeholder="Runner name"
                            />
                          </label>
                          <label className="flex items-start gap-3 text-sm text-slate-200">
                            <input
                              type="checkbox"
                              name="adminOnly"
                              checked={Boolean(editForm.adminOnly)}
                              onChange={handleEditFieldChange}
                              className="mt-1 h-4 w-4 rounded border border-slate-600 bg-slate-900"
                            />
                            <span className="flex flex-col">
                              <span className="font-semibold">Admin only</span>
                              <span className="text-xs text-slate-500">
                                When enabled, only administrators can assign scripts to this runner.
                              </span>
                            </span>
                          </label>
                          {editError && (
                            <div className="text-sm text-rose-400">{editError}</div>
                          )}
                          <div className="flex items-center gap-2">
                            <button
                              type="submit"
                              className="button-run rounded border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={isSavingEdit}
                            >
                              {isSavingEdit ? "Saving..." : "Save changes"}
                            </button>
                            <button
                              type="button"
                              onClick={cancelEditingHost}
                              className="button-clear rounded border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      )}
                      {hostNotices[host.id] && (
                        <div
                          className={`rounded border px-3 py-2 text-xs ${
                            hostNotices[host.id].type === "error"
                              ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
                              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                          }`}
                        >
                          <p>{hostNotices[host.id].message}</p>
                          {hostNotices[host.id].secret && (
                            <p className="mt-2 font-mono text-slate-100">
                              <span className="text-slate-300">Secret:</span>{" "}
                              <code className="rounded bg-slate-900 px-2 py-1 text-xs text-emerald-100">
                                {hostNotices[host.id].secret}
                              </code>
                            </p>
                          )}
                        </div>
                      )}
                      <div className="grid gap-4 text-sm text-slate-300 md:grid-cols-2 lg:grid-cols-3">
                        <div>
                          <span className="text-xs uppercase text-slate-500">Last seen</span>
                          <div>{formatTimestamp(host.lastSeenAt)}</div>
                        </div>
                        <div>
                          <span className="text-xs uppercase text-slate-500">Endpoint</span>
                          <div className="break-words text-slate-200">
                            {host.endpoint ? <code>{host.endpoint}</code> : "—"}
                          </div>
                        </div>
                        <div>
                          <span className="text-xs uppercase text-slate-500">Access</span>
                          <div>{host.adminOnly ? "Admins only" : "All editors"}</div>
                        </div>
                        <div>
                          <span className="text-xs uppercase text-slate-500">Capabilities</span>
                          <div className="mt-1 space-y-1">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-slate-400">Max concurrency</span>
                              <span className="text-slate-200">{displayConcurrency}</span>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-slate-400">Timeout (ms)</span>
                              <span className="text-slate-200">{displayTimeout}</span>
                            </div>
                          </div>
                        </div>
                        <div>
                          <span className="text-xs uppercase text-slate-500">Versions</span>
                          <div className="mt-1 space-y-1">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-slate-400">Runner</span>
                              <span className="text-slate-200">{host.runnerVersion || "—"}</span>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-slate-400">Min host</span>
                              <span className="text-slate-200">{host.minimumHostVersion || "—"}</span>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-slate-400">Host</span>
                              <span className="text-slate-200">{host.hostVersion || "—"}</span>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-slate-400">Min runner</span>
                              <span className="text-slate-200">{host.minimumRunnerVersion || "—"}</span>
                            </div>
                          </div>
                        </div>
                        <div>
                          <span className="text-xs uppercase text-slate-500">Operating system</span>
                          <div className="mt-1 space-y-1">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-slate-400">OS</span>
                              <span className="text-slate-200">{host.runnerOs || "—"}</span>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-slate-400">Platform</span>
                              <span className="text-slate-200">{host.runnerPlatform || "—"}</span>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-slate-400">Architecture</span>
                              <span className="text-slate-200">{host.runnerArch || "—"}</span>
                            </div>
                          </div>
                        </div>
                        <div className="md:col-span-2 lg:col-span-3">
                          <span className="text-xs uppercase text-slate-500">Runtime versions</span>
                          {runtimeEntries.length > 0 ? (
                            <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                              {runtimeEntries.map(({ key: runtimeKey, displayName, version, icon }) => (
                                <div
                                  key={runtimeKey}
                                  className="flex flex-wrap items-center justify-between gap-3 rounded px-3 py-2"
                                  style={RUNTIME_CARD_STYLE}
                                >
                                  <div className="flex min-w-0 items-center gap-3">
                                    <span
                                      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md"
                                      style={RUNTIME_ICON_STYLE}
                                    >
                                      {renderRuntimeIcon(icon)}
                                    </span>
                                    <span className="truncate font-medium text-[color:var(--color-text-strong)]">
                                      {displayName}
                                    </span>
                                  </div>
                                  <span className="font-mono text-sm text-[color:var(--color-text-muted)]">
                                    {version || "—"}
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="mt-1 text-slate-400">No runtime metadata reported.</div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
