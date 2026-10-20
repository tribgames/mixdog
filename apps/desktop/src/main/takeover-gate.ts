/**
 * Take over: while any session waits on a `takeover` request (ask_user
 * handoff), the user has the desktop. The request is held as a human-only
 * approval (human-only-approval.ts), so Computer Use refuses new operations
 * (beginComputerOperation) and Browser Use refuses new commands
 * (assertNoHumanOnlyApproval) until the user answers "done" or denies and the
 * request leaves the session snapshot.
 */
import { withHumanOnlyApproval } from './human-only-approval';

interface TakeoverSnapshotUpdate {
  sessionId?: string;
  snapshot?: unknown;
}

type Deferred = { promise: Promise<boolean>; resolve: (ready: boolean) => void };
const deferred = (): Deferred => {
  let resolve: (ready: boolean) => void = () => {};
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
/** How long a card may ask about a takeover the gate has not seen yet. */
const UNSEEN_READY_MS = 30_000;

export function createTakeoverGate(hold: typeof withHumanOnlyApproval = withHumanOnlyApproval) {
  /** sessionId → the takeover held and its release. */
  const held = new Map<string, { id: string; release: () => void }>();
  /** `${sessionId}\0${id}` → human control ready (true) or never (false). */
  const readiness = new Map<string, Deferred>();
  const readyOf = (key: string): Deferred => {
    let entry = readiness.get(key);
    if (!entry) {
      entry = deferred();
      readiness.set(key, entry);
    }
    return entry;
  };
  /** In-flight Browser Use commands: a takeover suppresses (aborts) and drains them. */
  const operations = new Set<AbortController>();
  // Every drain in flight waits here (two sessions can take over together).
  const drainWaiters = new Set<() => void>();
  const drainOperations = async (): Promise<void> => {
    for (const operation of operations) operation.abort(new Error('Browser Use stopped: the user took over'));
    while (operations.size > 0) {
      await new Promise<void>((resolve) => {
        drainWaiters.add(resolve);
      });
    }
  };
  const release = (sessionId: string): void => {
    const entry = held.get(sessionId);
    entry?.release();
    held.delete(sessionId);
    if (entry) {
      readiness.get(`${sessionId}\0${entry.id}`)?.resolve(false);
      readiness.delete(`${sessionId}\0${entry.id}`);
    }
  };
  return {
    /** Returns the surface ('browser' | 'computer') of a takeover that starts
     *  with this update, else ''. */
    onSessionState(update: TakeoverSnapshotUpdate): string {
      const sessionId = String(update?.sessionId || '');
      if (!sessionId || !update.snapshot) return '';
      const approval = (
        update.snapshot as {
          toolApproval?: { id?: unknown; kind?: unknown; takeover?: { surface?: unknown } | null } | null;
        }
      ).toolApproval;
      const takeoverId = approval?.kind === 'takeover' ? String(approval.id ?? 'takeover') : '';
      if (held.get(sessionId)?.id === takeoverId) return '';
      release(sessionId);
      if (!takeoverId) return '';
      let done: () => void = () => {};
      const finished = new Promise<void>((resolve) => {
        done = resolve;
      });
      held.set(sessionId, { id: takeoverId, release: done });
      const ready = readyOf(`${sessionId}\0${takeoverId}`);
      // Human control is ready once new commands are refused (held above),
      // Computer Use operations drained (hold enters) and in-flight Browser
      // Use commands aborted and drained: no agent capture lands after it.
      void hold(async () => {
        await drainOperations();
        if (held.get(sessionId)?.id === takeoverId) ready.resolve(true);
        await finished;
      }).catch(() => ready.resolve(false));
      return String(approval?.takeover?.surface || '');
    },
    /** Resolves true once the user may act on takeover `id` of `sessionId`,
     *  false when it ends first (or is never seen). */
    ready(sessionId: string, id: string): Promise<boolean> {
      const key = `${sessionId}\0${id}`;
      const entry = readyOf(key);
      if (!held.has(sessionId) || held.get(sessionId)?.id !== id) {
        setTimeout(() => {
          if (readiness.get(key) === entry && held.get(sessionId)?.id !== id) {
            entry.resolve(false);
            readiness.delete(key);
          }
        }, UNSEEN_READY_MS).unref?.();
      }
      return entry.promise;
    },
    pending(): number {
      return held.size;
    },
    /** Browser Use admits no agent command while a takeover is pending. */
    assertFree(): void {
      if (held.size > 0) throw new Error('Browser Use is blocked while the user has taken over; wait for "done"');
    },
    /** One Browser Use command: refused during a takeover, else counted until
     *  `release`; a takeover that starts meanwhile aborts its `signal`. */
    beginOperation(): { signal: AbortSignal; release: () => void } {
      if (held.size > 0) throw new Error('Browser Use is blocked while the user has taken over; wait for "done"');
      const controller = new AbortController();
      operations.add(controller);
      return {
        signal: controller.signal,
        release: () => {
          operations.delete(controller);
          if (operations.size === 0) {
            for (const waiter of drainWaiters) waiter();
            drainWaiters.clear();
          }
        },
      };
    },
    dispose(): void {
      for (const sessionId of [...held.keys()]) release(sessionId);
    },
  };
}

/** The window process's one gate (fed by index.ts, checked by the browser runner). */
export const takeoverGate = createTakeoverGate();
