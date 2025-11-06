import { useState, useEffect, useRef, useCallback } from "react";
import { apiRequest } from "../utils/api";
import { useNotificationDialog } from "./NotificationDialogProvider";

export default function ScriptTokenManager({
  script,
  currentUser,
  onTokenChanged,
  onAuthError,
  disabled = false,
}) {
  const { confirm } = useNotificationDialog();
  const [isRevealed, setIsRevealed] = useState(false);
  const [revealedToken, setRevealedToken] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [copyMessage, setCopyMessage] = useState("");
  const copyTimeoutRef = useRef(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setIsRevealed(false);
    setRevealedToken(null);
    setErrorMessage(null);
    setCopyMessage("");
    setIsLoading(false);
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
  }, [script?.id]);

  useEffect(() => {
    if (!disabled) {
      return;
    }

    setIsRevealed(false);
    setCopyMessage("");
    setRevealedToken(null);
    setErrorMessage(null);
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
  }, [disabled]);

  const maskedToken = script?.hasApiToken
    ? script.apiTokenPreview || "••••••••"
    : "Not configured";

  const handleRevealToggle = useCallback(async () => {
    if (!script?.id || !currentUser?.isAdmin) return;
    if (disabled || isLoading) return;
    if (isRevealed) {
      setIsRevealed(false);
      setErrorMessage(null);
      setCopyMessage("");
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
      return;
    }

    if (revealedToken) {
      setIsRevealed(true);
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    setCopyMessage("");
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
    try {
      const data = await apiRequest(
        `/api/scripts/${encodeURIComponent(script.id)}/token`,
      );
      const token = data?.token || null;
      const hasToken = Boolean(token ?? data?.hasToken);
      if (hasToken && token) {
        setRevealedToken(token);
      } else {
        setRevealedToken(null);
      }
      setIsRevealed(hasToken);
      onTokenChanged?.(script.id, {
        hasApiToken: hasToken,
        apiTokenPreview: hasToken
          ? data?.preview || data?.apiTokenPreview || maskedToken
          : null,
      });
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
        return;
      }
      setErrorMessage(err?.data?.error || err.message || "Failed to load token");
    } finally {
      setIsLoading(false);
    }
  }, [
    script?.id,
    currentUser?.isAdmin,
    isRevealed,
    revealedToken,
    onTokenChanged,
    onAuthError,
    maskedToken,
    isLoading,
    disabled,
  ]);

  const handleRotate = useCallback(async () => {
    if (!script?.id || !currentUser?.isAdmin) return;
    if (disabled || isLoading) return;
    const confirmed = await confirm({
      title: "Rotate script token?",
      message:
        "Rotate this script's bearer token? Existing integrations will need the new token.",
      tone: "warn",
      confirmLabel: "Rotate token",
    });
    if (!confirmed) {
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    try {
      const data = await apiRequest(
        `/api/scripts/${encodeURIComponent(script.id)}/token/rotate`,
        { method: "POST" },
      );
      const token = data?.token || null;
      const hasToken = Boolean(token ?? data?.hasToken);
      if (hasToken && token) {
        setRevealedToken(token);
      } else {
        setRevealedToken(null);
      }
      setIsRevealed(hasToken);
      onTokenChanged?.(script.id, {
        hasApiToken: hasToken,
        apiTokenPreview: hasToken ? data?.preview || data?.apiTokenPreview || null : null,
      });
      if (!hasToken) {
        setErrorMessage("Token rotation failed to provide a new token.");
      }
    } catch (err) {
      if (onAuthError && (err.status === 401 || err.status === 403)) {
        onAuthError(err);
        return;
      }
      setErrorMessage(err?.data?.error || err.message || "Failed to rotate token");
    } finally {
      setIsLoading(false);
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
      setCopyMessage("");
    }
  }, [
    script?.id,
    currentUser?.isAdmin,
    onTokenChanged,
    onAuthError,
    isLoading,
    disabled,
    confirm,
  ]);

  const handleCopy = useCallback(async () => {
    if (!revealedToken || disabled) return;
    try {
      if (
        typeof navigator === "undefined" ||
        !navigator.clipboard ||
        typeof navigator.clipboard.writeText !== "function"
      ) {
        throw new Error("Clipboard unavailable");
      }
      await navigator.clipboard.writeText(revealedToken);
      setCopyMessage("Copied!");
    } catch (err) {
      setCopyMessage("Copy failed");
    }
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }
    copyTimeoutRef.current = setTimeout(() => {
      setCopyMessage("");
    }, 2000);
  }, [revealedToken, disabled]);

  if (!currentUser?.isAdmin || !script?.id) {
    return null;
  }

  const displayToken = isRevealed
    ? revealedToken || "(no token assigned)"
    : maskedToken;

  const containerClasses = `rounded-md border p-4 text-sm transition-opacity ${
    disabled ? "pointer-events-none opacity-50" : ""
  }`;
  const containerStyle = {
    borderColor: "var(--color-panel-border)",
    background: "var(--color-surface-1)",
    color: "var(--color-app-text)",
    boxShadow: "var(--color-panel-shadow)",
  };
  const actionDisabled = disabled || isLoading;

  return (
    <div
      className={containerClasses}
      aria-disabled={disabled}
      style={containerStyle}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-[color:var(--color-accent)]">
            Script API Token
          </h3>
          <p className="text-xs text-[color:var(--color-text-muted)]">
            Include this value in the <code>Authorization</code> header as <code>Bearer TOKEN</code>.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              handleRevealToggle();
            }}
            disabled={actionDisabled}
            className="rounded border px-3 py-1 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-strong)] transition hover:bg-[color:var(--color-surface-3)] disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              borderColor: "var(--color-panel-border)",
              background: "var(--color-surface-2)",
            }}
          >
            {isRevealed ? "Hide" : "Reveal"}
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              handleRotate();
            }}
            disabled={actionDisabled}
            className="rounded border px-3 py-1 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-accent)] transition hover:bg-[color:var(--color-accent-soft)] disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              borderColor: "var(--color-accent-strong)",
              background: "var(--color-surface-1)",
            }}
          >
            Rotate
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <code
          className="rounded px-2 py-1 text-base font-mono"
          style={{
            background: "var(--color-token-chip-bg)",
            color: "var(--color-token-chip-text)",
            border: "1px solid var(--color-token-chip-border)",
            boxShadow: "var(--color-token-chip-shadow)",
            wordBreak: "break-all",
          }}
        >
          {displayToken}
        </code>
        {isRevealed && revealedToken && (
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              handleCopy();
            }}
            disabled={disabled}
            className="rounded border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-strong)] transition hover:bg-[color:var(--color-surface-3)] disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              borderColor: "var(--color-panel-border)",
              background: "var(--color-surface-2)",
            }}
          >
            Copy
          </button>
        )}
        {copyMessage && (
          <span className="text-xs text-[color:var(--color-text-muted)]">
            {copyMessage}
          </span>
        )}
      </div>

      <div
        className="mt-3 rounded border px-3 py-2 font-mono text-xs"
        style={{
          borderColor: "var(--color-panel-border)",
          background: "var(--color-surface-2)",
          color: "var(--color-text-muted)",
        }}
      >
        <div>
          Authorization: Bearer {isRevealed ? revealedToken || "<token>" : maskedToken}
        </div>
      </div>

      {errorMessage && (
        <div className="mt-3 rounded border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {errorMessage}
        </div>
      )}
    </div>
  );
}
