/**
 * Paced reveal of the live assistant part.
 *
 * Streamed text reaches the renderer every few tens of milliseconds (the
 * unfinished line is published too), still unevenly: provider bursts and
 * stalls pass straight through. Revealing each arrival the frame it lands
 * makes the reply jump; this playout buffer instead releases the received
 * text grapheme by grapheme at the measured inbound rate, keeping a small
 * reserve (0.08–0.25 s) so the reveal does not starve between arrivals.
 *
 * - Received text is never delayed upstream: canonical text, persistence,
 *   copy and tools all read the full text. Only what the live row paints is
 *   paced.
 * - A backlog of about 8 lines, or text that has waited 120 ms past its
 *   cushion, switches to catch-up; it exits below ~2 lines / 40 ms after
 *   250 ms. Completion drains the rest within 250 ms.
 * - Reduced motion and hidden documents reveal everything at once; a frame
 *   gap is capped at 100 ms; all rows share one animation frame loop.
 * - State lives in a registry keyed by the row key, so a row that remounts
 *   (virtualization) continues where it was instead of replaying.
 */
import { useEffect, useReducer } from 'react';
import { setStreamPacerBacklogProbe } from './transcript-stream-metrics';

export const PACER_CUSHION_MIN_MS = 80;
export const PACER_CUSHION_MAX_MS = 250;
export const PACER_DEFAULT_CUSHION_MS = 120;
export const PACER_FRAME_CAP_MS = 100;
// Under the 250 ms completion budget, leaving a frame for the settled commit.
export const PACER_DRAIN_MS = 230;
const RATE_WINDOW_MS = 1_000;
const CUSHION_WINDOW_MS = 2_000;
const CHARS_PER_LINE = 80;
const CATCH_UP_ENTER_LINES = 8;
const CATCH_UP_ENTER_LATE_MS = 120;
const CATCH_UP_EXIT_LINES = 2;
const CATCH_UP_EXIT_LATE_MS = 40;
const CATCH_UP_MIN_MS = 250;
const CATCH_UP_DRAIN_MS = 150;
const MIN_RATE = 30;
const MAX_BACKLOG_GRAPHEMES = 1_200;
/** An unseen live row longer than this mounted mid-stream: show it whole. */
const FRESH_ROW_MAX_CHARS = 600;
const REGISTRY_LIMIT = 64;
/** Markdown that is not healable at a cut right after it. */
const UNCLEAN_BEFORE_CUT = /[`*_~[\]()<>#|\\!]/;
const CUT_SNAP_LIMIT = 8;
/** What a reveal ending on it would not paint: markers and whitespace. */
const SILENT_AT_CUT = /[`*_~[\]()<>#|\\!\s]/;
const SILENT_RUN_LIMIT = 16;

let segmenter: Intl.Segmenter | null = null;
function graphemeSegmenter(): Intl.Segmenter {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return segmenter;
}

interface Arrival {
  t: number;
  count: number;
  /** Text end offset this arrival brought in. */
  end: number;
}

export class TranscriptTextPacer {
  target = '';
  shown = 0;
  private bounds: number[] = [];
  private head = 0;
  private lastClusterStart = 0;
  private credit = 0;
  private lastTick = -1;
  private arrivals: Arrival[] = [];
  /** Inter-arrival gaps for the cushion, kept across rewrites. */
  private gaps: Array<{ t: number; gap: number }> = [];
  private lastArrivalAt = Number.NaN;
  private catchUp = false;
  private catchUpSince = 0;
  private drainDeadline = Number.POSITIVE_INFINITY;

  constructor(text = '', revealed = false) {
    this.target = text;
    this.shown = revealed ? text.length : 0;
    this.lastClusterStart = text ? this.clusterStart(text, text.length - 1) : 0;
    if (!revealed && text) this.segmentFrom(0, Number.NaN);
  }

  get pending(): number {
    return this.bounds.length - this.head;
  }

  get catchingUp(): boolean {
    return this.catchUp;
  }

  get text(): string {
    return this.shown >= this.target.length ? this.target : this.target.slice(0, this.shown);
  }

  private clusterStart(text: string, index: number): number {
    if (index <= 0) return 0;
    return graphemeSegmenter().segment(text).containing(index)?.index ?? index;
  }

  /** Segment `target` from `from` to its end into pending grapheme ends. */
  private segmentFrom(from: number, now: number): number {
    let added = 0;
    for (const { index, segment } of graphemeSegmenter().segment(this.target.slice(from))) {
      const end = from + index + segment.length;
      this.lastClusterStart = from + index;
      if (end <= this.shown) continue;
      this.bounds.push(end);
      added += 1;
    }
    if (added && Number.isFinite(now)) {
      this.arrivals.push({ t: now, count: added, end: this.target.length });
      this.noteArrival(now);
    }
    return added;
  }

  private compact(): void {
    if (this.head > 512) {
      this.bounds = this.bounds.slice(this.head);
      this.head = 0;
    }
  }

  private restartFrom(shown: number): void {
    this.shown = shown;
    this.bounds = [];
    this.head = 0;
    this.credit = 0;
    this.arrivals = [];
    this.catchUp = false;
  }

  /** The latest received text. Append-only growth queues the new graphemes;
   *  anything else restarts from the longest still-valid revealed prefix. */
  push(text: string, now: number): void {
    if (text === this.target) return;
    // An idle pacer gets no frames, so its state is stale: the first frame
    // after new text would otherwise count the whole idle gap (capped at
    // PACER_FRAME_CAP_MS) and reveal a burst in one jump, and a catch-up that
    // never saw the frame that ended it would rush the next burst.
    if (this.pending === 0 && Number.isFinite(now)) {
      this.lastTick = now;
      this.catchUp = false;
    }
    if (text.startsWith(this.target)) {
      // The final cluster may continue (a ZWJ sequence or combining mark
      // split across deltas): resegment from its start.
      const from = Math.min(this.lastClusterStart, this.target.length);
      while (this.pending > 0 && this.bounds[this.bounds.length - 1] > from) this.bounds.pop();
      if (this.head > this.bounds.length) this.head = this.bounds.length;
      this.target = text;
      this.segmentFrom(Math.max(from, 0), now);
    } else {
      let common = 0;
      const limit = Math.min(this.shown, text.length);
      while (common < limit && text.charCodeAt(common) === this.target.charCodeAt(common)) common += 1;
      this.target = text;
      const shown = common >= text.length ? text.length : this.clusterStart(text, common);
      this.restartFrom(shown);
      if (shown < text.length) this.segmentFrom(shown, now);
      else this.lastClusterStart = this.clusterStart(text, text.length - 1);
    }
    this.compact();
    this.capBacklog();
  }

  private capBacklog(): void {
    const overflow = this.pending - MAX_BACKLOG_GRAPHEMES;
    if (overflow <= 0) return;
    this.head += overflow;
    this.shown = this.bounds[this.head - 1];
  }

  /** Streaming ended: whatever is left drains within PACER_DRAIN_MS. */
  settle(now: number): void {
    if (!Number.isFinite(this.drainDeadline)) this.drainDeadline = now + PACER_DRAIN_MS;
  }

  flush(): void {
    this.shown = this.target.length;
    this.bounds = [];
    this.head = 0;
    this.credit = 0;
  }

  private inboundRate(now: number): number {
    while (this.arrivals.length > 0 && this.arrivals[0].t < now - RATE_WINDOW_MS) this.arrivals.shift();
    if (this.arrivals.length === 0) return 0;
    let total = 0;
    for (const arrival of this.arrivals) total += arrival.count;
    const span = Math.max(100, Math.min(RATE_WINDOW_MS, now - this.arrivals[0].t + this.cushionMs()));
    return (total * 1000) / span;
  }

  /** Reserve: the longest inter-arrival gap of the last CUSHION_WINDOW_MS,
   *  within the cushion bounds. Text arrives every few tens of milliseconds
   *  between provider stalls; a percentile of gap COUNTS reads that as a
   *  smooth stream and leaves no reserve for the burst a stall ends with. */
  cushionMs(): number {
    if (this.gaps.length < 2) return PACER_DEFAULT_CUSHION_MS;
    let longest = 0;
    for (const { gap } of this.gaps) longest = Math.max(longest, gap);
    return Math.min(PACER_CUSHION_MAX_MS, Math.max(PACER_CUSHION_MIN_MS, longest));
  }

  private noteArrival(now: number): void {
    if (Number.isFinite(this.lastArrivalAt)) this.gaps.push({ t: now, gap: now - this.lastArrivalAt });
    this.lastArrivalAt = now;
    while (this.gaps.length > 0 && this.gaps[0].t < now - CUSHION_WINDOW_MS) this.gaps.shift();
  }

  private oldestQueuedAt(): number {
    for (const arrival of this.arrivals) if (arrival.end > this.shown) return arrival.t;
    return Number.NaN;
  }

  private backlogLines(): number {
    let lines = 0;
    for (let index = this.target.indexOf('\n', this.shown); index >= 0; index = this.target.indexOf('\n', index + 1)) {
      lines += 1;
      if (lines >= CATCH_UP_ENTER_LINES) break;
    }
    return lines + this.pending / CHARS_PER_LINE;
  }

  /** Advance one frame; true when the revealed text changed. */
  tick(now: number): boolean {
    const dt = this.lastTick < 0 ? 1000 / 60 : Math.min(PACER_FRAME_CAP_MS, Math.max(0, now - this.lastTick));
    this.lastTick = now;
    const pending = this.pending;
    if (pending === 0) {
      this.credit = 0;
      return false;
    }
    if (now >= this.drainDeadline) {
      this.flush();
      return true;
    }
    const cushion = this.cushionMs();
    const rate = this.inboundRate(now);
    const oldest = this.oldestQueuedAt();
    const late = Number.isFinite(oldest) ? now - oldest - cushion : 0;
    const lines = this.backlogLines();
    if (!this.catchUp && (lines >= CATCH_UP_ENTER_LINES || late >= CATCH_UP_ENTER_LATE_MS)) {
      this.catchUp = true;
      this.catchUpSince = now;
    } else if (
      this.catchUp &&
      now - this.catchUpSince >= CATCH_UP_MIN_MS &&
      lines < CATCH_UP_EXIT_LINES &&
      late < CATCH_UP_EXIT_LATE_MS
    ) {
      this.catchUp = false;
    }
    // Play at the inbound rate, nudged toward holding `cushion` in reserve.
    let speed = rate > 0 ? rate * Math.min(3, Math.max(0.5, 1 + 0.5 * ((pending * 1000) / (rate * cushion) - 1))) : 0;
    speed = Math.max(speed, (pending * 1000) / PACER_CUSHION_MAX_MS / 2, MIN_RATE);
    if (this.catchUp) speed = Math.max(speed, (pending * 1000) / CATCH_UP_DRAIN_MS);
    if (Number.isFinite(this.drainDeadline)) {
      speed = Math.max(speed, (pending * 1000) / Math.max(dt, this.drainDeadline - now));
    }
    // At least one grapheme every frame while text waits: on a high refresh
    // display a sub-frame rate would otherwise paint idle frames in between.
    this.credit = Math.min(pending, Math.max(1, this.credit + (speed * dt) / 1000));
    const step = Math.floor(this.credit);
    if (step <= 0) return false;
    this.credit -= step;
    this.head += step;
    // A marker or whitespace paints nothing at the end of the reveal (the cut
    // snaps back over markers, trailing whitespace renders as nothing): it
    // joins the glyph after it instead of spending a frame of its own. The
    // joined graphemes are charged to the credit, so the pace is unchanged.
    for (let extra = 0; extra < SILENT_RUN_LIMIT && this.head < this.bounds.length; extra += 1) {
      if (!SILENT_AT_CUT.test(this.target[this.bounds[this.head - 1] - 1] ?? '')) break;
      this.head += 1;
      this.credit -= 1;
    }
    this.shown = this.bounds[this.head - 1];
    this.compact();
    return true;
  }
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
}

const registry = new Map<string, PacerEntry>();
const active = new Set<PacerEntry>();
let frame = 0;

function notify(entry: PacerEntry): void {
  for (const listener of [...entry.listeners]) listener();
}

function run(now: number): void {
  frame = 0;
  for (const entry of [...active]) {
    if (entry.pacer.tick(now)) notify(entry);
    if (entry.pacer.pending === 0) active.delete(entry);
  }
  schedule();
}

function schedule(): void {
  if (frame || active.size === 0 || typeof requestAnimationFrame !== 'function') return;
  frame = requestAnimationFrame(run);
}

function flushAll(): void {
  for (const entry of [...active]) {
    entry.pacer.flush();
    active.delete(entry);
    notify(entry);
  }
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
}

if (typeof document !== 'undefined') {
  // A hidden pane gets no frames: show its text whole instead of queueing.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushAll();
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

/** Reveal the row with `key` immediately (a later row was inserted below). */
export function flushPacedTranscriptText(key: string): void {
  const entry = registry.get(key);
  if (!entry || entry.pacer.pending === 0) return;
  entry.pacer.flush();
  active.delete(entry);
  notify(entry);
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
    if (entry && entry.pacer.pending > 0) {
      entry.pacer.push(text, now);
      entry.pacer.flush();
      active.delete(entry);
    }
    return { text, draining: false };
  }
  if (!entry) {
    if (!streaming) return { text, draining: false };
    entry = {
      pacer: new TranscriptTextPacer(text, text.length > FRESH_ROW_MAX_CHARS),
      listeners: new Set(),
    };
    remember(key, entry);
  } else {
    entry.pacer.push(text, now);
  }
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

/** Pace the painted text of one live assistant part. `pace` false (the row is
 *  no longer the newest content row, or it never streamed) shows it whole. */
export function usePacedTranscriptText({
  key,
  text,
  streaming,
  pace,
}: {
  key: string;
  text: string;
  streaming: boolean;
  pace: boolean;
}): PacedTranscriptText {
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  // Pushing received text is idempotent, so it happens while rendering: the
  // commit that receives a burst already paints its first paced frame.
  const enabled = Boolean(key) && pace;
  const result = resolve(key, text, streaming, enabled, performance.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const entry = registry.get(key);
    if (!entry) return undefined;
    entry.listeners.add(rerender);
    return () => {
      entry.listeners.delete(rerender);
      // Nobody paints it any more: no frames are spent on it off screen.
      if (entry.listeners.size === 0 && entry.pacer.pending > 0) {
        entry.pacer.flush();
        active.delete(entry);
      }
    };
  }, [enabled, key]);
  // A settled, fully revealed row needs no registry entry.
  useEffect(() => {
    if (!streaming && !result.draining) {
      const entry = registry.get(key);
      if (entry && entry.pacer.pending === 0) registry.delete(key);
    }
  }, [key, streaming, result.draining]);
  return result;
}
