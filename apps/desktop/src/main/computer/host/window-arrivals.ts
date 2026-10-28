/**
 * Windows that appeared since the session's previous command. An action reads
 * the window list once, at its settle mark, so a window that opens later — a
 * page's sign-in popup, a slow dialog — is named by no reply. Each queued
 * command compares the desktop with what its session already knows and names
 * the newcomers as arrivals since the last action, never as its effects. A
 * restricted session hears only about windows it may capture.
 *
 * After an action's reply has gone out, a short watch keeps looking for about
 * a second and keeps what it sees for the session's next reply, so a popup
 * that opens and closes between commands is still named.
 *
 * Nothing here may cost the command it rides on: the reads run on a worker of
 * their own that no command queues on and that only starts with worker slots
 * to spare, one read at a time, each waited on for a short budget only.
 */
import { CHROME_SETUP_SESSION_ID } from '../shared/common';
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import type { ComputerWindowRecord } from '../shared/window-transition';
import { READ_ACTIONS } from './action-sets';
import { type ComputerExecutionPolicy, visibleWindowRecords } from './execution-policy';

/** How long a command waits for an arrivals read; a snapshot takes ~5-10 ms. */
export const ARRIVALS_READ_BUDGET_MS = 300;
/** The watch after an action: a look every interval until the span ends or
 *  a new window the session may see appears. */
export const ARRIVALS_WATCH_INTERVAL_MS = 200;
export const ARRIVALS_WATCH_SPAN_MS = 1_000;

export interface WindowArrivalsHost {
  policy: Pick<ComputerExecutionPolicy, 'restricted' | 'assertWindow'>;
  sessionIdFor(command: ComputerCommand): string;
  /** A read on the host's window-arrivals worker, never a session's own. */
  peekComputerWindows(command: ComputerCommand, includeApp?: boolean): Promise<ComputerWindowRecord[] | null>;
}

/** Windows present at the session's last look or already named to it, or
 *  `unknown`: a read failed before any baseline existed, so a later list
 *  cannot tell which of its windows are new. */
type Baseline = Set<string> | 'unknown';

const ids = (windows: ComputerWindowRecord[]) => new Set(windows.map((window) => window.id));

export function createWindowArrivals(host: WindowArrivalsHost) {
  const { policy, sessionIdFor, peekComputerWindows } = host;
  const baselineBySession = new Map<string, Baseline>();
  /** Counts each session's commands that may change the desktop, so a late
   *  list knows whether one began since it was asked for. */
  const actionsBySession = new Map<string, number>();
  /** The one read in flight. A stuck worker therefore holds one request,
   *  never one per command, and a busy one is skipped, not queued behind. */
  let inFlight: Promise<unknown> | null = null;
  /** Windows a watch saw that no reply has named yet; kept even after they
   *  close, so the next reply still names them. */
  const seenBySession = new Map<string, Map<string, ComputerWindowRecord>>();
  /** The running watch per session; a new command of that session ends it. */
  const watchBySession = new Map<string, NodeJS.Timeout>();

  function stopWatch(sessionId: string): void {
    clearTimeout(watchBySession.get(sessionId));
    watchBySession.delete(sessionId);
  }

  /** Seen windows not yet named, then the list's own newcomers. */
  function unnamed(sessionId: string, baseline: Set<string>, windows: ComputerWindowRecord[]): ComputerWindowRecord[] {
    const seen = [...(seenBySession.get(sessionId)?.values() || [])].filter((window) => !baseline.has(window.id));
    const seenIds = ids(seen);
    return [...seen, ...windows.filter((window) => !baseline.has(window.id) && !seenIds.has(window.id))];
  }

  /** The read and what it returned within the budget: `undefined` when it is
   *  still running or another read is, `null` when it failed. */
  async function boundedRead(command: ComputerCommand, includeApp = false) {
    if (inFlight) return { read: null, windows: undefined };
    const read = peekComputerWindows(command, includeApp).catch(() => null);
    const settled = read.finally(() => {
      if (inFlight === settled) inFlight = null;
    });
    inFlight = settled;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, ARRIVALS_READ_BUDGET_MS, undefined);
    });
    try {
      return { read, windows: await Promise.race([read, late]) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The windows the session has not been told about. A session's first
   *  command only takes the baseline. */
  async function read(command: ComputerCommand): Promise<ComputerWindowRecord[]> {
    const sessionId = sessionIdFor(command);
    stopWatch(sessionId);
    const acts = !READ_ACTIONS.has(String(command.action));
    const actions = (actionsBySession.get(sessionId) || 0) + (acts ? 1 : 0);
    actionsBySession.set(sessionId, actions);
    const { read: pending, windows } = await boundedRead(command);
    if (windows === undefined) {
      // A late list (a worker still starting) may show the desktop after this
      // command's input. An action without a baseline is unknown until its own
      // before list seeds one; a read-only command's late list seeds it while
      // no action of the session has begun since.
      if (acts && !baselineBySession.has(sessionId)) baselineBySession.set(sessionId, 'unknown');
      void pending?.then((late) => {
        if (!late || acts || baselineBySession.has(sessionId) || actionsBySession.get(sessionId) !== actions) return;
        baselineBySession.set(sessionId, ids(late));
      });
      const known = baselineBySession.get(sessionId);
      return known instanceof Set ? unnamed(sessionId, known, []) : [];
    }
    const baseline = baselineBySession.get(sessionId);
    if (!windows) {
      if (!baseline) baselineBySession.set(sessionId, 'unknown');
      return baseline instanceof Set ? unnamed(sessionId, baseline, []) : [];
    }
    if (!baseline) {
      baselineBySession.set(sessionId, ids(windows));
      return [];
    }
    if (baseline === 'unknown') {
      // Which windows arrived since the failed read cannot be told apart, so
      // every one counts until a reply has named it.
      baselineBySession.set(sessionId, new Set());
      return windows;
    }
    // A closed window leaves the baseline, so a handle reused later reads as new.
    const present = ids(windows);
    for (const id of baseline) if (!present.has(id)) baseline.delete(id);
    return unnamed(sessionId, baseline, windows);
  }

  /** One look of a watch: whether to keep watching. */
  async function look(command: ComputerCommand, sessionId: string, current: () => boolean): Promise<boolean> {
    const baseline = baselineBySession.get(sessionId);
    if (!(baseline instanceof Set)) return false;
    const { windows } = await boundedRead(command);
    // Released or superseded during the read: record nothing for this session.
    if (!current() || baselineBySession.get(sessionId) !== baseline) return false;
    // Busy: look again next time. Failed or refused (no worker slot to spare): stop.
    if (windows === undefined) return true;
    if (!windows) return false;
    const fresh = windows.filter((window) => !baseline.has(window.id));
    if (!fresh.length) return true;
    const seen = seenBySession.get(sessionId) || new Map<string, ComputerWindowRecord>();
    seenBySession.set(sessionId, seen);
    for (const window of fresh) if (!seen.has(window.id)) seen.set(window.id, window);
    return visibleTo(command, fresh).length === 0;
  }

  /** Watches for a short span after an action's reply has gone out. It never
   *  holds the reply or any command: it runs on timers, on the reader. */
  function watch(command: ComputerCommand): void {
    if (READ_ACTIONS.has(String(command.action))) return;
    const sessionId = sessionIdFor(command);
    stopWatch(sessionId);
    const deadline = performance.now() + ARRIVALS_WATCH_SPAN_MS;
    const schedule = () => {
      const timer = setTimeout(async () => {
        if (watchBySession.get(sessionId) !== timer) return;
        const again = await look(command, sessionId, () => watchBySession.get(sessionId) === timer);
        if (watchBySession.get(sessionId) !== timer) return;
        if (again && performance.now() + ARRIVALS_WATCH_INTERVAL_MS <= deadline) schedule();
        else watchBySession.delete(sessionId);
      }, ARRIVALS_WATCH_INTERVAL_MS);
      timer.unref?.();
      watchBySession.set(sessionId, timer);
    };
    schedule();
  }

  /** What an action's own window reads showed: the list before it seeds a
   *  session without a baseline, and the windows its reply names are known. */
  function noteSettled(command: ComputerCommand, before: ComputerWindowRecord[] | null, named: string[]): void {
    const sessionId = sessionIdFor(command);
    let baseline = baselineBySession.get(sessionId);
    if (!(baseline instanceof Set)) {
      if (!before) return;
      baseline = ids(before);
      baselineBySession.set(sessionId, baseline);
    }
    const seen = seenBySession.get(sessionId);
    for (const id of named) {
      baseline.add(id);
      seen?.delete(id);
    }
  }

  function visibleTo(command: ComputerCommand, windows: ComputerWindowRecord[]): ComputerWindowRecord[] {
    return sessionIdFor(command) === CHROME_SETUP_SESSION_ID ? windows : visibleWindowRecords(policy, command, windows);
  }

  /** Names the arrivals on a JSON reply. A reply that cannot carry them (plain
   *  text, user-owned clipboard text) leaves them for the next command. */
  async function report(
    command: ComputerCommand,
    arrived: ComputerWindowRecord[],
    result: ComputerCommandResult
  ): Promise<ComputerCommandResult> {
    if (!arrived.length || command.action === 'clipboard_read') return result;
    let payload: unknown;
    try {
      payload = JSON.parse(result.text);
    } catch {
      return result;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return result;
    noteSettled(
      command,
      null,
      arrived.map((window) => window.id)
    );
    const visible = visibleTo(command, arrived);
    if (!visible.length) return result;
    // The snapshot read carries no app names; only a reply with arrivals pays
    // for them, and a slow or failed read leaves them empty.
    const { windows } = await boundedRead(command, true);
    const apps = new Map(windows?.map((window) => [window.id, window.app]));
    return {
      ...result,
      text: JSON.stringify({
        ...payload,
        windows_opened_since_last_action: visible.map((window) => ({
          id: window.id,
          title: window.title,
          app: apps.get(window.id) || window.app,
        })),
      }),
    };
  }

  function forget(sessionId: string): void {
    stopWatch(sessionId);
    baselineBySession.delete(sessionId);
    actionsBySession.delete(sessionId);
    seenBySession.delete(sessionId);
  }

  return { read, noteSettled, report, watch, forget };
}

export type WindowArrivals = ReturnType<typeof createWindowArrivals>;
