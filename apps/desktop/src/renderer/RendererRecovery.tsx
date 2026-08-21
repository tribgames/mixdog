import React, { Component, type ErrorInfo, type ReactNode } from "react";

import type { DesktopRendererFailureDiagnostic } from "../shared/contract";
import { ProgressSpinner, WindowLoadingMark } from "./ProgressSpinner";

type RendererFailurePhase = DesktopRendererFailureDiagnostic["phase"];
type RendererFailureLocation = {
  source?: unknown;
  line?: unknown;
  column?: unknown;
  components?: unknown;
  /** Explicit classification for a caller that already knows what broke; the
   *  message-derived code stands in when it is absent. */
  failureCode?: string;
};

let lastFingerprint = "";
let lastReportedAt = 0;

export function isResizeObserverDeliveryWarning(error: unknown, message: unknown): boolean {
  return !error && message === "ResizeObserver loop completed with undelivered notifications.";
}

export function isMonacoRestoreCancellation(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") return false;
  const value = reason as {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
    constructor?: { name?: unknown };
  };
  const name = String(value.name || "");
  const constructorName = String(value.constructor?.name || "");
  const message = String(value.message || "");
  const stack = String(value.stack || "");
  return (name === "Canceled" || constructorName === "CancellationError")
    && message === "Canceled"
    && stack.includes("Delayer.cancel")
    && stack.includes("restoreViewState");
}

function errorName(reason: unknown): string {
  if (reason instanceof Error && reason.name) return reason.name;
  if (reason && typeof reason === "object" && "name" in reason) {
    return String((reason as { name?: unknown }).name || "Error");
  }
  return typeof reason === "string" ? "Error" : "Unknown";
}

function rendererFailureFingerprint(reason: unknown): string {
  const text = reason instanceof Error
    ? `${reason.name}\n${reason.message}\n${reason.stack || ""}`
    : String(reason ?? "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sourceName(value: unknown): string | undefined {
  const text = String(value || "").split(/[?#]/, 1)[0];
  if (!text) return undefined;
  const name = text.split(/[\\/]/).at(-1)?.trim();
  return name ? name.slice(0, 120) : undefined;
}

function rendererFailureCode(reason: unknown): string | undefined {
  const message = reason instanceof Error ? reason.message : String(reason ?? "");
  if (/Objects are not valid as a React child|Minified React error #31\b/i.test(message)) {
    return "react-invalid-child";
  }
  if (/Element type is invalid|Minified React error #130\b/i.test(message)) {
    return "react-invalid-element";
  }
  if (/ChunkLoadError|Loading chunk \S+ failed|Failed to fetch dynamically imported module/i.test(message)) {
    return "chunk-load";
  }
  return undefined;
}

function componentNames(value: unknown): string[] | undefined {
  const components = String(value || "")
    .split("\n")
    .map((line) => line.trim().match(/^at\s+([A-Za-z][A-Za-z0-9_.$:-]{0,79})/)?.[1] || "")
    .filter(Boolean)
    .slice(0, 12);
  return components.length ? components : undefined;
}

export function reportRendererFailure(
  phase: RendererFailurePhase,
  reason: unknown,
  location: RendererFailureLocation = {},
): void {
  const fingerprint = rendererFailureFingerprint(reason);
  const now = Date.now();
  if (fingerprint === lastFingerprint && now - lastReportedAt < 1_000) return;
  lastFingerprint = fingerprint;
  lastReportedAt = now;
  const diagnostic: DesktopRendererFailureDiagnostic = {
    phase,
    errorName: errorName(reason).slice(0, 80),
    fingerprint,
  };
  const failureCode = location.failureCode || rendererFailureCode(reason);
  const components = Array.isArray(location.components)
    ? location.components.slice(0, 12).map(String)
    : componentNames(location.components);
  if (failureCode) diagnostic.failureCode = failureCode;
  if (components?.length) diagnostic.components = components;
  const source = sourceName(location.source);
  if (source) diagnostic.source = source;
  if (Number.isFinite(Number(location.line))) diagnostic.line = Math.max(0, Math.floor(Number(location.line)));
  if (Number.isFinite(Number(location.column))) diagnostic.column = Math.max(0, Math.floor(Number(location.column)));
  try {
    window.mixdogDesktop?.rendererDiagnostic?.(diagnostic);
  } catch {
    // Diagnostics must never become a second renderer failure.
  }
}

export function installGlobalRendererDiagnostics(): () => void {
  type DiagnosticsHost = Window & {
    __mixdogLongTaskObserver?: PerformanceObserver;
  };
  const host = window as DiagnosticsHost;
  let longTaskObserver: PerformanceObserver | undefined;
  let lastLongTaskDiagnosticAt = 0;
  try {
    // One observer per renderer, not one per mounted conversation pane.
    // Split panes otherwise report and process the same browser entry N times.
    host.__mixdogLongTaskObserver?.disconnect();
    if (typeof PerformanceObserver !== "undefined") {
      longTaskObserver = new PerformanceObserver((list) => {
        let peakDurationMs = 0;
        for (const entry of list.getEntries()) {
          if (entry.duration >= 50) {
            window.mixdogDesktop?.perfLog?.(
              `renderer-longtask ms=${Math.round(entry.duration)} start=${Math.round(entry.startTime)}`,
            );
          }
          peakDurationMs = Math.max(peakDurationMs, entry.duration);
        }
        const now = Date.now();
        if (peakDurationMs >= 250 && now - lastLongTaskDiagnosticAt >= 5_000) {
          lastLongTaskDiagnosticAt = now;
          window.mixdogDesktop?.rendererDiagnostic?.({
            kind: "long-task",
            durationMs: Math.round(peakDurationMs),
          });
        }
      });
      longTaskObserver.observe({ entryTypes: ["longtask"] });
      host.__mixdogLongTaskObserver = longTaskObserver;
    }
  } catch {
    longTaskObserver = undefined;
  }
  const onError = (event: ErrorEvent) => {
    if (isResizeObserverDeliveryWarning(event.error, event.message)) {
      window.mixdogDesktop?.perfLog?.("renderer-resize-observer-delivery-warning");
      return;
    }
    reportRendererFailure("window-error", event.error || event.message, {
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (isMonacoRestoreCancellation(event.reason)) {
      event.preventDefault();
      window.mixdogDesktop?.perfLog?.("renderer-monaco-restore-cancelled");
      return;
    }
    reportRendererFailure("unhandled-rejection", event.reason);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    longTaskObserver?.disconnect();
    if (host.__mixdogLongTaskObserver === longTaskObserver) {
      delete host.__mixdogLongTaskObserver;
    }
  };
}

export function DesktopLoadingSurface({
  label,
  overlay = false,
  brand = false,
  className = "",
}: {
  label: string;
  overlay?: boolean;
  brand?: boolean;
  /** Lets a caller dress the cover as the surface it is standing in for. */
  className?: string;
}) {
  return <div className={`desktop-loading-surface${
      brand ? "" : " desktop-loading-surface--delayed"
    }${overlay ? " desktop-loading-surface--overlay" : ""}${
      className ? ` ${className}` : ""
    }`}
    role="status" aria-live="polite" aria-label={label}>
    {brand
      ? <WindowLoadingMark size={40} aria-hidden="true" />
      : <ProgressSpinner size={24} className="desktop-loading-spinner" aria-hidden="true" />}
  </div>;
}

export class DesktopErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; retryKey: number }
> {
  state = { failed: false, retryKey: 0 };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportRendererFailure("boundary", error, { components: info.componentStack });
    console.error("Desktop renderer recovered from an uncaught render error.", error);
  }

  private retry = () => {
    this.setState((state) => ({ failed: false, retryKey: state.retryKey + 1 }));
  };

  private reload = () => {
    try {
      window.location.reload();
    } catch {
      this.retry();
    }
  };

  render() {
    if (this.state.failed) {
      return <main className="desktop-recovery-screen" role="alert">
        <section className="desktop-recovery-card">
          <span className="desktop-recovery-mark" aria-hidden="true">!</span>
          <h1>Mixdog could not draw this view</h1>
          <p>Your active task is still running in the desktop host. Retry the view or reload the interface.</p>
          <div className="desktop-recovery-actions">
            <button type="button" onClick={this.retry}>Try again</button>
            <button type="button" className="primary" onClick={this.reload}>Reload interface</button>
          </div>
        </section>
      </main>;
    }
    return <React.Fragment key={this.state.retryKey}>{this.props.children}</React.Fragment>;
  }
}
