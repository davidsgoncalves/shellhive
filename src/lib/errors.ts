import { invoke } from "@tauri-apps/api/core";

/** Sends an error to the backend, which logs it and, if allowed, reports it. */
export function reportError(source: string, err: unknown): void {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  void invoke("report_error", { source, message }).catch(() => {});
}

/** Catches what nothing else handled in this window. */
export function watchUncaughtErrors(): void {
  window.addEventListener("error", (e) => {
    // The browser's note that a resize handler changed layout; it retries on
    // the next frame and nothing is lost.
    if (/ResizeObserver loop/.test(String(e.message))) return;
    reportError("ui", e.error ?? e.message);
  });
  window.addEventListener("unhandledrejection", (e) => reportError("ui", e.reason));
}

export interface ReportsState {
  enabled: boolean;
  available: boolean;
}
