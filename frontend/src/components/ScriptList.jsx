import { useEffect, useState } from "react";
import { apiRequest } from "../utils/api";

export default function ScriptList({ onRun, onAuthError }) {
  const [scripts, setScripts] = useState([]);

  const fetchScripts = async () => {
    try {
      const data = await apiRequest("/api/scripts");
      setScripts(Array.isArray(data) ? data : []);
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
      } else {
        console.error("Failed to load scripts", err);
      }
    }
  };

  useEffect(() => { fetchScripts(); }, []);

  return (
    <div className="space-y-2">
      {scripts.map((s) => (
        <div key={s.id}
          className="bg-slate-800 hover:bg-slate-700 p-3 rounded-md flex justify-between items-center transition">
          <div>
            <div className="font-semibold">{s.name}</div>
            <div className="text-xs text-gray-400">/{s.endpoint}</div>
            {(s.createdByUsername || s.ownerUsername) && (
              <div className="text-xs text-gray-400">
                Created by {s.createdByUsername || s.ownerUsername}
              </div>
            )}
          </div>
          <button
            className="bg-sky-400 hover:bg-sky-300 text-black font-semibold px-3 py-1 rounded"
            onClick={() => onRun(s)}>
            Run
          </button>
        </div>
      ))}
    </div>
  );
}
