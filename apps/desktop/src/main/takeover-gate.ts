/**
 * Take over: a session waiting on a `takeover` request (handoff_user) has
 * handed its page or step to the user. Only that session is held: its Browser
 * Use commands are refused (beginOperation, assertFree) and its in-flight ones
 * aborted and drained, until the user answers "done", denies, or the takeover
 * expires (TAKEOVER_EXPIRY_MS) and the request leaves the session snapshot.
 * Other sessions keep working on their own pages. A screen (Computer Use)
 * takeover also holds a human-only approval (human-only-approval.ts): there is
 * one screen, so Computer Use refuses new operations everywhere meanwhile. A
 * browser takeover never touches Computer Use.
 */
import { withHumanOnlyApproval } from './human-only-approval';

interface TakeoverSnapshotUpdate {
  sessionId?: string;
  snapshot?: unknown;
}

/** A takeover nobody finishes ends on its own after this long, settled with
 *  reason 'expired' (the runtime's handoff_user maps exactly that string). */
export const TAKEOVER_EXPIRY_MS = 15 * 60_000;
export const TAKEOVER_EXPIRED_REASON = 'expired';

interface TakeoverRequest {
  surface?: unknown;
  purpose?: unknown;
  url?: unknown;
  target?: unknown;
  instructions?: unknown;
}

/** What a takeover waits on, for refusals: the sign-in site, else its step. */
function takeoverStep(takeover: TakeoverRequest | null | undefined): string {
  if (takeover?.purpose === 'login' && typeof takeover.url === 'string') {
    try {
      return `sign-in on ${new URL(takeover.url).hostname}`;
    } catch {
      // Not a URL: describe it by its step below.
    }
  }
  const text = [takeover?.target, takeover?.instructions].find(
    (value): value is string => typeof value === 'string' && value.trim() !== ''
  );
  if (!text) return 'a step only the user can do';
  const step = text.trim().replace(/\s+/gu, ' ');
  return `step "${step.length > 160 ? `${step.slice(0, 157)}...` : step}"`;
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

interface HeldTakeover {
  id: string;
  /** What it waits on (takeoverStep). */
  step: string;
  /** Aborted when it ends (settled, expired, replaced): its hand-over, still
   *  queued for the screen or draining, gives up at once. */
  ended: AbortController;
  expiry: ReturnType<typeof setTimeout>;
}

const browserRefusal = (entry: HeldTakeover): Error =>
  new Error(
    `Browser Use is paused for this session: the user has taken over (${entry.step}) and was shown a card for it. ` +
      'Wait for the handoff_user result ("done", "denied" or "expired"); do not retry or work around it meanwhile.'
  );

export function createTakeoverGate(
  hold: typeof withHumanOnlyApproval = withHumanOnlyApproval,
  expiryMs = TAKEOVER_EXPIRY_MS
) {
  /** sessionId → the takeover held, its release and its expiry. */
  const held = new Map<string, HeldTakeover>();
  /** `${sessionId}\0${id}` of takeovers that expired here, ignored while a
   *  snapshot still shows them (the settle may lag or fail). */
  const expired = new Set<string>();
  let expire: (sessionId: string, id: string) => unknown = () => {};
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
  /** In-flight Browser Use commands → their session: a takeover suppresses
   *  (aborts) and drains its own session's. */
  const operations = new Map<AbortController, string>();
  // Every drain in flight waits here (two sessions can take over together).
  const drainWaiters = new Set<() => void>();
  const operationsOf = (sessionId: string): AbortController[] =>
    [...operations].filter(([, owner]) => owner === sessionId).map(([operation]) => operation);
  /** Waits until the session's commands drained, or until `cancel` aborts. */
  const drainOperations = async (sessionId: string, cancel: AbortSignal): Promise<void> => {
    for (const operation of operationsOf(sessionId)) {
      operation.abort(new Error('Browser Use stopped: the user took over this session'));
    }
    while (!cancel.aborted && operationsOf(sessionId).length > 0) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          drainWaiters.delete(wake);
          cancel.removeEventListener('abort', wake);
          resolve();
        };
        drainWaiters.add(wake);
        cancel.addEventListener('abort', wake, { once: true });
      });
    }
  };
  const release = (sessionId: string): void => {
    const entry = held.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.expiry);
    held.delete(sessionId);
    entry.ended.abort(new Error('takeover ended'));
    readiness.get(`${sessionId}\0${entry.id}`)?.resolve(false);
    readiness.delete(`${sessionId}\0${entry.id}`);
  };
  return {
    /** Returns the surface ('browser' | 'computer') of a takeover that starts
     *  with this update, else ''. */
    onSessionState(update: TakeoverSnapshotUpdate): string {
      const sessionId = String(update?.sessionId || '');
      if (!sessionId || !update.snapshot) return '';
      const approval = (
        update.snapshot as {
          toolApproval?: {
            id?: unknown;
            kind?: unknown;
            surfaceSessionId?: unknown;
            takeover?: TakeoverRequest | null;
          } | null;
        }
      ).toolApproval;
      // A copy of another session's takeover, shown in the chat that session
      // works for (tool-approval.mjs), is not this session's own takeover.
      const copy = String(approval?.surfaceSessionId ?? '') === sessionId;
      const takeoverId = approval?.kind === 'takeover' && !copy ? String(approval.id ?? 'takeover') : '';
      if (held.get(sessionId)?.id === takeoverId) return '';
      release(sessionId);
      const key = `${sessionId}\0${takeoverId}`;
      for (const stale of expired) if (stale.startsWith(`${sessionId}\0`) && stale !== key) expired.delete(stale);
      if (!takeoverId || expired.has(key)) return '';
      const ended = new AbortController();
      const surface = String(approval?.takeover?.surface || '');
      const step = takeoverStep(approval?.takeover);
      // Nobody finished it: it ends on its own, and the session is free even
      // before (or without) the settle reaching its snapshot.
      const expiry = setTimeout(() => {
        if (held.get(sessionId)?.id !== takeoverId) return;
        expired.add(key);
        release(sessionId);
        void Promise.resolve()
          .then(() => expire(sessionId, takeoverId))
          .catch((error) => console.warn('[takeover] expiry settle failed:', (error as Error)?.message || error));
      }, expiryMs);
      expiry.unref?.();
      held.set(sessionId, { id: takeoverId, step, ended, expiry });
      const ready = readyOf(key);
      // Human control is ready once this session's new commands are refused
      // (held above) and its in-flight Browser Use commands aborted and
      // drained: no agent capture lands after it. A screen takeover also
      // waits for Computer Use to drain (hold enters) and keeps it refused
      // until the takeover ends; ending it first drops the queued or draining
      // hand-over, so the screen is never held for a takeover that is over.
      const handOver = async () => {
        await drainOperations(sessionId, ended.signal);
        if (ended.signal.aborted) return;
        ready.resolve(true);
        await new Promise<void>((resolve) => ended.signal.addEventListener('abort', () => resolve(), { once: true }));
      };
      const handedOver =
        surface === 'computer'
          ? hold(
              handOver,
              ended.signal,
              `the user has the screen for a takeover (${step}) and was shown a card for it; try again once it ends`
            )
          : handOver();
      void handedOver.catch(() => ready.resolve(false));
      return surface;
    },
    /** Called once per takeover that expires (TAKEOVER_EXPIRY_MS) to settle it
     *  with reason TAKEOVER_EXPIRED_REASON. */
    onExpire(handler: (sessionId: string, id: string) => unknown): void {
      expire = handler;
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
    /** Browser Use admits no command of `sessionId` while its own takeover is
     *  pending; another session's takeover never blocks it, so every caller
     *  names its session (a secret input checks it before taking its value). */
    assertFree(sessionId: string): void {
      const entry = held.get(sessionId);
      if (entry) throw browserRefusal(entry);
    },
    /** One Browser Use command of `sessionId`: refused during its takeover,
     *  else counted until `release`; its takeover starting meanwhile aborts
     *  its `signal`. Other sessions' takeovers never touch it. */
    beginOperation(sessionId: string): { signal: AbortSignal; release: () => void } {
      const entry = held.get(sessionId);
      if (entry) throw browserRefusal(entry);
      const controller = new AbortController();
      operations.set(controller, sessionId);
      return {
        signal: controller.signal,
        release: () => {
          if (!operations.delete(controller)) return;
          for (const waiter of [...drainWaiters]) waiter();
        },
      };
    },
    dispose(): void {
      for (const sessionId of [...held.keys()]) release(sessionId);
      expired.clear();
    },
  };
}

/** The window process's one gate (fed by index.ts, checked by the browser runner). */
export const takeoverGate = createTakeoverGate();
