import { useEffect, useState } from "react";
import { resolveBackendWebSocketUrl } from "../utils/network";

export function useLiveLogs(runId) {
  const [entries, setEntries] = useState([]);

  useEffect(() => {
    if (!runId) {
      setEntries([]);
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) return;

    setEntries([]);
    let buffer = "";
    const ws = new WebSocket(
      resolveBackendWebSocketUrl(`/api/ws?runId=${encodeURIComponent(runId)}`),
    );

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (!data.line) return;

        buffer += data.line;
        const segments = buffer.split(/\r?\n/);
        buffer = segments.pop() ?? "";

        const updates = [];
        for (const segment of segments) {
          if (!segment) continue;
          if (segment.startsWith("__SCRIPTLOG__")) {
            const payloadRaw = segment.slice("__SCRIPTLOG__".length);
            try {
              const payload = JSON.parse(payloadRaw);
              updates.push({
                type: "structured",
                level: String(payload.level || "info"),
                message: payload.message ?? "",
                context: payload.context,
              });
              continue;
            } catch {
              // fall through to treat as plain text if parsing fails
            }
          }

          if (segment.startsWith("__SCRIPTRETURN__")) {
            // Swallow the structured return helper output from the live log feed
            continue;
          }

          updates.push({ type: "text", text: segment });
        }

        if (updates.length) {
          setEntries((prev) => [...prev, ...updates]);
        }
      } catch {
        /* ignore malformed frames */
      }
    };

    return () => {
      buffer = "";
      ws.close();
    };
  }, [runId]);

  return entries;
}
