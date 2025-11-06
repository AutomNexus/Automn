import React from "react";

export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Automn UI crashed", error, errorInfo);
  }

  handleReload = () => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const message = this.state.error?.message || "An unexpected error occurred.";

    return (
      <div
        className="flex min-h-screen items-center justify-center px-4"
        style={{
          background: "var(--color-app-bg, #0f172a)",
          color: "var(--color-app-text, #e2e8f0)",
        }}
      >
        <div className="w-full max-w-lg space-y-6 rounded-lg border border-slate-800 bg-slate-950/80 p-6 shadow-2xl">
          <div className="space-y-2 text-center">
            <h1 className="text-xl font-semibold text-slate-100">Something went wrong</h1>
            <p className="text-sm text-slate-400">
              The Automn interface hit an unexpected error. You can try reloading the
              page or return to the previous screen.
            </p>
          </div>
          <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            {message}
          </div>
          <div className="flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={this.handleReset}
              className="rounded border border-slate-700 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-200 transition hover:bg-slate-800"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded border border-sky-500/60 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-sky-200 transition hover:bg-sky-500/20"
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
