// What a reader of a positioned transcript asks the core to hold (`thread/window/set`): the followed tail, and the rows
// around where the reader is. Rows the reader scrolled away from are let go; scrolling back asks for them again.
import type { ProtocolClient } from './api.ts';
import {
  placeInRun,
  rangeRows,
  runLayout,
  TAIL_RANGE,
  viewRuns,
  windowRuns,
  type HeldWindow,
  type WindowRun,
} from './positioned.ts';
import type { SessionFold } from './session-state.ts';

/** Where the reader is: on the live tail (`follow`), reading the rows `first`..`last` of the stretch that shows them
 *  (`read`: the ids of the first and last rows in the reader's view; a row no record holds stands at the newest end;
 *  `end`: the view follows the end of the tail's stretch), or opening the transcript at a record (`at`: a search
 *  hit's position, a turn's, the place a reader comes back to). `reader` names who moves (a pane): a thread's window is
 *  one for all its readers, and what one asks never lets go of the stretch another stands in. */
export type TranscriptMove =
  | { readonly kind: 'follow'; readonly reader?: string }
  | {
      readonly kind: 'read';
      readonly first: string;
      readonly last: string;
      readonly end?: boolean;
      readonly reader?: string;
    }
  | { readonly kind: 'at'; readonly position: string; readonly reader?: string };

/** Rows a page asks for past an end of the stretch shown. */
export const WINDOW_PAGE_ROWS = 96;
/** A page is asked for while fewer rows than this lie between the reader's view and an end that continues. */
export const WINDOW_LEAD_ROWS = 144;
/** The most rows held for the reader apart from the tail's range: past it, ranges far from the reader's view are let go.
 *  Wide enough that the way back down an ordinary read shows the rows it already holds, with none read again. */
export const WINDOW_VIEW_MAX_ROWS = 2_048;
/** The most rows the followed tail's range holds. It grows with every record stored; past this it is let go and the
 *  core reads the tail anew from its newest records (a want that follows the tail and retains no tail range), together
 *  with the rows around a reader who is in that stretch off its end. What was let go is paged in again from above. */
export const WINDOW_TAIL_MAX_ROWS = 2_048;
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

/** The stretch that shows the rows `first`..`last`: readers of one window may each be in one. */
function showing(held: HeldWindow, first: string, last: string): WindowRun | undefined {
  const shows = (candidate: WindowRun): boolean =>
    placeInRun(held, candidate, first) >= 0 || placeInRun(held, candidate, last) >= 0;
  const tail = windowRuns(held).find((candidate) => candidate.tail);
  return [...viewRuns(held)].reverse().find(shows) ?? (tail && shows(tail) ? tail : undefined);
}

/** The stretch another reader stands in, as its last move said; undefined when the window holds none of it. */
function standsIn(held: HeldWindow, move: TranscriptMove): WindowRun | undefined {
  const runs = windowRuns(held);
  if (move.kind === 'at') return runs.find((run) => run.positions.includes(move.position));
  if (move.kind === 'follow' || move.end === true) return runs.find((run) => run.tail);
  return showing(held, move.first, move.last);
}

function reading(held: HeldWindow, first: string, last: string, onEnd: boolean): Reading | null {
  const tail = windowRuns(held).find((candidate) => candidate.tail);
  const view = viewRuns(held).at(-1);
  // Rows no record holds are the tail's, and so is a view that follows the end.
  const run = onEnd ? (tail ?? view) : (showing(held, first, last) ?? view ?? tail);
  if (!run) return null;
  const end = run.positions.length - 1;
  const at = (id: string): number => {
    const place = placeInRun(held, run, id);
    return place < 0 ? end : place;
  };
  const { upTo } = runLayout(held, run);
  const from = Math.min(at(first), at(last));
  const to = Math.max(at(first), at(last));
  return { run, first: from, last: to, rowsBefore: upTo[from]!, rowsAfter: upTo[end + 1]! - upTo[to + 1]!, upTo };
}

/** A reader's view in a stretch: the places of the records of its first and last rows. */
interface Stand {
  readonly first: number;
  readonly last: number;
}

/** The ranges of `run` a reader standing at `at` holds, the tail's own range apart: those nearest its view, the
 *  farthest let go while what is left and a page more exceed the reader's bound. A range within a page's reach of the
 *  view is never let go: it would be asked for again at once. */
function keptNear(held: HeldWindow, run: WindowRun, at: Stand): Set<string> {
  const { index: place, upTo } = runLayout(held, run);
  const spans = new Map<string, { from: number; to: number }>();
  for (const id of run.ranges) {
    if (id === TAIL_RANGE) continue;
    const places = (held.ranges.find((range) => range.id === id)?.positions ?? []).map(
      (position) => place.get(position) ?? 0
    );
    spans.set(id, { from: Math.min(...places), to: Math.max(...places) });
  }
  // Rows between the view and the nearest record of the range.
  const away = (id: string): number => {
    const { from, to } = spans.get(id)!;
    if (from > at.last) return upTo[from]! - upTo[at.last + 1]!;
    if (to < at.first) return upTo[at.first]! - upTo[to + 1]!;
    return 0;
  };
  const kept = new Set(spans.keys());
  const far = [...kept].sort((a, b) => away(b) - away(a));
  for (const id of far) {
    if (rowsOfRanges(held, kept) + WINDOW_PAGE_ROWS <= WINDOW_VIEW_MAX_ROWS || away(id) <= WINDOW_KEEP_ROWS) break;
    kept.delete(id);
  }
  return kept;
}

/** Where a reader stands in `run`, as its last move said: the records of the first and last rows of its view (a
 *  record opened: that record). null when the run shows none of it. */
function standOf(held: HeldWindow, run: WindowRun, move: TranscriptMove): Stand | null {
  if (move.kind === 'follow') return null;
  if (move.kind === 'at') {
    const at = run.positions.indexOf(move.position);
    return at < 0 ? null : { first: at, last: at };
  }
  const places = [placeInRun(held, run, move.first), placeInRun(held, run, move.last)].filter((place) => place >= 0);
  return places.length ? { first: Math.min(...places), last: Math.max(...places) } : null;
}

/** The window owes a read of its own, whatever its readers do: its followed tail has a hole, has grown past its bound,
 *  or is no longer followed (the core let the window go after a read of its own failed). `fresh`: the rows the tail
 *  held when the core last read it anew. The bound never asks for less than the core gives: a tail whose newest
 *  records alone exceed WINDOW_TAIL_MAX_ROWS is read anew once it holds twice what it was given. */
export function windowOwes(held: HeldWindow, fresh = 0): boolean {
  return (
    held.gap !== undefined ||
    !held.followTail ||
    rangeRows(held, TAIL_RANGE) > Math.max(WINDOW_TAIL_MAX_ROWS, 2 * fresh)
  );
}

/** What to ask the core to hold for `move`, from the window held now; null when what it holds already serves it.
 *  `keep` moves no reader: it asks for what the window owes and its readers stand near, and is how a hole is read
 *  and a tail bounded while no reader moves. One definition serves both, so neither lets go of what the other keeps.
 *  `others`: where the thread's other readers stand (their last moves).
 *
 *  What is held: the followed tail's range, and for each reader the ranges nearest its view (`keptNear`), in whichever
 *  stretch it stands; nothing else. A range is kept while any reader holds it, so readers far apart in one stretch
 *  each keep their own rows and the pages between them go. The window is therefore at most WINDOW_TAIL_MAX_ROWS and,
 *  for each reader, WINDOW_VIEW_MAX_ROWS and the page it asks for, however far any of them pages and however long
 *  another stands still. A tail past its bound is read anew all the same: a reader off its end keeps the rows around
 *  its view, as a stretch of its own. */
export function windowWant(
  held: HeldWindow,
  move: TranscriptMove | { readonly kind: 'keep' },
  others: readonly TranscriptMove[] = [],
  /** Whether what the window owes is asked for now (`windowOwes`, less a read that failed and is not due again). */
  owes: boolean = windowOwes(held)
): WindowWant | null {
  const runs = windowRuns(held);
  const tail = runs.find((run) => run.tail);
  // What the other readers hold: in the stretches apart, and in the tail's (off its end). Read when a want is made:
  // a move the window already serves looks at nobody else.
  let known: { apart: Set<string>; tail: Set<string>; stands: Stand[] } | undefined;
  const theirs = (): { apart: Set<string>; tail: Set<string>; stands: Stand[] } => {
    if (known) return known;
    known = { apart: new Set(), tail: new Set(), stands: [] };
    for (const other of others) {
      if (other.kind === 'follow' || (other.kind === 'read' && other.end === true)) continue;
      const run = standsIn(held, other);
      const stand = run && standOf(held, run, other);
      if (!run || !stand) continue;
      for (const id of keptNear(held, run, stand)) (run.tail ? known.tail : known.apart).add(id);
      if (run.tail) known.stands.push(stand);
    }
    return known;
  };
  // The followed tail's range is the standing hold on what arrives. It is kept while its stretch is within
  // WINDOW_TAIL_MAX_ROWS, whole and followed; otherwise it is read anew (`grown`: past its bound, with a hole, or
  // let go by the core).
  const tailHeld = held.ranges.some((range) => range.id === TAIL_RANGE);
  const grown = owes;
  const around = (run: WindowRun, rows: readonly number[], stand: Stand): WindowRangeWant => ({
    at: 'around',
    position: run.positions[stand.first]!,
    before: WINDOW_PAGE_ROWS,
    after: rows[stand.last + 1]! - rows[stand.first]! + WINDOW_PAGE_ROWS,
  });
  // Through a tail read anew, each reader off its end keeps the rows around its view.
  const theirRows = (): WindowRangeWant[] => {
    const { stands } = theirs();
    if (!tail || !stands.length) return [];
    const { upTo } = runLayout(held, tail);
    return stands.map((stand) => around(tail, upTo, stand));
  };
  const asked = (kept: Iterable<string>, ...add: WindowRangeWant[]): WindowWant => ({
    ranges: [...[...new Set(kept)].map(retain), ...add],
    followTail: true,
    pinned: [],
  });
  /** The window with its tail read anew: no range of the tail's stretch is retained. */
  const anew = (kept: Iterable<string>, ...add: WindowRangeWant[]): WindowWant =>
    asked([...kept, ...theirs().apart], ...add, ...theirRows());
  /** The window with its tail as it is. */
  const within = (kept: Iterable<string>, ...add: WindowRangeWant[]): WindowWant =>
    asked([...(tailHeld ? [TAIL_RANGE] : []), ...kept, ...theirs().apart, ...theirs().tail], ...add);
  /** What a reader at the end of the tail's stretch holds of the pages above the tail's range. */
  const atEnd = (): Set<string> => {
    if (!tail) return new Set();
    const end = tail.positions.length - 1;
    return keptNear(held, tail, { first: end, last: end });
  };
  switch (move.kind) {
    case 'keep':
      return grown ? anew([]) : null;
    case 'follow': {
      if (grown) return anew([]);
      // A reader that stood elsewhere holds that no more: what no other reader is near is let go.
      const want = within(atEnd());
      const kept = new Set(want.ranges.map((range) => (range as { id: string }).id));
      const same =
        held.followTail && kept.size === held.ranges.length && held.ranges.every((range) => kept.has(range.id));
      return same ? null : want;
    }
    case 'read': {
      const at = reading(held, move.first, move.last, move.end === true);
      if (!at) return grown ? anew([]) : null;
      const { run } = at;
      if (grown) {
        // A reader at the end is shown the tail read anew; one elsewhere in its stretch keeps the rows around the
        // view, as a stretch of its own until the tail read anew reaches it; one in a stretch apart keeps its rows there.
        if (!run.tail) return anew(keptNear(held, run, at));
        if (move.end === true) return anew([]);
        return anew([], around(run, at.upTo, at));
      }
      // Near both ends (a short stretch), the older one is paged first; the other is asked by the reader's next move.
      const older = run.older !== null && at.rowsBefore < WINDOW_LEAD_ROWS;
      const newer = !run.tail && run.newer !== null && at.rowsAfter < WINDOW_LEAD_ROWS;
      if (!older && !newer) return null;
      return within(
        keptNear(held, run, at),
        older
          ? { at: 'before', position: run.positions[0]!, rows: WINDOW_PAGE_ROWS }
          : { at: 'after', position: run.positions.at(-1)!, rows: WINDOW_PAGE_ROWS }
      );
    }
    case 'at': {
      if (runs.some((run) => run.positions.includes(move.position))) return null;
      const here: WindowRangeWant = {
        at: 'around',
        position: move.position,
        before: WINDOW_PAGE_ROWS,
        after: WINDOW_PAGE_ROWS,
      };
      return grown ? anew([], here) : within([], here);
    }
  }
}

/** A reader's move, or the read of what the window owes while none moves. */
type Step = TranscriptMove | { readonly kind: 'keep' };
interface Asked {
  move: Step;
  readonly settle: ((served: boolean) => void)[];
}
interface Driving {
  readonly queue: Asked[];
  running: boolean;
  /** A `keep` is out: the changes that land meanwhile ask for no second one. */
  keeping?: boolean;
}
const driving = new WeakMap<object, Map<string, Driving>>();
/** Where each reader of a thread stands, as its last move said; one that follows the end stands nowhere apart. A move
 *  decided after its reader moved on (it waited behind another) keeps where that reader stands now, as any other's. */
const standing = new WeakMap<object, Map<string, Map<string, TranscriptMove>>>();
const othersOf = (client: object, threadId: string, move: Step): TranscriptMove[] => {
  const readers = standing.get(client)?.get(threadId);
  if (!readers) return [];
  return [...readers.values()].filter((stood) => stood !== move);
};
let requests = 0;
/** The window a read of what it owes failed for, by thread: its version and the rows its tail held. One rule says when
 *  that read is asked again, for every caller (a change of the thread, a reader's move): of another window (a restore,
 *  a change the core made), or once the tail holds a page more than it did. Until then the window is read as it is:
 *  its rows stay shown in their order, a hole in the tail unread, and a reader's moves page it as they page any. */
const keepFailed = new WeakMap<object, Map<string, { version: number; rows: number }>>();
/** The rows the tail held when the core last read it anew, by thread (`windowOwes`). */
const freshTail = new WeakMap<object, Map<string, number>>();
/** The thread ended (unsubscribed or lost): what the window kept of it goes with it. */
export function releaseTranscriptWindow(client: object, threadId: string): void {
  standing.get(client)?.delete(threadId);
  keepFailed.get(client)?.delete(threadId);
  freshTail.get(client)?.delete(threadId);
  // A lane still running removes itself when its queue is empty.
  if (!driving.get(client)?.get(threadId)?.running) driving.get(client)?.delete(threadId);
}

/** `needed`: a reader asks (its move), not a change of the thread. A window that holds no tail has nothing to show and
 *  nothing that grows: whoever needs its rows asks for them, whatever failed before. */
function owedNow(client: object, threadId: string, held: HeldWindow, needed = false): boolean {
  if (!windowOwes(held, freshTail.get(client)?.get(threadId))) return false;
  if (needed && rangeRows(held, TAIL_RANGE) === 0) return true;
  const failed = keepFailed.get(client)?.get(threadId);
  return !(failed?.version === held.version && rangeRows(held, TAIL_RANGE) < failed.rows + WINDOW_PAGE_ROWS);
}

/** `landed` resolves once the fold of `threadId` holds a window other than version `base` (the change asked for, or one the
 *  core made meanwhile) or holds none, or the connection that was to bring the change is no longer ready (what it owed
 *  comes with the thread's restore, or not at all). `stop` ends the watch of a change that will not be waited for. */
function windowMoved(
  client: ProtocolClient<SessionFold>,
  threadId: string,
  base: number
): { landed: Promise<void>; stop(): void } {
  let stop = (): void => undefined;
  const landed = new Promise<void>((resolve) => {
    const moved = (): boolean => client.store.thread(threadId)?.state.held?.version !== base;
    if (moved()) return resolve();
    const offStore = client.store.subscribe(() => {
      if (moved()) stop();
    });
    const offStatus = client.on((event) => {
      if (event.type === 'status' && event.status.state !== 'ready') stop();
    });
    stop = () => {
      offStore();
      offStatus();
      resolve();
    };
  });
  return { landed, stop };
}

const refused = (error: unknown): boolean => {
  const reason = (error as { detail?: { data?: { reason?: unknown } } } | null)?.detail?.data?.reason;
  return reason === 'preconditionFailed';
};

/** Whether the move is served by the window the fold holds now: a record asked for (`at`) is, only while the window
 *  holds rows of it, however the request for it ended. */
function servedBy(client: ProtocolClient<SessionFold>, threadId: string, move: Step): boolean {
  if (move.kind !== 'at') return true;
  return (client.store.thread(threadId)?.state.held?.units.get(move.position)?.rows.length ?? 0) > 0;
}

/** One move asked of the core, from the window the fold holds now. */
async function step(client: ProtocolClient<SessionFold>, threadId: string, move: Step): Promise<boolean> {
  // What the window owes is read before a reader's move is decided from it.
  const owing = client.store.thread(threadId)?.state.held;
  if (move.kind !== 'keep' && owing && owedNow(client, threadId, owing)) await step(client, threadId, { kind: 'keep' });
  const held = client.store.thread(threadId)?.state.held;
  const subscriptionId = client.threadSubscription(threadId).subscriptionId;
  if (!held || !subscriptionId) {
    // A thread no longer followed has no readers: each says where it stands again when it is.
    releaseTranscriptWindow(client, threadId);
    return false;
  }
  let owed = false;
  const wantOf = (window: HeldWindow): WindowWant | null => {
    owed = owedNow(client, threadId, window, move.kind !== 'keep');
    return windowWant(window, move, othersOf(client, threadId, move), owed);
  };
  const want = wantOf(held);
  if (!want) return servedBy(client, threadId, move);
  for (let attempt = 0; ; attempt++) {
    const base = client.store.thread(threadId)?.state.held?.version;
    if (base === undefined) return false;
    const now = attempt === 0 ? want : wantOf(client.store.thread(threadId)!.state.held!);
    if (!now) return servedBy(client, threadId, move);
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
      if (!refused(error) || attempt >= 1) {
        moved.stop();
        const now = client.store.thread(threadId)?.state.held;
        if (owed && now) {
          let failed = keepFailed.get(client);
          if (!failed) keepFailed.set(client, (failed = new Map()));
          failed.set(threadId, { version: base, rows: rangeRows(now, TAIL_RANGE) });
        }
        return false;
      }
      await moved.landed;
      continue;
    }
    await moved.landed;
    const read = owed ? client.store.thread(threadId)?.state.held : undefined;
    if (read) {
      let fresh = freshTail.get(client);
      if (!fresh) freshTail.set(client, (fresh = new Map()));
      fresh.set(threadId, rangeRows(read, TAIL_RANGE));
    }
    return servedBy(client, threadId, move);
  }
}

/** Asks the core to hold what `move` needs of the thread's positioned window. One request of a thread is out at a time; a
 *  move asked meanwhile replaces the one of the same reader still waiting, unless that one opens a record (`at`: a
 *  place asked for is always read), and is decided from the window the request before it left. Resolves with whether the
 *  move, or the one that replaced it, was served (false: the thread is not followed positioned, the core refused it, or
 *  the window it left holds no row of the record asked for). */
export function moveTranscriptWindow(
  client: ProtocolClient<SessionFold>,
  threadId: string,
  move: TranscriptMove
): Promise<boolean> {
  let stood = standing.get(client);
  if (!stood) standing.set(client, (stood = new Map()));
  let readers = stood.get(threadId);
  if (move.kind === 'follow') {
    readers?.delete(move.reader ?? '');
    if (readers?.size === 0) stood.delete(threadId);
  } else {
    if (!readers) stood.set(threadId, (readers = new Map()));
    readers.set(move.reader ?? '', move);
  }
  return drive(client, threadId, move);
}

/** Asks for what the thread's window owes while no reader moves (`windowOwes`: a hole in its tail, a tail past its
 *  bound, a window the core let go), in line with the readers' moves. Called for every change of the thread: it costs
 *  nothing while the window owes nothing, and a read that failed is asked again by the one rule (`owedNow`). */
export function keepTranscriptWindow(client: ProtocolClient<SessionFold>, threadId: string): Promise<boolean> {
  const held = client.store.thread(threadId)?.state.held;
  if (!held || !windowOwes(held, freshTail.get(client)?.get(threadId))) return Promise.resolve(true);
  if (!owedNow(client, threadId, held)) return Promise.resolve(false);
  const lined = driving.get(client)?.get(threadId);
  if (lined?.keeping || lined?.queue.some((asked) => asked.move.kind === 'keep')) return Promise.resolve(true);
  return drive(client, threadId, { kind: 'keep' });
}

function drive(client: ProtocolClient<SessionFold>, threadId: string, move: Step): Promise<boolean> {
  let threads = driving.get(client);
  if (!threads) driving.set(client, (threads = new Map()));
  let d = threads.get(threadId);
  if (!d) threads.set(threadId, (d = { queue: [], running: false }));
  const lane = d;
  const owner = threads;
  return new Promise<boolean>((resolve) => {
    // A move still waiting gives way to a later one of the same reader, and to no other's: each reader's move is
    // decided for it and answered with its own result.
    const reader = move.kind === 'keep' ? undefined : (move.reader ?? '');
    const waiting =
      reader === undefined
        ? undefined
        : lane.queue.find(
            (asked) => asked.move.kind !== 'at' && asked.move.kind !== 'keep' && (asked.move.reader ?? '') === reader
          );
    if (waiting) {
      waiting.move = move;
      waiting.settle.push(resolve);
    } else {
      lane.queue.push({ move, settle: [resolve] });
    }
    if (lane.running) return;
    lane.running = true;
    void (async () => {
      for (let next = lane.queue.shift(); next; next = lane.queue.shift()) {
        lane.keeping = next.move.kind === 'keep';
        const served = await step(client, threadId, next.move).catch(() => false);
        lane.keeping = false;
        for (const settle of next.settle) settle(served);
      }
      lane.running = false;
      if (owner.get(threadId) === lane) owner.delete(threadId);
    })();
  });
}
