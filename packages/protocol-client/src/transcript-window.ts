// What a reader of a positioned transcript asks the core to hold (`thread/window/set`): the followed tail, and the rows
// around where the reader is. Rows the reader scrolled away from are let go; scrolling back asks for them again.
import type { ProtocolClient } from './api.ts';
import { TAIL_RANGE, viewRun, windowRuns, type HeldWindow, type WindowRun } from './positioned.ts';
import type { SessionFold } from './session-state.ts';

/** Where the reader is: on the live tail (`follow`), reading the rows `first`..`last` of the stretch shown (`read`: the
 *  ids of the first and last rows in the reader's view; a row no record holds stands at the newest end), or opening the
 *  transcript at a record (`at`: a search hit's position, a turn's). */
export type TranscriptMove =
  | { readonly kind: 'follow' }
  | { readonly kind: 'read'; readonly first: string; readonly last: string }
  | { readonly kind: 'at'; readonly position: string };

/** Rows a page asks for past an end of the stretch shown. */
export const WINDOW_PAGE_ROWS = 96;
/** A page is asked for while fewer rows than this lie between the reader's view and an end that continues. */
export const WINDOW_LEAD_ROWS = 144;
/** The most rows held for the reader apart from the tail's range: past it, ranges far from the reader's view are let go.
 *  Wide enough that the way back down an ordinary read shows the rows it already holds, with none read again. */
export const WINDOW_VIEW_MAX_ROWS = 2_048;
/** Rows the followed tail's range may grow to while the reader follows it before it is read anew from the newest record. */
export const WINDOW_TAIL_MAX_ROWS = 192;
/** A range is let go only when all of it lies farther than this from the reader's view: a page would not be asked for
 *  there again until the reader moved a page toward it. */
const WINDOW_KEEP_ROWS = WINDOW_LEAD_ROWS + WINDOW_PAGE_ROWS;

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

/** The record of `run` that shows the row `id`, as its place in the run. */
function placeOf(held: HeldWindow, run: WindowRun, id: string): number {
  return run.positions.findIndex((position) => {
    const unit = held.units.get(position);
    return unit !== undefined && (unit.items.includes(id) || unit.rows.some((row) => row.id === id));
  });
}

/** Where the reader's view lies in the run that shows it: the records of its first and last rows, and the rows of the run
 *  before and after them. A row no record holds (a pending prompt, the running turn's rows) stands at the newest end. */
interface Reading {
  readonly run: WindowRun;
  readonly first: number;
  readonly last: number;
  readonly rowsBefore: number;
  readonly rowsAfter: number;
  /** Rows of the run up to each record: `upTo[i]` is the rows of the records before the i-th. */
  readonly upTo: readonly number[];
}

function reading(held: HeldWindow, first: string, last: string): Reading | null {
  const run = viewRun(held) ?? windowRuns(held).find((candidate) => candidate.tail);
  if (!run) return null;
  const end = run.positions.length - 1;
  const at = (id: string): number => {
    const place = placeOf(held, run, id);
    return place < 0 ? end : place;
  };
  const upTo = [0];
  for (const position of run.positions) upTo.push(upTo.at(-1)! + (held.units.get(position)?.rows.length ?? 0));
  const from = Math.min(at(first), at(last));
  const to = Math.max(at(first), at(last));
  return { run, first: from, last: to, rowsBefore: upTo[from]!, rowsAfter: upTo[end + 1]! - upTo[to + 1]!, upTo };
}

/** The ranges of the reader's run to keep: all of them, less those far from the view on the side `newest` names, let go
 *  from the far end while the rows held and a page more exceed the reader's bound. */
function keptNear(held: HeldWindow, at: Reading, newest: boolean): Set<string> {
  const place = new Map(at.run.positions.map((position, index) => [position, index]));
  const span = (id: string): { from: number; to: number } => {
    const places = (held.ranges.find((range) => range.id === id)?.positions ?? []).map((position) => place.get(position) ?? 0);
    return { from: Math.min(...places), to: Math.max(...places) };
  };
  // Rows between the view and the nearest record of the range.
  const away = (id: string): number => {
    const { from, to } = span(id);
    if (from > at.last) return at.upTo[from]! - at.upTo[at.last + 1]!;
    if (to < at.first) return at.upTo[at.first]! - at.upTo[to + 1]!;
    return 0;
  };
  const kept = new Set(at.run.ranges);
  const far = at.run.ranges
    .filter((id) => id !== TAIL_RANGE && (newest ? span(id).from > at.last : span(id).to < at.first))
    .sort((a, b) => away(b) - away(a));
  for (const id of far) {
    const rest = [...kept].filter((other) => other !== TAIL_RANGE);
    if (rowsOfRanges(held, rest) + WINDOW_PAGE_ROWS <= WINDOW_VIEW_MAX_ROWS || away(id) <= WINDOW_KEEP_ROWS) break;
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
    case 'read': {
      const at = reading(held, move.first, move.last);
      if (!at) return null;
      const { run } = at;
      // Near both ends (a short stretch), the older one is paged first; the other is asked by the reader's next move.
      const older = run.older !== null && at.rowsBefore < WINDOW_LEAD_ROWS;
      const newer = !run.tail && run.newer !== null && at.rowsAfter < WINDOW_LEAD_ROWS;
      if (!older && !newer) return null;
      const kept = keptNear(held, at, older);
      // The followed tail's own range stays with its run; apart from the reader's stretch it stays while it is small.
      if (run.tail || tailKept) kept.add(TAIL_RANGE);
      return asked(
        kept,
        older
          ? { at: 'before', position: run.positions[0]!, rows: WINDOW_PAGE_ROWS }
          : { at: 'after', position: run.positions.at(-1)!, rows: WINDOW_PAGE_ROWS }
      );
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
