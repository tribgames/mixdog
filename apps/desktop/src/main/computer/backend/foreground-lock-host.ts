import { loadWindowModule } from '../../native-module';

/**
 * The foreground-lock leases the process hosting the bridge gives a worker
 * Windows refuses the lock to (MixForegroundLock.cs). Windows gives
 * LockSetForegroundWindow only to a process that may set the foreground; a
 * pooled worker rarely may, since a right it inherited or was granted ends
 * with the next input that is not its own, such as the user typing into their
 * own window. The foreground process may, and while the user works in a
 * Mixdog window that is this process. The protection is best effort: Windows
 * lifts the lock on the user's Alt key or click, and nothing here can end a
 * lock this process held when it died.
 *
 * The lock is taken and ended by a lease owner on its own native thread
 * (native/mixdog-window, foreground_lease.rs, loaded as mixdog_window.node),
 * never by this event loop: a lease ends at its deadline however long this
 * loop is blocked. A worker asks with a
 * line on its stdout; the answer goes back on its stdin, a pipe only this
 * process can write, and names the request (action and sequence) and the
 * lease it answers, so the worker accepts nothing else. A line that is not a
 * well-formed request of the worker's own in-flight action is ignored, never
 * thrown into the worker's output handling.
 */
export const FOREGROUND_LOCK_LINE_PREFIX = '@@MIXDOG_FGLOCK@@';
/** Lease answers on a worker's stdin (MixForegroundLockHost.ReplyPrefix). */
export const FOREGROUND_LOCK_REPLY_PREFIX = '@@MIXDOG_FGLOCK_REPLY@@';
/** No lease holds every other app's foreground changes for longer. */
const MAX_HOLD_MS = 1_000;
const MAX_ID = 2 ** 31 - 1;
/** Facts kept for replies that never came, before the oldest are dropped. */
const MAX_FACTS = 256;

/** One worker as the lease channel sees it. */
export interface LeaseWorker {
  /** This process's own number for the worker, never reused. */
  instance: number;
  pid: number | undefined;
  /** Whether `action` is a request the worker has in flight. */
  owns(action: number): boolean;
  /** One line onto the worker's stdin. */
  write(line: string): void;
}

export type LeaseThreadRequest =
  | { type: 'acquire'; instance: number; pid: number; action: number; seq: number; holdMs: number; answerBy: number }
  | { type: 'release'; instance: number; action: number; seq: number; lease: number }
  | { type: 'gone'; instance: number }
  | { type: 'dispose' };

type LeaseFacts = Record<string, unknown>;

/** How one unlock call made from this process's main thread went. */
export interface FallbackUnlock {
  outcome: 'released' | 'unknown' | 'failed';
  error?: string | number;
}

// `holding`: the thread may still hold the lock (a lease, or an unlock it has
// not proven), after the event.
export type LeaseThreadEvent =
  | { type: 'disposed'; outcome: string }
  | {
      holding: boolean;
      type: 'answer';
      instance: number;
      action: number;
      seq: number;
      lease: number;
      answer: string;
      deadlineAt: number;
      facts: LeaseFacts;
    }
  | {
      holding: boolean;
      type: 'released';
      instance: number;
      action: number;
      seq: number;
      lease: number;
      outcome: string;
      reply: boolean;
      facts: LeaseFacts | null;
    };

export interface LeaseThread {
  post(message: LeaseThreadRequest): void;
  /** Stops the thread at once. */
  stop(): void;
}

/** Starts the lease owner; `exit` reports that it can take no more leases. */
export type StartLeaseThread = (events: {
  message(event: LeaseThreadEvent): void;
  exit(reason: string): void;
}) => LeaseThread;

/** The lease thread, and the one unlock call this process's main thread makes
 *  when that thread ended and may have left the lock held. The lock belongs to
 *  the process, so any of its threads may end it. Never throws. */
export interface ForegroundLeaseRuntime {
  startThread: StartLeaseThread;
  fallbackUnlock(): FallbackUnlock;
}

export interface HostForegroundLock {
  /** One request line from `worker`, without its prefix. Never throws. */
  handle(payload: string, worker: LeaseWorker): void;
  /** This side's facts for a worker's action, once; undefined when it was not asked. */
  takeFacts(instance: number, action: number): LeaseFacts | undefined;
  /** The worker exited or was retired: a lease it holds ends now. */
  workerGone(instance: number): void;
  /** Ends the thread after asking it to release, and unlocks from here unless
   *  it confirmed the lock released or never held; how that went. */
  dispose(): Promise<LeaseFacts | undefined>;
}

/** How long dispose waits for the thread's own account of its release. */
const DISPOSE_ANSWER_MS = 100;

type LeaseLine =
  | { op: 'acquire'; action: number; seq: number; holdMs: number; answerBy: number }
  | { op: 'release'; action: number; seq: number; lease: number };

const boundedId = (value: unknown, min: number): number | undefined =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= MAX_ID
    ? (value as number)
    : undefined;

/** A well-formed request line, or undefined for anything else. */
function parseLeaseLine(payload: string): LeaseLine | undefined {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  const action = boundedId(message.action, 1);
  const seq = boundedId(message.seq, 1);
  if (action === undefined || seq === undefined) return undefined;
  if (message.op === 'acquire') {
    const holdMs = Number.isSafeInteger(message.hold_ms) ? (message.hold_ms as number) : 0;
    const answerBy = message.answer_by;
    if (holdMs < 1 || holdMs > MAX_HOLD_MS) return undefined;
    if (typeof answerBy !== 'number' || !Number.isFinite(answerBy) || answerBy < 0 || answerBy > 2 ** 52) {
      return undefined;
    }
    return { op: 'acquire', action, seq, holdMs, answerBy };
  }
  if (message.op === 'release') {
    const lease = boundedId(message.lease, 0);
    return lease === undefined ? undefined : { op: 'release', action, seq, lease };
  }
  return undefined;
}

export function createHostForegroundLock(runtime: ForegroundLeaseRuntime): HostForegroundLock {
  let thread: LeaseThread | undefined;
  // Why no lease thread can answer any more; empty while one can be started.
  let threadDown = '';
  let disposed = false;
  // Whether the thread may hold the lock: as it last said, or an acquire it
  // has not answered yet.
  let reportedHolding = false;
  let unansweredAcquires = 0;
  // How the thread ended and what main's own unlock call did, for the facts.
  let threadEnd: LeaseFacts | undefined;
  let disposedAnswer: ((outcome: string | undefined) => void) | undefined;
  const fallbackUnlock = (): LeaseFacts => {
    try {
      const result = runtime.fallbackUnlock();
      return {
        fallback_unlock: result.outcome,
        ...(result.error === undefined ? {} : { fallback_error: result.error }),
      };
    } catch (error) {
      return { fallback_unlock: 'failed', fallback_error: error instanceof Error ? error.message : String(error) };
    }
  };
  const workers = new Map<number, LeaseWorker>();
  const factsByAction = new Map<string, LeaseFacts>();
  const factsKey = (instance: number, action: number) => `${instance}:${action}`;

  const write = (instance: number, line: string): void => {
    try {
      workers.get(instance)?.write(line);
    } catch {
      // The worker's wait runs out, which it reads as no answer.
    }
  };
  const file = (instance: number, action: number, facts: LeaseFacts): void => {
    const key = factsKey(instance, action);
    factsByAction.delete(key);
    factsByAction.set(key, facts);
    if (factsByAction.size > MAX_FACTS) factsByAction.delete(factsByAction.keys().next().value as string);
  };
  const answer = (instance: number, action: number, seq: number, lease: number, said: string, deadlineAt: number) =>
    write(instance, `${FOREGROUND_LOCK_REPLY_PREFIX}ack ${action} ${seq} ${lease} ${said} ${deadlineAt.toFixed(3)}\n`);
  const released = (instance: number, action: number, seq: number, lease: number, outcome: string) =>
    write(instance, `${FOREGROUND_LOCK_REPLY_PREFIX}released ${action} ${seq} ${lease} ${outcome}\n`);

  function onEvent(event: LeaseThreadEvent): void {
    if (event.type === 'disposed') {
      disposedAnswer?.(event.outcome);
      return;
    }
    reportedHolding = event.holding;
    if (event.type === 'answer') unansweredAcquires = Math.max(0, unansweredAcquires - 1);
    if (disposed) return;
    if (event.type === 'answer') {
      file(event.instance, event.action, event.facts);
      answer(event.instance, event.action, event.seq, event.lease, event.answer, event.deadlineAt);
      return;
    }
    const key = factsKey(event.instance, event.action);
    // Only the action's own lease updates its facts; a late end of an older one does not.
    if (event.facts && factsByAction.get(key)?.lease === event.lease) factsByAction.set(key, event.facts);
    if (event.reply) released(event.instance, event.action, event.seq, event.lease, event.outcome);
  }

  function leaseThread(): LeaseThread | undefined {
    if (thread || threadDown || disposed) return thread;
    let ended = false;
    try {
      thread = runtime.startThread({
        message: (event) => {
          try {
            onEvent(event);
          } catch {
            // A worker without its answer reads that as none.
          }
        },
        // A thread that crashed or was stopped may have left the lock held:
        // main makes one unlock call of its own, and dispose makes its own.
        exit: (reason) => {
          if (ended) return;
          ended = true;
          thread = undefined;
          threadDown ||= reason;
          if (disposed) return;
          const mayHold = reportedHolding || unansweredAcquires > 0;
          threadEnd = { reason, holding: mayHold, ...(mayHold ? fallbackUnlock() : {}) };
          reportedHolding = false;
          unansweredAcquires = 0;
        },
      });
    } catch (error) {
      threadDown = `the lease thread could not start: ${error instanceof Error ? error.message : String(error)}`;
    }
    return thread;
  }

  return {
    handle(payload, worker) {
      try {
        const line = parseLeaseLine(payload);
        if (!line || !worker.owns(line.action) || disposed) return;
        workers.set(worker.instance, worker);
        const active = line.op === 'acquire' ? leaseThread() : thread;
        if (line.op === 'acquire') {
          if (active) {
            unansweredAcquires++;
            try {
              active.post({
                type: 'acquire',
                instance: worker.instance,
                pid: worker.pid ?? 0,
                action: line.action,
                seq: line.seq,
                holdMs: line.holdMs,
                answerBy: line.answerBy,
              });
              return;
            } catch {
              // A thread that cannot take the request ended (its exit is reported): none can answer.
              threadDown ||= 'the lease thread did not take the request';
            }
          }
          file(worker.instance, line.action, {
            lease: 0,
            answer: 'unavailable',
            host_pid: process.pid,
            reason: threadDown,
          });
          answer(worker.instance, line.action, line.seq, 0, 'unavailable', 0);
          return;
        }
        if (active) {
          try {
            active.post({
              type: 'release',
              instance: worker.instance,
              action: line.action,
              seq: line.seq,
              lease: line.lease,
            });
            return;
          } catch {
            // The thread ended with this request (its exit is reported): the account below answers it.
          }
        }
        // A thread that ended holding the lock got main's one unlock call, whose
        // outcome is the account; one that held nothing, or never started, left none.
        const ended = threadEnd?.holding ? String(threadEnd.fallback_unlock) : 'none';
        released(worker.instance, line.action, line.seq, line.lease, ended);
      } catch {
        // Ignored like any other line the channel cannot use.
      }
    },
    takeFacts(instance, action) {
      const key = factsKey(instance, action);
      const facts = factsByAction.get(key);
      factsByAction.delete(key);
      return facts && threadEnd ? { ...facts, lease_thread: threadEnd } : facts;
    },
    workerGone(instance) {
      if (!workers.delete(instance)) return;
      for (const key of [...factsByAction.keys()]) if (key.startsWith(`${instance}:`)) factsByAction.delete(key);
      try {
        thread?.post({ type: 'gone', instance });
      } catch {
        // The lease still ends at its deadline.
      }
    },
    // Asks the thread to end any lease, waits briefly for its account, then
    // stops it. Unless it confirmed released or none, main unlocks once; no
    // retry follows, since the app is going and the user's Alt key or click
    // lifts anything left.
    async dispose() {
      if (disposed) return undefined;
      disposed = true;
      const active = thread;
      thread = undefined;
      workers.clear();
      factsByAction.clear();
      if (!active) return threadEnd;
      const outcome = await new Promise<string | undefined>((resolve) => {
        disposedAnswer = resolve;
        setTimeout(() => resolve(undefined), DISPOSE_ANSWER_MS);
        try {
          active.post({ type: 'dispose' });
        } catch {
          resolve(undefined);
        }
      });
      disposedAnswer = undefined;
      active.stop();
      const confirmed = outcome === 'released' || outcome === 'none';
      return { thread_release: outcome ?? 'no_answer', ...(confirmed ? {} : fallbackUnlock()) };
    },
  };
}

/** The lease functions of mixdog_window.node (native/mixdog-window, foreground_lease.rs). */
export interface LeaseNative {
  /** Starts the lease thread; `onEvent` gets the JSON of each lease end it reports. Throws when one is running. */
  leaseStart(onEvent: (event: string) => void): void;
  /** Takes a lease for the request on the lease thread, and waits for its answer. */
  leaseRequest(request: {
    instance: number;
    pid: number;
    action: number;
    seq: number;
    holdMs: number;
    answerBy: number;
  }): { holding: boolean; lease: number; answer: string; deadlineAt: number; facts: string };
  leaseEnd(end: { instance: number; action: number; seq: number; lease: number }): void;
  leaseGone(instance: number): void;
  /** Ends any lease and stops the thread; released, unknown, failed or none. */
  leaseDispose(): string;
  /** One unlock call from the calling thread. */
  leaseUnlock(): { outcome: string; error?: number | null };
}

const failureOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Loads the Node-API module from any file name (the dev build keeps cargo's .dll name): the desktop's one native-module loader. */
export const loadLeaseNative = (library: string): LeaseNative => loadWindowModule<LeaseNative>(library);

/** The lease thread of the module: an answer comes back from the call that asks,
 *  a lease's end as an event. A call the module fails ends the thread for the
 *  host (`exit`), which then unlocks from here once. */
export function nativeLeaseThread(native: LeaseNative): StartLeaseThread {
  return (events) => {
    native.leaseStart((json) => {
      events.message({ type: 'released', ...JSON.parse(json) } as LeaseThreadEvent);
    });
    let stopped = false;
    const call = <T>(step: () => T): T => {
      try {
        return step();
      } catch (error) {
        events.exit(`the lease thread failed: ${failureOf(error)}`);
        throw error;
      }
    };
    return {
      post(message) {
        if (message.type === 'acquire') {
          const { instance, action, seq } = message;
          const answered = call(() => native.leaseRequest(message));
          events.message({
            holding: answered.holding,
            type: 'answer',
            instance,
            action,
            seq,
            lease: answered.lease,
            answer: answered.answer,
            deadlineAt: answered.deadlineAt,
            facts: JSON.parse(answered.facts),
          });
        } else if (message.type === 'release') {
          call(() => native.leaseEnd(message));
        } else if (message.type === 'gone') {
          call(() => native.leaseGone(message.instance));
        } else {
          stopped = true;
          events.message({ type: 'disposed', outcome: call(() => native.leaseDispose()) });
        }
      },
      stop() {
        if (stopped) return;
        stopped = true;
        try {
          native.leaseDispose();
        } catch {
          // Already ended.
        }
      },
    };
  };
}

/** The one unlock call this process's main thread makes through the module;
 *  false is unknown, as on the lease thread, and a call that throws is failed. */
export function nativeFallbackUnlock(native: () => LeaseNative): () => FallbackUnlock {
  return () => {
    try {
      const result = native().leaseUnlock();
      return result.outcome === 'released'
        ? { outcome: 'released' }
        : { outcome: 'unknown', ...(result.error == null ? {} : { error: result.error }) };
    } catch (error) {
      return { outcome: 'failed', error: failureOf(error) };
    }
  };
}

/** The lease thread and main-thread fallback through the module `load` gives,
 *  loaded on first use. Where it cannot be loaded no lease is taken: the reason is
 *  logged once at error level and every request is answered unavailable. */
export function nativeForegroundLease(load: () => LeaseNative): ForegroundLeaseRuntime {
  let loaded: LeaseNative | undefined;
  let loadError: Error | undefined;
  const native = (): LeaseNative => {
    if (loaded) return loaded;
    if (!loadError) {
      try {
        loaded = load();
        return loaded;
      } catch (error) {
        loadError = new Error(`The foreground-lease module could not be loaded: ${failureOf(error)}`);
        console.error(`[mixdog-window] ${loadError.message}. Computer Use runs without foreground-lock leases.`);
      }
    }
    throw loadError;
  };
  return {
    startThread: (events) => nativeLeaseThread(native())(events),
    fallbackUnlock: nativeFallbackUnlock(native),
  };
}

let leaseLibrary: string | undefined;

/** The path of mixdog_window.node (window-mica.ts `micaLibraryPath`) that the
 *  process's lease owner loads; set once at startup. */
export function setForegroundLeaseLibrary(library: string): void {
  leaseLibrary = library;
}

// One lease owner per process: LSFW_LOCK belongs to the process, so two owners
// could not see each other's leases (one could lock while the other holds a
// lease, and its deadline unlock would end the other's protection early).
let processLock: HostForegroundLock | undefined;
let leaseInstances = 0;

/** This process's number for a worker or helper on the lease channel, shared
 *  by every user of the process's owner and never reused. */
export function nextLeaseInstance(): number {
  return ++leaseInstances;
}

/** The process's lease owner, created on first use. */
export function processForegroundLock(
  runtime: () => ForegroundLeaseRuntime = () =>
    nativeForegroundLease(() => {
      if (!leaseLibrary) throw new Error('the path of mixdog_window.node was not set');
      return loadLeaseNative(leaseLibrary);
    })
): HostForegroundLock {
  processLock ??= createHostForegroundLock(runtime());
  return processLock;
}

/** Ends the process's lease owner (app shutdown); a later use starts a new one. */
export async function disposeProcessForegroundLock(): Promise<LeaseFacts | undefined> {
  const lock = processLock;
  processLock = undefined;
  return lock?.dispose();
}
