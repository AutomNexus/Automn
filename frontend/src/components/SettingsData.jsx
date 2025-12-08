import { useState } from "react";
import { apiRequest } from "../utils/api";

export default function SettingsData({ onAuthError }) {
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [backupError, setBackupError] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const [restoreSuccess, setRestoreSuccess] = useState("");
  const [isRestoring, setIsRestoring] = useState(false);
  const [backupPassword, setBackupPassword] = useState("");
  const [restorePassword, setRestorePassword] = useState("");
  const [restoreOptions, setRestoreOptions] = useState({
    restoreScripts: true,
    restoreVariables: true,
    restoreRunners: true,
    restoreCollections: true,
    restoreUsers: true,
  });

  const restoreOptionList = [
    { key: "restoreScripts", label: "Scripts", description: "Script definitions and versions." },
    {
      key: "restoreVariables",
      label: "Variables",
      description: "Global, collection, and script variables.",
    },
    {
      key: "restoreRunners",
      label: "Runners",
      description: "Restores runner hosts in a disconnected state.",
    },
    {
      key: "restoreCollections",
      label: "Collections",
      description: "Collection metadata and permissions.",
    },
    { key: "restoreUsers", label: "Users", description: "User accounts and preferences." },
  ];

  const handleDownloadBackup = async () => {
    setIsBackingUp(true);
    setBackupError("");
    try {
      const headers = {};
      if (backupPassword.trim()) {
        headers["X-Automn-Backup-Password"] = backupPassword;
      }

      const requestOptions = { skipJson: true };
      if (Object.keys(headers).length > 0) {
        requestOptions.headers = headers;
      }

      const response = await apiRequest("/api/data/backup", requestOptions);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const extension = backupPassword.trim() ? ".automn.enc" : ".db";
      link.href = url;
      link.download = `automn-backup-${timestamp}${extension}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setBackupError(err?.data?.error || err.message || "Failed to create backup");
      }
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleRestoreOptionChange = (key) => (event) => {
    setRestoreOptions((current) => ({
      ...current,
      [key]: Boolean(event?.target?.checked),
    }));
  };

  const handleRestore = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setRestoreError("");
    setRestoreSuccess("");
    setIsRestoring(true);

    if (typeof FileReader === "undefined") {
      setRestoreError("File uploads are not supported in this environment.");
      setIsRestoring(false);
      event.target.value = "";
      return;
    }

    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          if (typeof result !== "string") {
            reject(new Error("Failed to read backup file."));
            return;
          }
          const commaIndex = result.indexOf(",");
          resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
        };
        reader.onerror = () => {
          reject(reader.error || new Error("Failed to read backup file."));
        };
        reader.readAsDataURL(file);
      });

      await apiRequest("/api/data/restore", {
        method: "POST",
        body: { backup: base64, password: restorePassword, ...restoreOptions },
      });
      setRestoreSuccess("Selected data restored successfully. Running data has been reloaded.");
      setRestorePassword("");
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        setRestoreError(err?.data?.error || err.message || "Failed to restore backup");
      }
    } finally {
      setIsRestoring(false);
      event.target.value = "";
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-slate-100">Data safety</h3>
        <p className="mt-1 text-sm text-slate-400">
          Download a copy of the Automn database or restore from a previous backup.
        </p>
      </div>

      <div className="space-y-4 rounded border border-slate-800 bg-slate-900/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-slate-100">Backup</h4>
            <p className="text-xs text-slate-400">
              Downloads a snapshot of the Automn database. Optionally encrypt it
              with a password for secure storage.
            </p>
          </div>
          <button
            type="button"
            onClick={handleDownloadBackup}
            disabled={isBackingUp}
            className="rounded border border-sky-500/60 bg-sky-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isBackingUp ? "Preparing…" : "Download backup"}
          </button>
        </div>
        <label className="block text-xs text-slate-400">
          Backup password (optional)
          <input
            type="password"
            name="backup-password"
            value={backupPassword}
            onChange={(event) => setBackupPassword(event.target.value)}
            placeholder="Leave blank for an unencrypted backup"
            autoComplete="new-password"
            className="mt-1 w-full rounded border border-slate-800 bg-slate-950/60 px-2 py-1 text-xs text-slate-200 focus:border-sky-500 focus:outline-none"
          />
        </label>
        {backupError && <p className="text-sm text-red-400">{backupError}</p>}
      </div>

      <div className="space-y-4 rounded border border-slate-800 bg-slate-900/40 p-4">
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold text-slate-100">Restore</h4>
          <p className="text-xs text-slate-400">
            Restoring will replace Automn data with the contents of the selected backup file.
          </p>
          <p className="text-[11px] text-slate-500">
            Large backups may take several minutes to upload and process.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {restoreOptionList.map((option) => (
              <label
                key={option.key}
                className="flex items-start gap-2 rounded border border-slate-800/80 bg-slate-950/40 p-2 text-xs text-slate-300"
              >
                <input
                  type="checkbox"
                  checked={restoreOptions[option.key]}
                  onChange={handleRestoreOptionChange(option.key)}
                  disabled={isRestoring}
                  className="mt-[2px] accent-sky-500"
                />
                <span>
                  <span className="block font-semibold text-slate-100">{option.label}</span>
                  <span className="text-[11px] text-slate-400">{option.description}</span>
                </span>
              </label>
            ))}
          </div>
          <input
            type="file"
            accept=".db,.automn.enc,application/octet-stream"
            onChange={handleRestore}
            disabled={isRestoring}
            className="mt-2 text-xs text-slate-300"
          />
          <label className="text-xs text-slate-400">
            Backup password (required for encrypted backups)
            <input
              type="password"
            name="restore-password"
            value={restorePassword}
            onChange={(event) => setRestorePassword(event.target.value)}
            placeholder="Enter the password if the backup is encrypted"
            autoComplete="new-password"
              className="mt-1 w-full rounded border border-slate-800 bg-slate-950/60 px-2 py-1 text-xs text-slate-200 focus:border-sky-500 focus:outline-none"
            />
          </label>
        </div>
        {restoreError && <p className="text-sm text-red-400">{restoreError}</p>}
        {restoreSuccess && <p className="text-sm text-emerald-400">{restoreSuccess}</p>}
        {isRestoring && (
          <p className="text-xs text-slate-400">
            Uploading backup… Please keep this window open.
          </p>
        )}
      </div>
    </div>
  );
}
