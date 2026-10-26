/**
 * Which worker serves each session, and the requests in flight on them: their
 * dispatch, replies, timeouts, and the retirement of a worker together with
 * everything it still owed. Background input whose release a retirement or
 * reply left unproven is latched here until the user acknowledges it.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { recordCursorDiagnostic } from '../overlay/cursor-diagnostics';
import type { PowerShellResponse } from '../shared/types';
import { captureCleanup } from '../shared/capture-attempts';

/** Per-command ceiling for the PowerShell host round trip. */
export const COMMAND_TIMEOUT_MS = 45_000;

/** One in-flight worker request, from dispatch to its reply, timeout or the
 *  retirement of the worker that owns it. */
export interface PendingWorkerRequest {
  resolve: (r: PowerShellResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  child: ChildProcessWithoutNullStreams;
  sessionId: string;
  pointerFeedback: boolean;
  windowId?: string;
  mode: 'background' | 'foreground';
  input: boolean;
  backgroundPressRelease: boolean;
}

/** What the pool knows about a request when it dispatches it. */
export type WorkerRequestTraits = Omit<PendingWorkerRequest, 'resolve' | 'reject' | 'timer' | 'child'>;

export function createWorkerRequests(
  onSessionRetired?: (sessionId: string, child: ChildProcessWithoutNullStreams, interruptedInput: boolean) => void
) {
  const pending = new Map<number, PendingWorkerRequest>();
  const powerShellBySession = new Map<string, ChildProcessWithoutNullStreams>();
  const workerLastUsedAt = new Map<string, number>();
  // A killed message sender has no receipt proving that its finally block ran.
  // Keep this uncertainty latched even after the child and observation are gone.
  const unconfirmedBackgroundSessions = new Set<string>();

  function retire(child: ChildProcessWithoutNullStreams, error: Error): void {
    const retiredSessionIds: string[] = [];
    let interruptedInput = false;
    for (const [sessionId, activeChild] of powerShellBySession) {
      if (activeChild !== child) continue;
      powerShellBySession.delete(sessionId);
      workerLastUsedAt.delete(sessionId);
      retiredSessionIds.push(sessionId);
    }
    for (const [id, entry] of pending) {
      if (entry.child !== child) continue;
      if (entry.input) {
        interruptedInput = true;
        // An uncertain mutation is not necessarily an unacknowledged key/button
        // release. Semantic actions and WM_CHAR alone cannot leave one held.
        if (entry.mode === 'background' && entry.backgroundPressRelease) {
          unconfirmedBackgroundSessions.add(entry.sessionId);
        }
      }
      clearTimeout(entry.timer);
      entry.reject(error);
      pending.delete(id);
    }
    if (!child.killed && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        /* exit confirmation belongs to the lifecycle */
      }
    }
    for (const sessionId of retiredSessionIds) {
      try {
        onSessionRetired?.(sessionId, child, interruptedInput);
      } catch {
        /* failed cleanup stays latched */
      }
    }
  }

  function handleReply(json: string, child: ChildProcessWithoutNullStreams): void {
    let parsed: PowerShellResponse;
    try {
      parsed = JSON.parse(json) as PowerShellResponse;
    } catch {
      return;
    }
    const entry = pending.get(parsed.id);
    if (!entry || entry.child !== child) return;
    if (entry.input && entry.mode === 'background' && /input_cleanup_unconfirmed/.test(String(parsed.error || ''))) {
      unconfirmedBackgroundSessions.add(entry.sessionId);
    }
    const feedback = (
      parsed as PowerShellResponse & {
        pointer_feedback?: { generated: number; failed: number };
      }
    ).pointer_feedback;
    if (entry.pointerFeedback) {
      recordCursorDiagnostic('tracked_requests');
      if (feedback) {
        recordCursorDiagnostic('source_generated', feedback.generated);
        recordCursorDiagnostic('source_failed', feedback.failed);
      } else recordCursorDiagnostic('source_summary_missing');
    }
    clearTimeout(entry.timer);
    pending.delete(parsed.id);
    const cleanup = captureCleanup(parsed.result?.capture_cleanup);
    if (!entry.input && cleanup && cleanup.status !== 'confirmed') {
      // Unpublish before resolving: a caller may issue its next request before
      // the worker's exit event arrives. Preserve this reply's original cause.
      retire(child, new Error('capture_cleanup_unconfirmed: capture worker must retire'));
    }
    entry.resolve(parsed);
  }

  /** Writes one request line to `child` and settles on its reply, the clamped
   *  command timeout, or the worker's retirement. */
  function dispatch(
    child: ChildProcessWithoutNullStreams,
    id: number,
    line: string,
    traits: WorkerRequestTraits,
    timeoutMs: number
  ): Promise<PowerShellResponse> {
    const commandTimeoutMs = Number.isFinite(timeoutMs)
      ? Math.max(50, Math.min(COMMAND_TIMEOUT_MS, Math.round(timeoutMs)))
      : COMMAND_TIMEOUT_MS;
    return new Promise<PowerShellResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        retire(
          child,
          new Error(`computer_command_timeout: command exceeded ${commandTimeoutMs}ms; the input host was restarted`)
        );
      }, commandTimeoutMs);
      pending.set(id, { resolve, reject, timer, child, ...traits });
      try {
        child.stdin.write(line);
      } catch (error) {
        retire(child, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  return {
    powerShellBySession,
    workerLastUsedAt,
    inFlight: () => pending.size,
    /** Only this worker's own requests: a reused id from a retired worker
     *  names a request this worker's output knows nothing about. */
    requestOf(id: unknown, child: ChildProcessWithoutNullStreams): PendingWorkerRequest | undefined {
      const entry = pending.get(id as number);
      return entry?.child === child ? entry : undefined;
    },
    retire,
    handleReply,
    dispatch,
    hasUnconfirmedBackgroundInput: (sessionId?: string) =>
      sessionId === undefined ? unconfirmedBackgroundSessions.size > 0 : unconfirmedBackgroundSessions.has(sessionId),
    clearUnconfirmedBackgroundInput(): void {
      unconfirmedBackgroundSessions.clear();
    },
  };
}
