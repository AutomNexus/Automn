import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const NotificationDialogContext = createContext({
  confirm: async () => false,
  alert: async () => {},
});

const TONE_STYLES = {
  info: {
    icon: "i",
    iconClasses:
      "text-sky-200 border-sky-500/50 bg-sky-500/10",
    confirmClasses:
      "border border-sky-500/50 bg-sky-500/20 text-sky-100 hover:bg-sky-500/30 focus:ring-sky-500/60",
  },
  success: {
    icon: "✓",
    iconClasses:
      "text-emerald-200 border-emerald-500/50 bg-emerald-500/10",
    confirmClasses:
      "border border-emerald-500/50 bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30 focus:ring-emerald-500/60",
  },
  warn: {
    icon: "!",
    iconClasses:
      "text-amber-200 border-amber-500/50 bg-amber-500/10",
    confirmClasses:
      "border border-amber-500/60 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30 focus:ring-amber-500/60",
  },
  danger: {
    icon: "!",
    iconClasses:
      "text-rose-200 border-rose-500/50 bg-rose-500/10",
    confirmClasses:
      "border border-rose-500/60 bg-rose-500/20 text-rose-100 hover:bg-rose-500/30 focus:ring-rose-500/60",
  },
};

const DEFAULT_DIALOG = {
  id: 0,
  mode: "confirm",
  title: "Are you sure?",
  message: "",
  tone: "info",
  confirmLabel: "Confirm",
  cancelLabel: "Cancel",
  resolve: () => {},
};

export function useNotificationDialog() {
  return useContext(NotificationDialogContext);
}

export default function NotificationDialogProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const confirmButtonRef = useRef(null);

  const closeDialog = useCallback((result, overrideMode) => {
    setDialog((current) => {
      if (!current) return null;
      const mode = overrideMode || current.mode;
      if (typeof current.resolve === "function") {
        if (mode === "confirm") {
          current.resolve(Boolean(result));
        } else {
          current.resolve();
        }
      }
      return null;
    });
  }, []);

  const openDialog = useCallback((options) => {
    return new Promise((resolve) => {
      const toneKey =
        options && typeof options.tone === "string"
          ? options.tone.toLowerCase()
          : undefined;

      setDialog({
        ...DEFAULT_DIALOG,
        ...options,
        id: Date.now(),
        tone: toneKey && TONE_STYLES[toneKey] ? toneKey : DEFAULT_DIALOG.tone,
        confirmLabel:
          options.mode === "alert"
            ? options.confirmLabel || "OK"
            : options.confirmLabel || DEFAULT_DIALOG.confirmLabel,
        cancelLabel:
          options.mode === "alert" ? null : options.cancelLabel || DEFAULT_DIALOG.cancelLabel,
        resolve,
      });
    });
  }, []);

  const confirm = useCallback(
    (options = {}) => {
      return openDialog({ ...options, mode: "confirm" });
    },
    [openDialog],
  );

  const alert = useCallback(
    (options = {}) => {
      return openDialog({ ...options, mode: "alert" }).then(() => {});
    },
    [openDialog],
  );

  useEffect(() => {
    if (!dialog) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [dialog]);

  useEffect(() => {
    if (!dialog) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (dialog.mode === "alert") {
          closeDialog(true, "alert");
        } else {
          closeDialog(false, "confirm");
        }
      } else if (event.key === "Enter" && !event.isComposing) {
        if (event.target && event.target.tagName === "TEXTAREA") {
          return;
        }
        event.preventDefault();
        closeDialog(true, dialog.mode);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [dialog, closeDialog]);

  useEffect(() => {
    if (!dialog) return undefined;
    const timeout = requestAnimationFrame(() => {
      confirmButtonRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(timeout);
  }, [dialog]);

  const value = useMemo(
    () => ({
      confirm,
      alert,
    }),
    [alert, confirm],
  );

  const tone = dialog?.tone && TONE_STYLES[dialog.tone] ? TONE_STYLES[dialog.tone] : TONE_STYLES.info;
  const titleId = dialog ? `notification-dialog-title-${dialog.id}` : undefined;
  const descriptionId = dialog?.message ? `notification-dialog-description-${dialog.id}` : undefined;

  return (
    <NotificationDialogContext.Provider value={value}>
      {children}
      {dialog ? (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center px-4">
          <div
            className="absolute inset-0 bg-slate-950/80"
            aria-hidden="true"
            onClick={() => {
              if (dialog.mode === "alert") {
                closeDialog(true, "alert");
              } else {
                closeDialog(false, "confirm");
              }
            }}
          />
          <div
            role={dialog.mode === "alert" ? "alertdialog" : "dialog"}
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            className="relative z-[1001] w-full max-w-md overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-2xl"
          >
            <div className="flex flex-col items-center gap-4 px-6 py-6 text-center">
              <div
                className={`flex h-14 w-14 items-center justify-center rounded-full border text-2xl font-semibold uppercase ${tone.iconClasses}`}
                aria-hidden="true"
              >
                {tone.icon}
              </div>
              <div className="space-y-2">
                <h2 id={titleId} className="text-lg font-semibold text-slate-100">
                  {dialog.title}
                </h2>
                {dialog.message ? (
                  <p
                    id={descriptionId}
                    className="text-sm text-slate-300"
                  >
                    {dialog.message}
                  </p>
                ) : null}
                {dialog.details ? (
                  <div className="max-h-48 overflow-y-auto rounded border border-slate-800 bg-slate-950/40 p-3 text-left text-xs text-slate-300">
                    {dialog.details}
                  </div>
                ) : null}
              </div>
              <div className="flex w-full flex-col gap-3 sm:flex-row sm:justify-center">
                {dialog.mode === "confirm" ? (
                  <button
                    type="button"
                    onClick={() => closeDialog(false, "confirm")}
                    className="w-full rounded border border-slate-700 px-4 py-2 text-sm font-semibold uppercase tracking-wide text-slate-300 transition-colors hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-600/60 sm:w-auto"
                  >
                    {dialog.cancelLabel}
                  </button>
                ) : null}
                <button
                  type="button"
                  ref={confirmButtonRef}
                  onClick={() => closeDialog(true, dialog.mode)}
                  className={`w-full rounded px-4 py-2 text-sm font-semibold uppercase tracking-wide text-slate-100 transition-colors focus:outline-none focus:ring-2 ${tone.confirmClasses} sm:w-auto`}
                >
                  {dialog.confirmLabel}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </NotificationDialogContext.Provider>
  );
}
