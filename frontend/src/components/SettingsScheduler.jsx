import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../utils/api";
import { useNotificationDialog } from "./NotificationDialogProvider";

const DEFAULT_FORM_STATE = {
  id: "",
  name: "",
  scriptId: "",
  httpMethod: "POST",
  payload: "",
  mode: "interval",
  every: 1,
  unit: "hours",
  startTime: "00:00",
  startDate: "",
  daysOfWeek: [],
  timeOfDay: "09:00",
  isEnabled: true,
};

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const HTTP_METHOD_OPTIONS = ["POST", "GET", "PUT", "PATCH", "DELETE"];

function formatScheduleSummary(job) {
  if (!job?.schedule) return "No schedule";
  const schedule = job.schedule;
  if (schedule.mode === "weekly") {
    const dayLabels = (schedule.daysOfWeek || [])
      .map((day) => WEEKDAY_LABELS[day] || day)
      .join(", ");
    const time = schedule.time
      ? `${String(schedule.time.hours).padStart(2, "0")}:${String(schedule.time.minutes).padStart(2, "0")}`
      : "00:00";
    return `Weekly on ${dayLabels} at ${time}`;
  }

  const every = schedule.every || 1;
  const unit = schedule.unit || "hours";
  const startTime =
    schedule.startTime && typeof schedule.startTime === "object"
      ? `${String(schedule.startTime.hours).padStart(2, "0")}:${String(schedule.startTime.minutes).padStart(2, "0")}`
      : schedule.startTime || "";
  const startLabel = startTime ? ` starting at ${startTime}` : "";
  return `Every ${every} ${unit}${every === 1 ? "" : "s"}${startLabel}`;
}

function scheduleToForm(schedule) {
  if (!schedule) return {};
  if (schedule.mode === "weekly") {
    const timeValue = schedule.time
      ? `${String(schedule.time.hours).padStart(2, "0")}:${String(schedule.time.minutes).padStart(2, "0")}`
      : "09:00";
    return {
      mode: "weekly",
      daysOfWeek: schedule.daysOfWeek || [],
      timeOfDay: timeValue,
    };
  }

  const startValue = schedule.startTime
    ? `${String(schedule.startTime.hours).padStart(2, "0")}:${String(schedule.startTime.minutes).padStart(2, "0")}`
    : schedule.startTime || "00:00";

  return {
    mode: "interval",
    every: schedule.every || 1,
    unit: schedule.unit || "hours",
    startTime: startValue,
    startDate: schedule.startDate || "",
  };
}

function buildSchedulePayload(form) {
  if (form.mode === "weekly") {
    return {
      mode: "weekly",
      daysOfWeek: form.daysOfWeek || [],
      time: form.timeOfDay || "09:00",
    };
  }

  return {
    mode: "interval",
    every: form.every || 1,
    unit: form.unit || "hours",
    startTime: form.startTime || "00:00",
    startDate: form.startDate || "",
  };
}

function SchedulerToggle({ enabled, running, onToggle }) {
  return (
    <div className="flex items-center justify-between rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-surface-1)] p-4">
      <div>
        <div className="text-sm font-semibold text-slate-100">Scheduler service</div>
        <div className="text-xs text-slate-400">
          {running
            ? "The scheduler will execute enabled jobs automatically."
            : "The scheduler is currently stopped."}
        </div>
      </div>
      <button
        type="button"
        onClick={onToggle}
        className={`rounded px-3 py-2 text-sm font-semibold transition ${
          enabled
            ? "bg-emerald-600 text-white hover:bg-emerald-500"
            : "bg-slate-700 text-slate-200 hover:bg-slate-600"
        }`}
      >
        {enabled ? "Stop" : "Start"}
      </button>
    </div>
  );
}

export default function SettingsScheduler({ onAuthError }) {
  const [jobs, setJobs] = useState([]);
  const [scripts, setScripts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [running, setRunning] = useState(false);
  const [form, setForm] = useState(DEFAULT_FORM_STATE);
  const [editingId, setEditingId] = useState("");
  const { showNotification } = useNotificationDialog();

  const scriptOptions = useMemo(() => {
    return scripts.map((script) => ({
      id: script.id,
      name: script.name || script.id,
    }));
  }, [scripts]);

  const resetForm = () => {
    setForm(DEFAULT_FORM_STATE);
    setEditingId("");
  };

  const handleAuthError = (error) => {
    if (typeof onAuthError === "function") {
      onAuthError(error);
    }
  };

  const loadScheduler = async () => {
    setLoading(true);
    try {
      const response = await apiRequest("/api/settings/scheduler");
      setEnabled(Boolean(response.enabled));
      setRunning(Boolean(response.running));
      const sanitizedJobs = Array.isArray(response.jobs) ? response.jobs : [];
      setJobs(sanitizedJobs);
    } catch (err) {
      handleAuthError(err);
    } finally {
      setLoading(false);
    }
  };

  const loadScripts = async () => {
    try {
      const response = await apiRequest("/api/scripts");
      const items = Array.isArray(response.scripts) ? response.scripts : [];
      setScripts(items);
    } catch (err) {
      handleAuthError(err);
    }
  };

  useEffect(() => {
    loadScheduler();
    loadScripts();
  }, []);

  const handleToggleScheduler = async () => {
    try {
      await apiRequest("/api/settings/scheduler/state", {
        method: "POST",
        body: { enabled: !enabled },
      });
      await loadScheduler();
    } catch (err) {
      handleAuthError(err);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const schedulePayload = buildSchedulePayload(form);
      const payload = {
        name: form.name,
        scriptId: form.scriptId,
        httpMethod: form.httpMethod,
        payload: form.payload,
        schedule: schedulePayload,
        isEnabled: form.isEnabled,
      };

      if (editingId) {
        await apiRequest(`/api/settings/scheduler/jobs/${editingId}`, {
          method: "PATCH",
          body: payload,
        });
        showNotification({
          title: "Scheduler job updated",
          description: "Changes were saved successfully.",
          tone: "success",
        });
      } else {
        await apiRequest("/api/settings/scheduler/jobs", {
          method: "POST",
          body: payload,
        });
        showNotification({
          title: "Scheduler job created",
          description: "The job has been added to the queue.",
          tone: "success",
        });
      }

      resetForm();
      await loadScheduler();
    } catch (err) {
      handleAuthError(err);
      showNotification({
        title: "Scheduler change failed",
        description: err?.message || "Unable to save changes.",
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (job) => {
    const scheduleFields = scheduleToForm(job.schedule);
    setForm((prev) => ({
      ...prev,
      ...DEFAULT_FORM_STATE,
      ...scheduleFields,
      id: job.id,
      name: job.name || "",
      scriptId: job.scriptId || "",
      httpMethod: job.httpMethod || "POST",
      payload: job.payload || "",
      isEnabled: Boolean(job.isEnabled),
    }));
    setEditingId(job.id);
  };

  const handleEnableToggle = async (job) => {
    try {
      await apiRequest(`/api/settings/scheduler/jobs/${job.id}`, {
        method: "PATCH",
        body: { isEnabled: !job.isEnabled },
      });
      await loadScheduler();
    } catch (err) {
      handleAuthError(err);
    }
  };

  const handleDelete = async (job) => {
    if (!window.confirm("Delete this scheduled job?")) return;
    try {
      await apiRequest(`/api/settings/scheduler/jobs/${job.id}`, {
        method: "DELETE",
      });
      await loadScheduler();
      if (editingId === job.id) {
        resetForm();
      }
    } catch (err) {
      handleAuthError(err);
    }
  };

  const handleTest = async (job) => {
    try {
      await apiRequest(`/api/settings/scheduler/jobs/${job.id}/test`, {
        method: "POST",
      });
      showNotification({
        title: "Test started",
        description: "The script run was dispatched.",
        tone: "success",
      });
    } catch (err) {
      handleAuthError(err);
      showNotification({
        title: "Test failed",
        description: err?.message || "Unable to start the test run.",
        tone: "error",
      });
    }
  };

  const currentFormScheduleLabel = useMemo(() => {
    return formatScheduleSummary({ schedule: buildSchedulePayload(form) });
  }, [form]);

  return (
    <div className="space-y-6">
      <SchedulerToggle enabled={enabled} running={running} onToggle={handleToggleScheduler} />

      <div className="rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-surface-1)] p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-100">
              {editingId ? "Edit scheduled job" : "Create scheduled job"}
            </h3>
            <p className="text-xs text-slate-400">Dispatch scripts automatically with a fixed cadence.</p>
          </div>
          {editingId && (
            <button
              type="button"
              className="text-xs font-semibold text-sky-300 hover:text-sky-200"
              onClick={resetForm}
            >
              New job
            </button>
          )}
        </div>

        <form className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={handleSubmit}>
          <label className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-slate-200">Name</span>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              className="rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-surface-2)] p-2 text-sm text-slate-100"
              placeholder="Nightly refresh"
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-slate-200">Script</span>
            <select
              value={form.scriptId}
              onChange={(e) => setForm((prev) => ({ ...prev, scriptId: e.target.value }))}
              className="rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-surface-2)] p-2 text-sm text-slate-100"
            >
              <option value="">Select a script</option>
              {scriptOptions.map((script) => (
                <option key={script.id} value={script.id}>
                  {script.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-slate-200">HTTP method</span>
            <select
              value={form.httpMethod}
              onChange={(e) => setForm((prev) => ({ ...prev, httpMethod: e.target.value }))}
              className="rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-surface-2)] p-2 text-sm text-slate-100"
            >
              {HTTP_METHOD_OPTIONS.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-slate-200">Payload (optional)</span>
            <textarea
              rows={3}
              value={form.payload}
              onChange={(e) => setForm((prev) => ({ ...prev, payload: e.target.value }))}
              className="min-h-[80px] rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-surface-2)] p-2 text-sm text-slate-100"
              placeholder="JSON body or text"
            />
          </label>

          <div className="md:col-span-2">
            <div className="flex flex-wrap items-center gap-3 text-sm font-semibold text-slate-100">
              <button
                type="button"
                className={`rounded px-3 py-2 transition ${
                  form.mode === "interval"
                    ? "bg-sky-600 text-white"
                    : "bg-slate-800 text-slate-200"
                }`}
                onClick={() => setForm((prev) => ({ ...prev, mode: "interval" }))}
              >
                Interval
              </button>
              <button
                type="button"
                className={`rounded px-3 py-2 transition ${
                  form.mode === "weekly"
                    ? "bg-sky-600 text-white"
                    : "bg-slate-800 text-slate-200"
                }`}
                onClick={() => setForm((prev) => ({ ...prev, mode: "weekly" }))}
              >
                Weekly
              </button>
              <span className="text-xs text-slate-400">{currentFormScheduleLabel}</span>
            </div>

            {form.mode === "interval" ? (
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <label className="flex flex-col gap-2">
                  <span className="text-sm font-semibold text-slate-200">Every</span>
                  <input
                    type="number"
                    min="1"
                    value={form.every}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, every: Number.parseInt(e.target.value, 10) || 1 }))
                    }
                    className="rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-surface-2)] p-2 text-sm text-slate-100"
                  />
                </label>
                <label className="flex flex-col gap-2">
                  <span className="text-sm font-semibold text-slate-200">Unit</span>
                  <select
                    value={form.unit}
                    onChange={(e) => setForm((prev) => ({ ...prev, unit: e.target.value }))}
                    className="rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-surface-2)] p-2 text-sm text-slate-100"
                  >
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                    <option value="weeks">Weeks</option>
                    <option value="months">Months</option>
                  </select>
                </label>
                <label className="flex flex-col gap-2">
                  <span className="text-sm font-semibold text-slate-200">Starting at</span>
                  <input
                    type="time"
                    value={form.startTime}
                    onChange={(e) => setForm((prev) => ({ ...prev, startTime: e.target.value }))}
                    className="rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-surface-2)] p-2 text-sm text-slate-100"
                  />
                </label>
                <label className="flex flex-col gap-2 md:col-span-3">
                  <span className="text-sm font-semibold text-slate-200">Anchor date (optional)</span>
                  <input
                    type="date"
                    value={form.startDate}
                    onChange={(e) => setForm((prev) => ({ ...prev, startDate: e.target.value }))}
                    className="rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-surface-2)] p-2 text-sm text-slate-100"
                  />
                </label>
              </div>
            ) : (
              <div className="mt-3 grid gap-3 md:grid-cols-4">
                <div className="md:col-span-3">
                  <span className="text-sm font-semibold text-slate-200">Days</span>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {WEEKDAY_LABELS.map((label, index) => {
                      const selected = form.daysOfWeek.includes(index);
                      return (
                        <button
                          type="button"
                          key={label}
                          onClick={() => {
                            setForm((prev) => {
                              const exists = prev.daysOfWeek.includes(index);
                              const updatedDays = exists
                                ? prev.daysOfWeek.filter((day) => day !== index)
                                : [...prev.daysOfWeek, index].sort();
                              return { ...prev, daysOfWeek: updatedDays };
                            });
                          }}
                          className={`rounded px-3 py-2 text-xs font-semibold transition ${
                            selected
                              ? "bg-sky-600 text-white"
                              : "bg-slate-800 text-slate-200 hover:bg-slate-700"
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <label className="flex flex-col gap-2">
                  <span className="text-sm font-semibold text-slate-200">Time</span>
                  <input
                    type="time"
                    value={form.timeOfDay}
                    onChange={(e) => setForm((prev) => ({ ...prev, timeOfDay: e.target.value }))}
                    className="rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-surface-2)] p-2 text-sm text-slate-100"
                  />
                </label>
              </div>
            )}
          </div>

          <div className="md:col-span-2 flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={form.isEnabled}
                onChange={(e) => setForm((prev) => ({ ...prev, isEnabled: e.target.checked }))}
              />
              <span>Enabled</span>
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={resetForm}
                className="rounded border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:border-sky-500"
              >
                Reset
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
              >
                {saving ? "Saving..." : editingId ? "Update job" : "Create job"}
              </button>
            </div>
          </div>
        </form>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-100">Scheduled jobs</h3>
          <span className="text-xs text-slate-400">{jobs.length} configured</span>
        </div>
        {loading ? (
          <div className="text-sm text-slate-400">Loading scheduler state…</div>
        ) : jobs.length === 0 ? (
          <div className="rounded border border-dashed border-slate-700 bg-[color:var(--color-surface-2)] p-4 text-sm text-slate-400">
            No scheduled jobs yet.
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {jobs.map((job) => (
              <div
                key={job.id}
                className="rounded border border-[color:var(--color-panel-border)] bg-[color:var(--color-surface-1)] p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-slate-100">{job.name || "Untitled job"}</div>
                    <div className="text-xs text-slate-400">{formatScheduleSummary(job)}</div>
                    <div className="text-xs text-slate-500">Script: {job.scriptId || "Unknown"}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase ${
                        job.isEnabled
                          ? "bg-emerald-600/20 text-emerald-200"
                          : "bg-slate-700 text-slate-300"
                      }`}
                    >
                      {job.isEnabled ? "Enabled" : "Disabled"}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleEnableToggle(job)}
                      className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:border-sky-500"
                    >
                      {job.isEnabled ? "Disable" : "Enable"}
                    </button>
                  </div>
                </div>
                <div className="mt-3 grid gap-2 text-xs text-slate-400 sm:grid-cols-3">
                  <div>
                    <div className="font-semibold text-slate-300">HTTP Method</div>
                    <div>{job.httpMethod}</div>
                  </div>
                  <div>
                    <div className="font-semibold text-slate-300">Next run</div>
                    <div>{job.nextRunAt || "Pending"}</div>
                  </div>
                  <div>
                    <div className="font-semibold text-slate-300">Last run</div>
                    <div>{job.lastRunAt || "—"}</div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => handleTest(job)}
                    className="rounded bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500"
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    onClick={() => handleEdit(job)}
                    className="rounded border border-sky-600 px-3 py-1.5 font-semibold text-sky-200 hover:bg-sky-900/40"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(job)}
                    className="rounded border border-rose-600 px-3 py-1.5 font-semibold text-rose-200 hover:bg-rose-900/30"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
