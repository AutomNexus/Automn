import { useEffect, useState, useMemo } from "react";

const HTTP_METHODS = ["POST", "GET", "PUT", "PATCH", "DELETE"];

const hasHeaders = (headers) =>
  headers && typeof headers === "object" && Object.keys(headers).length > 0;

const sanitizeJsonUnicode = (value) => {
  if (!value) return value;

  let result = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint && codePoint > 0xffff) {
      const adjusted = codePoint - 0x10000;
      const high = 0xd800 + (adjusted >> 10);
      const low = 0xdc00 + (adjusted & 0x3ff);
      result += `\\u${high.toString(16).padStart(4, "0")}\\u${low
        .toString(16)
        .padStart(4, "0")}`;
    } else {
      result += char;
    }
  }

  return result;
};

export default function RunScriptModal({
  script,
  isOpen,
  onClose,
  onConfirm,
  isSubmitting = false,
}) {
  const [method, setMethod] = useState("POST");
  const [headersInput, setHeadersInput] = useState("");
  const [bodyInput, setBodyInput] = useState("");
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [error, setError] = useState(null);

  const scriptLabel = useMemo(() => {
    if (!script) return "";
    return script.name || script.endpoint || "Run Script";
  }, [script]);

  const methodOptions = useMemo(() => {
    if (!script || !Array.isArray(script.acceptedMethods)) {
      return HTTP_METHODS;
    }
    const normalized = script.acceptedMethods
      .map((method) => (typeof method === "string" ? method.toUpperCase() : ""))
      .filter((method) => HTTP_METHODS.includes(method));
    return normalized.length ? normalized : HTTP_METHODS;
  }, [script]);

  useEffect(() => {
    if (!isOpen || !script) return;

    const preferredMethod = (script.runMethod || "POST").toUpperCase();
    const initialMethod = methodOptions.includes(preferredMethod)
      ? preferredMethod
      : methodOptions[0] || "POST";
    setMethod(initialMethod);
    setHeadersInput(
      hasHeaders(script.runHeaders)
        ? JSON.stringify(script.runHeaders, null, 2)
        : "",
    );
    setBodyInput(script.runBody ? script.runBody : "");
    setSaveAsDefault(false);
    setError(null);
  }, [isOpen, script, methodOptions]);

  if (!isOpen || !script) {
    return null;
  }

  const handleBackdropClick = (event) => {
    if (event.target !== event.currentTarget) return;
    if (isSubmitting) return;
    onClose?.();
  };

  const handleHeadersChange = (event) => {
    setHeadersInput(event.target.value);
    if (error) setError(null);
  };

  const handleBodyChange = (event) => {
    setBodyInput(event.target.value);
    if (error) setError(null);
  };

  const handleMethodChange = (event) => {
    setMethod(event.target.value.toUpperCase());
    if (error) setError(null);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!script || !onConfirm) return;

    const trimmedHeaders = headersInput.trim();
    let parsedHeaders = {};
    if (trimmedHeaders) {
      try {
        const candidate = JSON.parse(trimmedHeaders);
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
          throw new Error("Headers JSON must be an object");
        }
        parsedHeaders = candidate;
      } catch (err) {
        setError("Headers must be valid JSON representing an object.");
        return;
      }
    }

    const trimmedBody = bodyInput.trim();
    let parsedBody;
    if (trimmedBody) {
      try {
        const sanitizedBody = sanitizeJsonUnicode(trimmedBody);
        parsedBody = JSON.parse(sanitizedBody);
      } catch (err) {
        setError("Body must be valid JSON.");
        return;
      }
    } else {
      parsedBody = {};
    }

    setError(null);
    onConfirm({
      method,
      headers: parsedHeaders,
      body: parsedBody,
      bodyRaw: trimmedBody ? JSON.stringify(parsedBody, null, 2) : "",
      saveAsDefault,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="run-script-modal-title"
    >
      <div className="w-full max-w-2xl rounded-lg border border-slate-700 bg-slate-900 shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-6 py-4">
          <div>
            <h2
              id="run-script-modal-title"
              className="text-lg font-semibold text-slate-100"
            >
              Run "{scriptLabel}"
            </h2>
            {script?.endpoint && (
              <p className="mt-1 text-xs font-mono text-slate-500">
                /s/{script.endpoint}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded border border-slate-700 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-300 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Close
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-sm font-medium text-slate-200">
              HTTP Method
              <select
                className="mt-2 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70"
                value={method}
                onChange={handleMethodChange}
              >
                {methodOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm font-medium text-slate-200">
              Headers (JSON)
              <textarea
                className="mt-2 h-36 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70"
                placeholder={'{\n  "Authorization": "Bearer <token>"\n}'}
                value={headersInput}
                onChange={handleHeadersChange}
              />
              <span className="mt-1 block text-[11px] text-slate-500">
                Leave empty to omit custom headers.
              </span>
            </label>
          </div>

          <div>
            <label className="text-sm font-medium text-slate-200">
              Body (JSON)
              <textarea
                className="mt-2 h-48 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/70"
                placeholder={'{\n  "example": "value"\n}'}
                value={bodyInput}
                onChange={handleBodyChange}
              />
              <span className="mt-1 block text-[11px] text-slate-500">
                For GET requests, this JSON will be converted to query parameters.
              </span>
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-sky-500 focus:ring-sky-500"
              checked={saveAsDefault}
              onChange={(event) => setSaveAsDefault(event.target.checked)}
            />
            Save these values as the default run configuration for this script.
          </label>

          {error && (
            <div className="rounded border border-rose-500/60 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
              {error}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded border border-slate-600 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-300 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="button-run rounded border px-4 py-2 text-xs font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed"
            >
              {isSubmitting ? "Running..." : "Run Script"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
