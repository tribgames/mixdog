/**
 * Paced reveal of the live assistant part.
 *
 * Streamed text reaches the renderer unevenly: steady deltas every few tens
 * of milliseconds, then multi-second stalls that end in a burst (some
 * providers deliver a whole reply after a tool call at once). Revealing each
 * arrival the frame it lands makes the reply jump; this playout buffer
 * instead releases the received text word by word.
 *
 * - Unit: whole words (Intl word segments; a word longer than
 *   LONG_WORD_CHARS falls back to graphemes). Whitespace and markdown markers
 *   join the word after them. While streaming, the final segment is held: it
 *   may still be an unfinished word.
 * - Cost: rates, lag and the reveal budget count graphemes; a whitespace or
 *   marker run counts as one, since it paints nothing on its own.
 * - Steady rate: the row's sustained inbound rate (cost since its first
 *   arrival over at least 1 s), so a stall counts as silence instead of
 *   compressing the burst it ends with. Near the received end the reveal
 *   slows down instead of stalling and then jumping.
 * - Catch-up: a backlog drains toward PACER_TARGET_LAG_MS of lag, capped at
 *   PACER_MAX_RATE; past PACER_MAX_LAG_CHARS behind, the excess drains fast.
 *   Completion drains the rest within PACER_DRAIN_MS.
 * - Received text is never delayed upstream: canonical text, persistence,
 *   copy and tools all read the full text. Only what the live row paints is
 *   paced.
 * - Reduced motion and hidden documents reveal everything at once; a frame
 *   gap is capped at 100 ms; all rows share one animation frame loop.
 * - State lives in a registry keyed by the row key, so a row that remounts
 *   (virtualization) continues where it was instead of replaying.
 */
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cancelLayoutFrame, scheduleLayoutFrame } from './interaction-frame-scheduler';
import { setStreamPacerBacklogProbe } from './transcript-stream-metrics';

export const PACER_FRAME_CAP_MS = 100;
// Under the 250 ms completion budget, leaving a frame for the settled commit.
export const PACER_DRAIN_MS = 230;
/** Ceiling of the steady and catch-up reveal, graphemes per second. */
export const PACER_MAX_RATE = 350;
/** A backlog drains toward this much display lag. */
export const PACER_TARGET_LAG_MS = 550;
/** The reveal never stays further behind the received text than this. */
export const PACER_MAX_LAG_CHARS = 600;
/** Time constant that drains a backlog beyond PACER_MAX_LAG_CHARS. */
const OVER_LAG_DRAIN_MS = 300;
const SUSTAINED_MIN_SPAN_MS = 1_000;
const MIN_RATE = 30;
/** Within this many characters of the received end, the reveal slows down. */
const NEAR_END_CHARS = 20;
const NEAR_END_MIN_FACTOR = 0.35;
/** A single arrival far beyond any lag is not replayed: it jumps. */
const MAX_BACKLOG_CHARS = 4_000;
/** A longer "word" (URL, unspaced script) reveals grapheme by grapheme. */
const LONG_WORD_CHARS = 24;
/** An unseen live row longer than this, in a pane that was not watching the
 *  stream (it mounted mid-stream): show it whole. */
const FRESH_ROW_MAX_CHARS = 600;
/** Rows of a session mounted in a pane at least this long before a live row
 *  was born there: that pane was showing the session (a pane's own first
 *  commits, live row included, land within it). */
const WATCH_SETTLE_MS = 200;
const REGISTRY_LIMIT = 64;
/** Markdown that is not healable at a cut right after it. */
const UNCLEAN_BEFORE_CUT = /[`*_~[\]()<>#|\\!]/;
const CUT_SNAP_LIMIT = 8;
/** A segment made only of these paints nothing at the end of a reveal. */
const SILENT_SEGMENT = /^[`*_~[\]()<>#|\\!\s]+$/;

let graphemes: Intl.Segmenter | null = null;
let words: Intl.Segmenter | null = null;
function graphemeSegmenter(): Intl.Segmenter {
  graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return graphemes;
}
function wordSegmenter(): Intl.Segmenter {
  words ??= new Intl.Segmenter(undefined, { granularity: 'word' });
  return words;
}

export class TranscriptTextPacer {
  target = '';
  shown = 0;
  /** Pending reveal ends (word ends, or grapheme ends inside a long word). */
  private bounds: number[] = [];
  /** Reveal cost (see segmentCost) from the text start to each bound. */
  private costs: number[] = [];
  private head = 0;
  private shownCost = 0;
  private targetCost = 0;
  /** Start of the final segment, and the cost before it: appends
   *  resegment from here. */
  private tailStart = 0;
  private tailStartCost = 0;
  /** The segment before the final one is silent (whitespace or markers). */
  private tailAfterSilent = false;
  private credit = 0;
  private lastTick = -1;
  private firstArrivalAt = Number.NaN;
  /** Reveal cost received since the first arrival. */
  private received = 0;
  /** Streaming ended (settle was called). */
  settled = false;
  private drainDeadline = Number.POSITIVE_INFINITY;

  constructor(text = '', revealed = false, now = Number.NaN) {
    if (revealed) {
      this.target = text;
      this.shown = text.length;
      this.segmentFrom(0, 0, false);
      this.shownCost = this.targetCost;
    } else if (text) {
      this.push(text, now);
    }
  }

  get pending(): number {
    return this.bounds.length - this.head;
  }

  /** Some received text is not painted (queued, or a held final word). */
  get unrevealed(): boolean {
    return this.shown < this.target.length;
  }

  get text(): string {
    return this.shown >= this.target.length ? this.target : this.target.slice(0, this.shown);
  }

  private pushBound(end: number, cost: number): void {
    this.bounds.push(end);
    this.costs.push(cost);
  }

  /** Queue the reveal ends of `target` from `from` (a segment start whose
   *  preceding cost is `fromCost`; `afterSilent`: the segment before it is
   *  silent). */
  private segmentFrom(from: number, fromCost: number, afterSilent: boolean): void {
    const segments = [...wordSegmenter().segment(this.target.slice(from))];
    let cost = fromCost;
    let previousSilent = afterSilent;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index].segment;
      const start = from + segments[index].index;
      const end = start + segment.length;
      const last = index === segments.length - 1;
      if (last) {
        this.tailStart = start;
        this.tailStartCost = cost;
        this.tailAfterSilent = previousSilent;
      }
      if (SILENT_SEGMENT.test(segment)) {
        // A run of silent segments (the segmenter splits `***` or `\n\n`)
        // is one step.
        if (!previousSilent) cost += 1;
        previousSilent = true;
        continue;
      }
      previousSilent = false;
      if (segment.length > LONG_WORD_CHARS) {
        const clusters = [...graphemeSegmenter().segment(segment)];
        // A streaming final word may continue: its last cluster waits.
        const count = last && !this.settled ? clusters.length - 1 : clusters.length;
        for (let at = 0; at < clusters.length; at += 1) {
          cost += 1;
          const clusterEnd = start + clusters[at].index + clusters[at].segment.length;
          if (at < count && clusterEnd > this.shown) this.pushBound(clusterEnd, cost);
        }
      } else {
        cost += graphemeCount(segment);
        if ((!last || this.settled) && end > this.shown) this.pushBound(end, cost);
      }
    }
    this.targetCost = cost;
  }

  /** Drop queued ends inside the final segment and queue it again. */
  private resegmentTail(): void {
    const from = Math.min(this.tailStart, this.target.length);
    while (this.pending > 0 && this.bounds[this.bounds.length - 1] > from) {
      this.bounds.pop();
      this.costs.pop();
    }
    this.segmentFrom(from, this.tailStartCost, this.tailAfterSilent);
  }

  private compact(): void {
    if (this.head > 512) {
      this.bounds = this.bounds.slice(this.head);
      this.costs = this.costs.slice(this.head);
      this.head = 0;
    }
  }

  /** The latest received text. Append-only growth queues the new words;
   *  anything else restarts from the last whole word of the still-valid
   *  revealed prefix. */
  push(text: string, now: number): void {
    if (text === this.target) return;
    // An idle pacer gets no frames, so its state is stale: the first frame
    // after new text would otherwise count the whole idle gap (capped at
    // PACER_FRAME_CAP_MS) and reveal a burst in one jump.
    if (this.pending === 0 && Number.isFinite(now)) this.lastTick = now;
    if (Number.isFinite(now) && Number.isNaN(this.firstArrivalAt)) this.firstArrivalAt = now;
    const before = this.targetCost;
    if (text.startsWith(this.target)) {
      this.target = text;
      this.resegmentTail();
      this.received += Math.max(0, this.targetCost - before);
    } else {
      let common = 0;
      const limit = Math.min(this.shown, text.length);
      while (common < limit && text.charCodeAt(common) === this.target.charCodeAt(common)) common += 1;
      this.target = text;
      this.bounds = [];
      this.costs = [];
      this.head = 0;
      this.credit = 0;
      const kept = wholeWordPrefix(text, common);
      this.shown = kept.end;
      this.shownCost = kept.cost;
      // `kept.end` follows a painting word (or is the text start).
      this.segmentFrom(kept.end, kept.cost, false);
      this.received += Math.max(0, this.targetCost - kept.cost);
    }
    this.compact();
    this.capBacklog();
    // Nothing painted yet: the first whole word paints with its arrival. The
    // row opening a reply takes its first line (and the live band its step
    // below it) in the commit that mounts it; left to the frame loop's slow
    // start near the received end, that first word painted 100-500 ms after
    // the followed transcript had already moved up by the empty line.
    if (this.shown === 0 && this.head < this.bounds.length) {
      this.shown = this.bounds[this.head];
      this.shownCost = this.costs[this.head];
      this.head += 1;
    }
  }

  private capBacklog(): void {
    if (this.targetCost - this.shownCost <= MAX_BACKLOG_CHARS) return;
    const floor = this.targetCost - MAX_BACKLOG_CHARS;
    while (this.head < this.bounds.length && this.costs[this.head] < floor) this.head += 1;
    if (this.head < this.bounds.length) this.head += 1;
    if (this.head > 0 && this.bounds[this.head - 1] > this.shown) {
      this.shown = this.bounds[this.head - 1];
      this.shownCost = this.costs[this.head - 1];
    }
  }

  /** Streaming ended: the held final word joins, and whatever is left
   *  drains within PACER_DRAIN_MS. */
  settle(now: number): void {
    if (!this.settled) {
      this.settled = true;
      this.resegmentTail();
    }
    if (!Number.isFinite(this.drainDeadline)) this.drainDeadline = now + PACER_DRAIN_MS;
  }

  flush(): void {
    this.shown = this.target.length;
    this.shownCost = this.targetCost;
    this.bounds = [];
    this.costs = [];
    this.head = 0;
    this.credit = 0;
  }

  /** Reveal cost per second since the row's first arrival, over at least
   *  SUSTAINED_MIN_SPAN_MS: a stall lowers it instead of being forgotten. */
  private sustainedRate(now: number): number {
    if (Number.isNaN(this.firstArrivalAt)) return 0;
    return (this.received * 1000) / Math.max(SUSTAINED_MIN_SPAN_MS, now - this.firstArrivalAt);
  }

  /** Advance one frame; true when the revealed text changed. */
  tick(now: number): boolean {
    const dt = this.lastTick < 0 ? 1000 / 60 : Math.min(PACER_FRAME_CAP_MS, Math.max(0, now - this.lastTick));
    this.lastTick = now;
    if (this.pending === 0) {
      this.credit = 0;
      return false;
    }
    if (now >= this.drainDeadline) {
      this.flush();
      return true;
    }
    const backlog = this.targetCost - this.shownCost;
    let speed = Math.min(
      PACER_MAX_RATE,
      Math.max(MIN_RATE, this.sustainedRate(now), (backlog * 1000) / PACER_TARGET_LAG_MS)
    );
    if (backlog > PACER_MAX_LAG_CHARS) {
      speed += ((backlog - PACER_MAX_LAG_CHARS) * 1000) / OVER_LAG_DRAIN_MS;
    } else if (!this.settled && backlog < NEAR_END_CHARS) {
      speed *= Math.max(NEAR_END_MIN_FACTOR, backlog / NEAR_END_CHARS);
    }
    if (Number.isFinite(this.drainDeadline)) {
      speed = Math.max(speed, (backlog * 1000) / Math.max(dt, this.drainDeadline - now));
    }
    this.credit += (speed * dt) / 1000;
    let changed = false;
    while (this.head < this.bounds.length && this.costs[this.head] - this.shownCost <= this.credit) {
      this.credit -= this.costs[this.head] - this.shownCost;
      this.shown = this.bounds[this.head];
      this.shownCost = this.costs[this.head];
      this.head += 1;
      changed = true;
    }
    if (this.pending === 0) this.credit = 0;
    this.compact();
    return changed;
  }
}

/** Graphemes of a short segment (printable ASCII needs no segmenter). */
function graphemeCount(segment: string): number {
  if (/^[\x20-\x7e]*$/.test(segment)) return segment.length;
  let count = 0;
  for (const _ of graphemeSegmenter().segment(segment)) count += 1;
  return count;
}

/** The end of the last whole painting word at or before `limit` in `text`,
 *  and the reveal cost up to it. A run of whitespace and marker segments
 *  costs 1: it paints nothing and has no reveal end of its own. */
function wholeWordPrefix(text: string, limit: number): { end: number; cost: number } {
  let end = 0;
  let endCost = 0;
  let cost = 0;
  let previousSilent = false;
  for (const { index, segment } of wordSegmenter().segment(text)) {
    const segmentEnd = index + segment.length;
    if (segmentEnd > limit) break;
    if (SILENT_SEGMENT.test(segment)) {
      if (!previousSilent) cost += 1;
      previousSilent = true;
      continue;
    }
    previousSilent = false;
    cost += graphemeCount(segment);
    end = segmentEnd;
    endCost = cost;
  }
  return { end, cost: endCost };
}

/** Whether still-streaming `text` holds a word the pacer paints now (the
 *  bounds segmentFrom queues while streaming): a painting segment that is not
 *  the final, possibly unfinished one, or the first graphemes of a long final
 *  word. Stops at the first such word. */
export function streamingTextPaints(text: string): boolean {
  let painting: string | null = null;
  for (const { segment } of wordSegmenter().segment(text)) {
    if (painting !== null) return true;
    if (!SILENT_SEGMENT.test(segment)) painting = segment;
  }
  return painting !== null && painting.length > LONG_WORD_CHARS && graphemeCount(painting) > 1;
}

/** The revealed prefix must end where the streamed-markdown healer can close
 *  it: never right after a marker (`**`, `` ` ``, `[`, `|` …). The cut snaps
 *  back over at most a few such characters; the pacer position itself keeps
 *  advancing, so the markers appear together with the glyph after them.
 *  `live`: the text is still streaming, so its end is a cut too — a received
 *  unfinished line may stop right after a marker. */
export function cleanRevealCut(text: string, cut: number, live = false): number {
  if (cut <= 0 || cut > text.length || (cut === text.length && !live)) return Math.max(0, Math.min(cut, text.length));
  let at = cut;
  while (at > 0 && cut - at < CUT_SNAP_LIMIT && UNCLEAN_BEFORE_CUT.test(text[at - 1])) at -= 1;
  if (cut - at >= CUT_SNAP_LIMIT) return cut;
  // Never split a surrogate pair.
  const code = text.charCodeAt(at - 1);
  if (at > 0 && code >= 0xd800 && code <= 0xdbff) at -= 1;
  return at;
}

interface PacerEntry {
  pacer: TranscriptTextPacer;
  listeners: Set<() => void>;
  /** Bumped on every revealed change: the store version rows subscribe to. */
  version: number;
}

const registry = new Map<string, PacerEntry>();
/** Pane-local pacers of mounted rows (a pane that mounted mid-stream). */
const ownEntries = new Set<PacerEntry>();
const active = new Set<PacerEntry>();
/** The pacer's job on the shared layout frame (interaction-frame-scheduler).
 *  Lane publications land on that same frame, and both reach rows as
 *  external-store updates, so a frame's received text and its paced reveal
 *  render as ONE commit. On its own rAF with a reducer, the reveal rendered
 *  in a separate task after the lane's commit: two renders, two layouts and
 *  two row measurements per frame, the reveal painting a frame late. */
const PACER_FRAME = {};
let scheduled = false;

function notify(entry: PacerEntry): void {
  entry.version += 1;
  for (const listener of [...entry.listeners]) listener();
}

function run(): void {
  scheduled = false;
  // The clock arrivals and the drain deadline are stamped with.
  const now = performance.now();
  for (const entry of [...active]) {
    if (entry.pacer.tick(now)) notify(entry);
    if (entry.pacer.pending === 0) active.delete(entry);
  }
  schedule();
}

function schedule(): void {
  if (scheduled || active.size === 0 || typeof requestAnimationFrame !== 'function') return;
  scheduled = true;
  scheduleLayoutFrame(PACER_FRAME, run);
}

function flushAll(): void {
  for (const entry of [...registry.values(), ...ownEntries]) {
    if (!entry.pacer.unrevealed) continue;
    entry.pacer.flush();
    active.delete(entry);
    notify(entry);
  }
  cancelLayoutFrame(PACER_FRAME);
  scheduled = false;
}

if (typeof document !== 'undefined') {
  // A hidden pane gets no frames: show its text whole instead of queueing.
  // Shown again: anything queued meanwhile resumes on the frame loop.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushAll();
    else schedule();
  });
}
setStreamPacerBacklogProbe(() => active.size > 0);

function pacingDisabled(): boolean {
  if (typeof document !== 'undefined' && document.hidden) return true;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function remember(key: string, entry: PacerEntry): void {
  registry.delete(key);
  registry.set(key, entry);
  while (registry.size > REGISTRY_LIMIT) {
    const oldest = registry.keys().next().value as string;
    const evicted = registry.get(oldest);
    if (evicted) active.delete(evicted);
    registry.delete(oldest);
  }
}

/** Per pane (its transcript's DOM root), per session: mounted transcript
 *  rows (user prompts included) and when the first of them mounted. */
const watching = new WeakMap<Element, Map<string, { rows: number; since: number }>>();

/** The pane a row element belongs to: its transcript's virtual space, or
 *  the outermost ancestor below the body. */
function paneRoot(element: Element): Element {
  const space = element.closest('.transcript-virtual-space');
  if (space) return space;
  let root = element;
  while (root.parentElement && root.parentElement !== document.body) root = root.parentElement;
  return root;
}

/** This pane showed the session since before `at` (by more than its own
 *  first commits take), so it watched the row born at `at` arrive. */
function paneWatched(pane: Element, scope: string, at: number): boolean {
  const session = watching.get(pane)?.get(scope);
  return Boolean(session) && at - (session?.since ?? at) >= WATCH_SETTLE_MS;
}

function watchPane(pane: Element, scope: string, now: number): () => void {
  let sessions = watching.get(pane);
  if (!sessions) {
    sessions = new Map();
    watching.set(pane, sessions);
  }
  const session = sessions.get(scope) ?? { rows: 0, since: now };
  session.rows += 1;
  sessions.set(scope, session);
  return () => {
    session.rows -= 1;
    if (session.rows <= 0 && sessions.get(scope) === session) sessions.delete(scope);
  };
}

/** More than FRESH_ROW_MAX_CHARS graphemes. */
function exceedsFreshRow(text: string): boolean {
  if (text.length <= FRESH_ROW_MAX_CHARS) return false;
  let count = 0;
  for (const _ of graphemeSegmenter().segment(text)) {
    count += 1;
    if (count > FRESH_ROW_MAX_CHARS) return true;
  }
  return false;
}

export interface PacedTranscriptText {
  /** What the row paints. */
  text: string;
  /** Streaming ended but the reveal is still draining. */
  draining: boolean;
}

function resolve(key: string, text: string, streaming: boolean, pace: boolean, now: number): PacedTranscriptText {
  let entry = registry.get(key);
  if (!pace || pacingDisabled()) {
    if (entry?.pacer.unrevealed) {
      entry.pacer.push(text, now);
      entry.pacer.flush();
      active.delete(entry);
    }
    return { text, draining: false };
  }
  if (!entry) {
    if (!streaming) return { text, draining: false };
    // A part's first burst is paced like any backlog; a pane that did not
    // watch it arrive shows it whole instead (usePacedTranscriptText).
    entry = {
      pacer: new TranscriptTextPacer(text, false, now),
      listeners: new Set(),
      version: 0,
    };
    remember(key, entry);
  }
  return paint(entry, text, streaming, now);
}

/** Feed `entry` the received text and return what it paints. */
function paint(entry: PacerEntry, text: string, streaming: boolean, now: number): PacedTranscriptText {
  entry.pacer.push(text, now);
  if (!streaming) entry.pacer.settle(now);
  if (entry.pacer.pending > 0) {
    active.add(entry);
    schedule();
  }
  const pacer = entry.pacer;
  const shown =
    pacer.pending > 0 || streaming ? cleanRevealCut(pacer.target, pacer.shown, streaming) : pacer.target.length;
  return {
    text: shown >= text.length ? text : text.slice(0, shown),
    draining: !streaming && pacer.pending > 0,
  };
}

interface RowBirth {
  at: number;
  /** Received text when this instance first saw the row live. */
  text: string;
  long: boolean;
}

/** Pace the painted text of one live assistant part. `pace` false (the row is
 *  no longer the newest content row, or it never streamed) shows it whole.
 *  Every transcript row passes its session `scope` and its element, live or
 *  not: rows mounted in the same pane before a live row was born there mean
 *  that pane watched it arrive. A long live row this pane did not watch
 *  arrive (the pane mounted mid-stream) shows what it already received
 *  whole; only later growth is paced. */
export function usePacedTranscriptText({
  key,
  scope = '',
  element,
  text,
  streaming,
  pace,
}: {
  key: string;
  scope?: string;
  element?: RefObject<Element | null>;
  text: string;
  streaming: boolean;
  pace: boolean;
}): PacedTranscriptText {
  /** This pane's own pacer for a row it did not watch arrive: seeded with
   *  the text received so far, revealed; the shared entry is untouched. */
  const [own, setOwn] = useState<PacerEntry | null>(null);
  const ownRef = useRef<PacerEntry | null>(null);
  const birth = useRef<RowBirth | null>(null);
  const decided = useRef(false);
  // Pushing received text is idempotent, so it happens while rendering: the
  // commit that receives a burst already paints its first paced frame.
  const enabled = Boolean(key) && pace;
  const now = performance.now();
  if (!birth.current && enabled && streaming) {
    birth.current = { at: now, text, long: exceedsFreshRow(text) };
  }
  let result: PacedTranscriptText;
  if (!own) {
    result = resolve(key, text, streaming, enabled, now);
  } else if (enabled && !pacingDisabled()) {
    result = paint(own, text, streaming, now);
  } else {
    // Pacing ended for this pane's own pacer: show it whole. The shared
    // entry belongs to the panes that watched the row arrive; never touch it.
    if (own.pacer.unrevealed) {
      own.pacer.push(text, now);
      own.pacer.flush();
      active.delete(own);
    }
    result = { text, draining: false };
  }
  useLayoutEffect(() => {
    const pane = element?.current ? paneRoot(element.current) : null;
    return pane && scope ? watchPane(pane, scope, performance.now()) : undefined;
  }, [element, scope]);
  const born = birth.current !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: born flips when the birth ref is set during render, and key identifies the row; both must re-run this before-paint decision though only refs are read.
  useLayoutEffect(() => {
    const seen = birth.current;
    if (!seen || decided.current) return;
    decided.current = true;
    if (!seen.long) return;
    const pane = element?.current ? paneRoot(element.current) : null;
    if (pane && scope && paneWatched(pane, scope, seen.at)) return;
    // Before paint: this pane mounted with the row mid-stream. Other panes
    // keep the shared pacing state as it is.
    const entry = {
      pacer: new TranscriptTextPacer(seen.text, true, seen.at),
      listeners: new Set<() => void>(),
      version: 0,
    };
    ownRef.current = entry;
    setOwn(entry);
  }, [born, element, key, scope]);
  useEffect(() => {
    if (!own) return undefined;
    ownEntries.add(own);
    return () => {
      ownEntries.delete(own);
    };
  }, [own]);
  // An external store, like the lane: a reveal notified from the shared
  // frame batches into the same synchronous commit as that frame's lane
  // publication (see PACER_FRAME).
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!enabled) return () => {};
      const entry = own ?? registry.get(key);
      if (!entry) return () => {};
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        // Nobody paints it any more: no frames are spent on it off screen. A
        // shared entry this instance left for its own keeps its pacing for
        // the panes that watched the row arrive.
        const leftForOwn = ownRef.current !== null && entry !== ownRef.current;
        if (!leftForOwn && entry.listeners.size === 0 && entry.pacer.unrevealed) {
          entry.pacer.flush();
          active.delete(entry);
        }
      };
    },
    [enabled, key, own]
  );
  const readVersion = useCallback(
    () => (enabled ? ((own ?? registry.get(key))?.version ?? 0) : 0),
    [enabled, key, own]
  );
  useSyncExternalStore(subscribe, readVersion, readVersion);
  // A settled, fully revealed row needs no registry entry (a pane with its
  // own pacer leaves the shared one to the panes using it).
  useEffect(() => {
    if (!own && !streaming && !result.draining) {
      const entry = registry.get(key);
      if (entry && entry.pacer.settled && entry.pacer.pending === 0) registry.delete(key);
    }
  }, [key, own, streaming, result.draining]);
  return result;
}
