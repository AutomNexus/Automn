const levelClassMap = {
  info: "text-sky-300",
  warn: "text-yellow-300",
  warning: "text-yellow-300",
  error: "text-red-400",
};

export default function LiveLogViewer({ entries }) {
  return (
    <div className="bg-black rounded-md p-3 h-96 overflow-y-auto font-mono text-sm text-gray-200 shadow-inner border border-gray-700 space-y-1">
      {entries.length === 0 ? (
        <div className="text-gray-500">Waiting for output...</div>
      ) : (
        entries.map((entry, i) => {
          if (entry.type === "structured") {
            const levelKey = entry.level?.toLowerCase?.() || "info";
            const levelClass = levelClassMap[levelKey] || "text-sky-200";
            return (
              <div key={i} className="flex flex-wrap items-baseline gap-2">
                <span className={`font-semibold ${levelClass}`}>
                  [{(entry.level || "info").toUpperCase()}]
                </span>
                <span className="text-gray-200">{entry.message}</span>
                {entry.context !== undefined && entry.context !== null && entry.context !== "" && (
                  <span className="text-xs text-slate-400">
                    {typeof entry.context === "string"
                      ? entry.context
                      : JSON.stringify(entry.context)}
                  </span>
                )}
              </div>
            );
          }

          return (
            <div key={i} className="text-green-400 whitespace-pre-wrap">
              {entry.text}
            </div>
          );
        })
      )}
    </div>
  );
}
