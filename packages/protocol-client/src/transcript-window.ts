// What a reader of a positioned transcript asks the core to hold (`thread/window/set`): the followed tail, and the rows
// around where the reader is. Rows the reader scrolled away from are let go; scrolling back asks for them again.
import type { ProtocolClient } from './api.ts';
import { TAIL_RANGE, viewRun, windowRuns, type HeldWindow, type WindowRun } from './positioned.ts';
import type { SessionFold } from './session-state.ts';

/** Where the reader is: on the live tail (`follow`), at the oldest rows shown (`older`), at the newest rows of a stretch
 *  shown apart from the tail (`newer`), or opening the transcript at a record (`at`: a search hit's position, a turn's). */
export type TranscriptMove =
  | { readonly kind: 'follow' }
  | { readonly kind: 'older' }
  | { readonly kind: 'newer' }
  | { readonly kind: 'at'; readonly position: string };

/** Rows a page asks for past the end the reader reached. */
export const WINDOW_PAGE_ROWS = 96;
/** The most rows held for the reader apart from the tail's range: past it, the end the reader moves away from is let go. */
export const WINDOW_VIEW_MAX_ROWS = 480;
/** Rows the followed tail's range may grow to while the reader follows it before it is read anew from the newest record. */
export const WINDOW_TAIL_MAX_ROWS = 192;

export type WindowRangeWant =
  | { readonly at: 'retain'; readonly id: string }
  | { readonly at: 'before'; readonly position: string; readonly rows: number }
  | { readonly at: 'after'; readonly position: string; readonly rows: number }
  | { readonly at: 'around'; readonly position: string; readonly before: number; readonly after: number };

export interface WindowWant {
  readonly ranges: readonly WindowRangeWant[];
  readonly followTail: boolean;
  readonly pinned: readonly string[];
}

const retain = (id: string): WindowRangeWant => ({ at: 'retain', id });

function rowsOfRanges(held: HeldWindow, ids: Iterable<string>): number {
  const wanted = new Set(ids);
  const positions = new Set(held.ranges.filter((range) => wanted.has(range.id)).flatMap((range) => range.positions));
  let rows = 0;
  for (const position of positions) rows += held.units.get(position)?.rows.length ?? 0;
  return rows;
}

/** The ranges of `run` other than the tail's, ordered by where each ends: from the end `newest` names. */
function byEnd(held: HeldWindow, run: WindowRun, newest: boolean): string[] {
  const place = new Map(run.positions.map((position, at) => [position, at]));
  const end = (id: string): number => {
    const positions = held.ranges.find((range) => range.id === id)?.positions ?? [];
    const at = positions.map((position) => place.get(position) ?? -1);
    return newest ? Math.max(...at) : -Math.min(...at);
  };
  return run.ranges.filter((id) => id !== TAIL_RANGE).sort((a, b) => end(b) - end(a));
}

/** `kept` with ranges let go from the front of `order` while the rows they hold and a page more exceed the reader's bound;
 *  the last of them stays. */
function bounded(held: HeldWindow, kept: Set<string>, order: readonly string[]): Set<string> {
  for (const id of order) {
    const rest = [...kept].filter((other) => other !== TAIL_RANGE);
    if (rest.length <= 1 || rowsOfRanges(held, rest) + WINDOW_PAGE_ROWS <= WINDOW_VIEW_MAX_ROWS) break;
    kept.delete(id);
  }
  return kept;
}

/** What to ask the core to hold for `move`, from the window held now; null when what it holds already serves it. */
export function windowWant(held: HeldWindow, move: TranscriptMove): WindowWant | null {
  const runs = windowRuns(held);
  const tail = runs.find((run) => run.tail);
  const view = viewRun(held);
  const tailRange = held.ranges.find((range) => range.id === TAIL_RANGE);
  const tailRows = rowsOfRanges(held, [TAIL_RANGE]);
  // The tail's range is kept while it is small; grown past its bound it is let go, and following the tail reads it anew.
  const tailKept = tailRange !== undefined && tailRange.positions.length > 0 && tailRows <= WINDOW_TAIL_MAX_ROWS;
  const asked = (kept: Iterable<string>, add?: WindowRangeWant): WindowWant => ({
    ranges: [...[...kept].map(retain), ...(add ? [add] : [])],
    followTail: true,
    pinned: [],
  });
  switch (move.kind) {
    case 'follow': {
      // Only the tail's run is kept, and only while it is within the reader's bound; everything else is let go.
      const kept = new Set<string>();
      if (tailKept && tail) {
        if (tail.rows <= WINDOW_VIEW_MAX_ROWS) for (const id of tail.ranges) kept.add(id);
        else kept.add(TAIL_RANGE);
      }
      const held_ = new Set(held.ranges.map((range) => range.id));
      const same = held.followTail && kept.size === held_.size && [...kept].every((id) => held_.has(id));
      return same ? null : asked(kept);
    }
    case 'older': {
      const run = view ?? tail;
      if (!run || run.older === null) return null;
      const kept = bounded(held, new Set(run.ranges), byEnd(held, run, true));
      if (!run.tail && tailKept) kept.add(TAIL_RANGE);
      if (run.tail) kept.add(TAIL_RANGE);
      return asked(kept, { at: 'before', position: run.positions[0]!, rows: WINDOW_PAGE_ROWS });
    }
    case 'newer': {
      if (!view || view.newer === null) return null;
      const kept = bounded(held, new Set(view.ranges), byEnd(held, view, false));
      if (tailKept) kept.add(TAIL_RANGE);
      return asked(kept, { at: 'after', position: view.positions.at(-1)!, rows: WINDOW_PAGE_ROWS });
    }
    case 'at': {
      const shown = [tail, view].some((run) => run?.positions.includes(move.position));
      if (shown) return null;
      return asked(tailKept ? [TAIL_RANGE] : [], {
        at: 'around',
        position: move.position,
        before: WINDOW_PAGE_ROWS,
        after: WINDOW_PAGE_ROWS,
      });
    }
  }
}

/** How long a granted change may take to reach the fold before the next move is decided anyway. */
const CHANGE_WAIT_MS = 15_000;

interface Driving {
  next: TranscriptMove | null;
  running: Promise<boolean> | null;
}
const driving = new WeakMap<object, Map<string, Driving>>();
let requests = 0;

/** Resolves once the fold of `threadId` holds a window other than version `base` (the change asked for, or one the core made
 *  meanwhile), or holds none. */
function windowMoved(client: ProtocolClient<SessionFold>, threadId: string, base: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const moved = (): boolean => client.store.thread(threadId)?.state.held?.version !== base;
    if (moved()) return resolve();
    const timer = setTimeout(done, CHANGE_WAIT_MS);
    const off = client.store.subscribe((change) => {
      if (change.type === 'thread' && change.threadId === threadId && moved()) done();
    });
    function done(): void {
      clearTimeout(timer);
      off();
      resolve();
    }
  });
}

const refused = (error: unknown): boolean => {
  const reason = (error as { detail?: { data?: { reason?: unknown } } } | null)?.detail?.data?.reason;
  return reason === 'preconditionFailed';
};

/** One move asked of the core, from the window the fold holds now. */
async function step(client: ProtocolClient<SessionFold>, threadId: string, move: TranscriptMove): Promise<boolean> {
  const held = client.store.thread(threadId)?.state.held;
  const subscriptionId = client.threadSubscription(threadId).subscriptionId;
  if (!held || !subscriptionId) return false;
  const want = windowWant(held, move);
  if (!want) return true;
  for (let attempt = 0; ; attempt++) {
    const base = client.store.thread(threadId)?.state.held?.version;
    if (base === undefined) return false;
    const now = attempt === 0 ? want : windowWant(client.store.thread(threadId)!.state.held!, move);
    if (!now) return true;
    const moved = windowMoved(client, threadId, base);
    try {
      await client.call('thread/window/set', {
        threadId,
        subscriptionId,
        baseWindowVersion: base,
        requestId: `w${Date.now().toString(36)}.${++requests}`,
        want: now,
      } as never);
    } catch (error) {
      // Another window stood when the call arrived (the core rebased it, or a recovery's snapshot replaced it): the move is
      // asked again from the window held once that one is folded.
      if (!refused(error) || attempt >= 1) return false;
      await moved;
      continue;
    }
    await moved;
    return true;
  }
}

/** Asks the core to hold what `move` needs of the thread's positioned window. One request of a thread is out at a time; a
 *  move asked meanwhile replaces any other waiting, and is decided from the window the request before it left. Resolves with
 *  whether the last move was served (false: the thread is not followed positioned, or the core refused it). */
export function moveTranscriptWindow(
  client: ProtocolClient<SessionFold>,
  threadId: string,
  move: TranscriptMove
): Promise<boolean> {
  let threads = driving.get(client);
  if (!threads) driving.set(client, (threads = new Map()));
  let d = threads.get(threadId);
  if (!d) threads.set(threadId, (d = { next: null, running: null }));
  d.next = move;
  if (d.running) return d.running;
  const drive = d;
  drive.running = (async () => {
    let served = true;
    try {
      while (drive.next) {
        const next = drive.next;
        drive.next = null;
        served = await step(client, threadId, next).catch(() => false);
      }
    } finally {
      drive.running = null;
      if (threads.get(threadId) === drive) threads.delete(threadId);
    }
    return served;
  })();
  return drive.running;
}
