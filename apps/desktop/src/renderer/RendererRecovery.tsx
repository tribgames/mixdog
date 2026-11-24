import React, { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { t } from './i18n';
import { scrimDismiss } from './scrim-dismiss';
// @ts-expect-error Shared runtime module is plain ESM.
import { safeErrorDetails } from '../../../../packages/protocol-client/src/rows/error-presentation.mjs';

import type { DesktopRendererFailureDiagnostic } from '../shared/contract';
import { ProgressSpinner, WindowLoadingMark } from './ProgressSpinner';
import { isRemoteBrowserRenderer } from './remote-ui-projection';

type RendererFailurePhase = DesktopRendererFailureDiagnostic['phase'];
type RendererFailureLocation = {
  source?: unknown;
  line?: unknown;
  column?: unknown;
  components?: unknown;
  /** Explicit classification for a caller that already knows what broke; the
   *  message-derived code stands in when it is absent. */
  failureCode?: string;
  /** The conversation the window had selected. */
  sessionId?: string | null;
};

const MAX_FRAMES = 40;

/** A frame with a position: `at name (location:line:column)` or `at location:line:column`. */
const POSITIONED_FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
/** React's frame of a component it knows no location of: `at Panel`. */
const NAMED_FRAME = /^\s*at\s+([A-Za-z_$][\w$]{0,79})\s*$/;
/** What a function's name in a frame may hold (`async fn`, `new Foo`, `Object.<anonymous>`, `fn [as alias]`). */
const FRAME_NAME = /^[\w$.<>[\] ]{1,80}$/;

function frames(lines: string, named: boolean): string[] {
  const found: string[] = [];
  for (const line of lines.split('\n')) {
    const positioned = line.match(POSITIONED_FRAME);
    if (positioned) {
      const [, name = '', location, row, column] = positioned;
      const file = sourceName(location) ?? '';
      found.push(`${FRAME_NAME.test(name.trim()) ? name.trim() : '<anonymous>'}@${file}:${row}:${column}`);
    } else if (named) {
      const component = line.match(NAMED_FRAME)?.[1];
      if (component) found.push(component);
    }
    if (found.length >= MAX_FRAMES) break;
  }
  return found;
}

/** An error's stack as frames `function@file:line:column`. Its header (`Name: message`, as many lines as the message runs to) is
 *  cut by the error's own text and never read, and every directory is left out: the record holds where the failure was, never
 *  what it said or whose files it was over. */
export function errorFrames(error: unknown): string[] {
  const stack = (error as { stack?: unknown } | null)?.stack;
  if (typeof stack !== 'string') return [];
  const header = error instanceof Error ? String(error) : '';
  return frames(header && stack.startsWith(header) ? stack.slice(header.length) : stack, false);
}

/** React's component stack as frames: `Component@file:line:column`, or the component's name where React knows no location. */
export function componentFrames(stack: unknown): string[] {
  return typeof stack === 'string' ? frames(stack, true) : [];
}

let lastFingerprint = '';
let lastReportedAt = 0;

function isResizeObserverDeliveryWarning(error: unknown, message: unknown): boolean {
  return !error && message === 'ResizeObserver loop completed with undelivered notifications.';
}

function isMonacoRestoreCancellation(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false;
  const value = reason as {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
    constructor?: { name?: unknown };
  };
  const name = String(value.name || '');
  const constructorName = String(value.constructor?.name || '');
  const message = String(value.message || '');
  const stack = String(value.stack || '');
  return (
    (name === 'Canceled' || constructorName === 'CancellationError') &&
    message === 'Canceled' &&
    stack.includes('Delayer.cancel') &&
    stack.includes('restoreViewState')
  );
}

function errorName(reason: unknown): string {
  if (reason instanceof Error && reason.name) return reason.name;
  if (reason && typeof reason === 'object' && 'name' in reason) {
    return String((reason as { name?: unknown }).name || 'Error');
  }
  return typeof reason === 'string' ? 'Error' : 'Unknown';
}

function rendererFailureFingerprint(reason: unknown): string {
  const text =
    reason instanceof Error ? `${reason.name}\n${reason.message}\n${reason.stack || ''}` : String(reason ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function sourceName(value: unknown): string | undefined {
  const text = String(value || '').split(/[?#]/, 1)[0];
  if (!text) return undefined;
  const name = text.split(/[\\/]/).at(-1)?.trim();
  return name ? name.slice(0, 120) : undefined;
}

function rendererFailureCode(reason: unknown): string | undefined {
  const message = reason instanceof Error ? reason.message : String(reason ?? '');
  if (/Objects are not valid as a React child|Minified React error #31\b/i.test(message)) {
    return 'react-invalid-child';
  }
  if (/Element type is invalid|Minified React error #130\b/i.test(message)) {
    return 'react-invalid-element';
  }
  if (/ChunkLoadError|Loading chunk \S+ failed|Failed to fetch dynamically imported module/i.test(message)) {
    return 'chunk-load';
  }
  return undefined;
}

function componentNames(value: unknown): string[] | undefined {
  const components = String(value || '')
    .split('\n')
    .map((line) => line.trim().match(/^at\s+([A-Za-z][A-Za-z0-9_.$:-]{0,79})/)?.[1] || '')
    .filter(Boolean)
    .slice(0, 12);
  return components.length ? components : undefined;
}

export function reportRendererFailure(
  phase: RendererFailurePhase,
  reason: unknown,
  location: RendererFailureLocation = {}
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
  // Where it failed, for a failure the user did not see as text: without the frames a fingerprint names nothing to look at.
  if (phase !== 'notice' && phase !== 'console') {
    const stack = errorFrames(reason);
    if (stack.length) diagnostic.stack = stack;
    const componentStack = componentFrames(location.components);
    if (componentStack.length) diagnostic.componentStack = componentStack;
  }
  if (location.sessionId) diagnostic.sessionId = location.sessionId.slice(0, 120);
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

const noticeReportedAt = new Map<string, number>();

/** Record an error the user actually saw. Toasts auto-dismiss and the bridge
 *  banner disappears the moment the daemon attaches, so without this the only
 *  witness to a startup failure is whoever happened to be looking. */
export function reportRendererNotice(text: unknown, options: { bridge?: boolean } = {}): void {
  const message = safeErrorDetails(text);
  if (!message) return;
  const fingerprint = rendererFailureFingerprint(message);
  const now = Date.now();
  const seenAt = noticeReportedAt.get(fingerprint) ?? 0;
  // The same banner re-mounts on every rerender; one line per occurrence is
  // the signal, a line per frame is noise.
  if (now - seenAt < 30_000) return;
  if (noticeReportedAt.size > 100) noticeReportedAt.clear();
  noticeReportedAt.set(fingerprint, now);
  try {
    window.mixdogDesktop?.rendererDiagnostic?.({
      phase: 'notice',
      errorName: options.bridge ? 'BridgeError' : 'ToastError',
      fingerprint,
      message,
    });
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
    if (typeof PerformanceObserver !== 'undefined') {
      longTaskObserver = new PerformanceObserver((list) => {
        let peakDurationMs = 0;
        for (const entry of list.getEntries()) {
          if (entry.duration >= 50) {
            window.mixdogDesktop?.perfLog?.(
              `renderer-longtask ms=${Math.round(entry.duration)} start=${Math.round(entry.startTime)}`
            );
          }
          peakDurationMs = Math.max(peakDurationMs, entry.duration);
        }
        const now = Date.now();
        if (peakDurationMs >= 250 && now - lastLongTaskDiagnosticAt >= 5_000) {
          lastLongTaskDiagnosticAt = now;
          window.mixdogDesktop?.rendererDiagnostic?.({
            kind: 'long-task',
            durationMs: Math.round(peakDurationMs),
          });
        }
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
      host.__mixdogLongTaskObserver = longTaskObserver;
    }
  } catch {
    longTaskObserver = undefined;
  }
  const onError = (event: ErrorEvent) => {
    if (isResizeObserverDeliveryWarning(event.error, event.message)) {
      window.mixdogDesktop?.perfLog?.('renderer-resize-observer-delivery-warning');
      return;
    }
    reportRendererFailure('window-error', event.error || event.message, {
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (isMonacoRestoreCancellation(event.reason)) {
      event.preventDefault();
      window.mixdogDesktop?.perfLog?.('renderer-monaco-restore-cancelled');
      return;
    }
    reportRendererFailure('unhandled-rejection', event.reason);
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
    longTaskObserver?.disconnect();
    if (host.__mixdogLongTaskObserver === longTaskObserver) {
      delete host.__mixdogLongTaskObserver;
    }
  };
}

/** The way out of a full-screen loading cover: Escape, the phone's back, a tap
 *  on the dim, or its own close button. */
function LoadingCancel({ onCancel }: { onCancel: () => void }) {
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelRef.current();
    };
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  }, []);
  return (
    <button type="button" className="desktop-loading-cancel" aria-label={t('Close')} onClick={onCancel}>
      <X size={16} aria-hidden="true" />
    </button>
  );
}

/** What the cover says while the core works before it serves: the conversion of the earlier version's data and the wait for the
 *  earlier version's daemon are long enough to need words; the index rebuild is its bar alone. */
function stageCaption(stage: string | undefined): string | null {
  if (stage === 'migration') return t('Updating your data from the earlier version of Mixdog…');
  if (stage === 'legacy') return t('Waiting for the earlier version of Mixdog to finish its running work and close…');
  return null;
}

function stageLabel(stage: string | undefined): string {
  if (stage === 'migration') return t('Updating your data from the earlier version of Mixdog…');
  return t('Organizing your conversation history');
}

export function DesktopLoadingSurface({
  label,
  overlay = false,
  brand = false,
  delayed = !brand,
  className = '',
  onCancel,
  progress,
  caption,
}: {
  label: string;
  overlay?: boolean;
  brand?: boolean;
  /** What the core does before it serves, `done` of `total`: a thin bar under the brand mark, drawn only while it counts something,
   *  and a line saying what it is for a long stage (`stage`, the rebuild when absent). */
  progress?: { done: number; total: number; stage?: string } | null;
  /** A line under the brand mark (the cover's own state). */
  caption?: string;
  /** Hold the indicator invisible for the shared delay, so a warm/short load
   *  never flashes one. The cold-boot cover opts out: it owns the window from
   *  the first frame and has nothing to flash against. */
  delayed?: boolean;
  /** Lets a caller dress the cover as the surface it is standing in for. */
  className?: string;
  /** A cover that can sit over the whole screen while its view loads (a slow
   *  or stalled chunk) must never be a dead end: with this, it can be left. */
  onCancel?: () => void;
}) {
  return (
    <div
      className={`desktop-loading-surface${
        delayed ? ' desktop-loading-surface--delayed' : ''
      }${overlay ? ' desktop-loading-surface--overlay' : ''}${className ? ` ${className}` : ''}`}
      role="status"
      aria-live="polite"
      aria-label={label}
      {...(onCancel ? scrimDismiss(onCancel) : {})}
    >
      {onCancel && <LoadingCancel onCancel={onCancel} />}
      {brand ? (
        <WindowLoadingMark size={40} aria-hidden="true" />
      ) : (
        <ProgressSpinner size={24} className="desktop-loading-spinner" aria-hidden="true" />
      )}
      {brand && progress && progress.total > 0 && (
        <div
          className="desktop-loading-progress"
          role="progressbar"
          aria-label={stageLabel(progress.stage)}
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
        >
          <div
            className="desktop-loading-progress-fill"
            style={{ width: `${(progress.done / progress.total) * 100}%` }}
          />
        </div>
      )}
      {brand && (caption ?? stageCaption(progress?.stage)) && (
        <p className="desktop-loading-caption">{caption ?? stageCaption(progress?.stage)}</p>
      )}
    </div>
  );
}

/** The process a start is blocked on, as the failure card names it (main/core-port/boot-progress.ts `BootBlock`). */
interface BootBlockView {
  pid: number | null;
  image: string | null;
  commandLine: string | null;
  releasable: boolean;
  legacy: boolean;
  retireError: string | null;
  resolving: boolean;
  resolveError: string | null;
}

/** The card of a start blocked on another process: which process, why it matters, and the one action past it (the core's
 *  `release` for a process it could not prove to be Mixdog's; the earlier version's stop otherwise). The window attaches by
 *  itself once that process has gone: the action does not reload it. */
function BlockedStartCard({ blocked, message }: { blocked: BootBlockView; message: string }) {
  const process = [blocked.image, blocked.pid !== null ? t('process {{pid}}', { pid: blocked.pid }) : null]
    .filter(Boolean)
    .join(' · ');
  const detail = [message, blocked.commandLine, blocked.retireError].filter(Boolean).join('\n');
  const bridge = (window as { mixdogCorePort?: { retry?: () => Promise<void> } }).mixdogCorePort;
  return (
    <div className="desktop-loading-surface desktop-boot-failure" role="alert">
      <div className="desktop-boot-failure-card">
        <h2 className="desktop-boot-failure-title">
          {blocked.releasable ? t('Another program holds your Mixdog data') : t('An earlier Mixdog is still running')}
        </h2>
        <p className="desktop-boot-failure-body">
          {blocked.releasable
            ? t(
                'Mixdog cannot tell whether this program is an earlier Mixdog. If it is not, let Mixdog continue; if it is, close it first.'
              )
            : t(
                'It holds your Mixdog data, so this version cannot start beside it. Stop it to continue; whatever it is still running ends.'
              )}
        </p>
        {process && <p className="desktop-boot-failure-body">{process}</p>}
        {blocked.resolveError && <p className="desktop-boot-failure-body">{blocked.resolveError}</p>}
        <details className="desktop-boot-failure-details">
          <summary>{t('Error details')}</summary>
          <pre>{detail}</pre>
        </details>
        <button
          type="button"
          className="desktop-boot-failure-retry"
          disabled={blocked.resolving}
          onClick={() => void bridge?.retry?.()}
        >
          {blocked.releasable
            ? blocked.resolving
              ? t('Releasing…')
              : t('It is not Mixdog: continue')
            : blocked.resolving
              ? t('Stopping…')
              : t('Stop it and continue')}
        </button>
      </div>
    </div>
  );
}

/** The first screen of a window whose core cannot be started, never served, or ends at boot the same way each time: what happened in plain words, the
 *  cause on request, and a way to try again (the window loads again, which asks main to start the core once more). */
export function DesktopBootFailure({
  failure,
}: {
  failure: { message: string; stderrPath: string | null; blocked?: BootBlockView | null };
}) {
  if (failure.blocked) return <BlockedStartCard blocked={failure.blocked} message={failure.message} />;
  const detail = [failure.message, failure.stderrPath].filter(Boolean).join('\n');
  return (
    <div className="desktop-loading-surface desktop-boot-failure" role="alert">
      <div className="desktop-boot-failure-card">
        <h2 className="desktop-boot-failure-title">{t('Could not start')}</h2>
        <p className="desktop-boot-failure-body">{t('Try again, or close the app and reopen it.')}</p>
        <details className="desktop-boot-failure-details">
          <summary>{t('Error details')}</summary>
          <pre>{detail}</pre>
        </details>
        <button
          type="button"
          className="desktop-boot-failure-retry"
          onClick={() => {
            // Main launches the core again only once told to; then the window loads again and asks for it.
            const bridge = (window as { mixdogCorePort?: { retry?: () => Promise<void> } }).mixdogCorePort;
            void Promise.resolve(bridge?.retry?.()).finally(() => window.location.reload());
          }}
        >
          {t('Try again')}
        </button>
      </div>
    </div>
  );
}
/** What the recovery card says. Only a render failure reaches it (a lost
 *  connection is retried silently and never throws): on a paired phone (or
 *  any remote page) the work runs on the PC, not "the desktop host". */
function recoveryCopy(): { title: string; body: string } {
  if (!isRemoteBrowserRenderer()) {
    return {
      title: t('Could not draw this view'),
      body: t('Your active task is still running in the desktop host. Retry the view or reload the interface.'),
    };
  }
  return {
    title: t('Could not show this screen'),
    body: t('Your work continues on your PC. Retry this screen or reload the interface.'),
  };
}

/** The conversation the window has selected: its sidebar row. Read while the failed tree is still in the document. */
function selectedSessionId(): string | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector('.session-row.selected[data-session-id]')?.getAttribute('data-session-id') ?? null;
}

export class DesktopErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; retryKey: number; sessionId: string | null }
> {
  state = { failed: false, retryKey: 0, sessionId: null as string | null };

  static getDerivedStateFromError() {
    // By the time the failure is reported the recovery screen has replaced the tree, and the selected row with it.
    return { failed: true, sessionId: selectedSessionId() };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportRendererFailure('boundary', error, { components: info.componentStack, sessionId: this.state.sessionId });
    console.error('Desktop renderer recovered from an uncaught render error.', error);
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
      const copy = recoveryCopy();
      return (
        <main className="desktop-recovery-screen" role="alert">
          <section className="desktop-recovery-card">
            <span className="desktop-recovery-mark" aria-hidden="true">
              !
            </span>
            <h1>{copy.title}</h1>
            <p>{copy.body}</p>
            <div className="desktop-recovery-actions">
              <button type="button" onClick={this.retry}>
                {t('Retry')}
              </button>
              <button type="button" className="primary" onClick={this.reload}>
                {t('Reload interface')}
              </button>
            </div>
          </section>
        </main>
      );
    }
    return <React.Fragment key={this.state.retryKey}>{this.props.children}</React.Fragment>;
  }
}
