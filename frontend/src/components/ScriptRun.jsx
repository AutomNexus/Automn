import { useState } from "react";
import LiveLogViewer from "./LiveLogViewer";
import { useLiveLogs } from "../hooks/useLiveLogs";
import { apiRequest } from "../utils/api";

export default function ScriptRun({ script, onEdit, onAuthError }) {

  const [runId, setRunId] = useState(null);
  const entries = useLiveLogs(runId);

  async function handleRun() {
    try {
      const data = await apiRequest(`/s/${encodeURIComponent(script.endpoint)}`, {
        method: "POST",
        body: {},
      });
      if (data?.runId) {
        setRunId(data.runId);
      }
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
        return;
      }
      console.error("Failed to run script", err);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">{script.name}</h2>
        <div className="flex gap-2">
          <button
            className="bg-sky-400 hover:bg-sky-300 text-black px-3 py-1 rounded"
            onClick={handleRun}>
            ▶ Run
          </button>
          <button
            className="bg-slate-700 hover:bg-slate-600 text-gray-200 px-3 py-1 rounded"
            onClick={() => onEdit(script)}>
            ✏️ Edit
          </button>
        </div>
      </div>
      {runId && <LiveLogViewer entries={entries} />}
    </div>
  );
}
