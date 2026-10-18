/**
 * Paced reveal of the live assistant part.
 *
 * Streamed text reaches the renderer unevenly: steady deltas every few tens
 * of milliseconds, then stalls that end in a burst. Painting each arrival the
 * frame it lands makes the reply jump; this buffer instead reveals a growing
 * prefix of the received text.
 *
 * - Unit: graphemes. The revealed prefix always ends on a grapheme boundary,
 *   so a word grows letter by letter (its fade keeps one identity while it
 *   grows: markdown-stream-fade).
 * - Rate: every PACER_STEP_MS the reveal rate moves halfway toward the rate
 *   that drains the current backlog in PACER_TARGET_LAG_MS. A steady stream
 *   plays about that far behind its arrival; a burst eases in and out.
 * - Bounded lag: the backlog past PACER_MAX_LAG_MS of reveal at the current
 *   rate (never less than PACER_LAG_FLOOR_RATE) is caught up within
 *   PACER_CATCHUP_MS on top of the paced rate, its words fading for
 *   FADE_FLOOR_MS: a burst sweeps in fast instead of appearing at once.
 * - Hold-back: the reveal never passes an unfinished line construct of the
 *   received text, and what paints is cut back to its start
 *   (stream-reveal-hold), so table rows, headings, fence and code lines
 *   appear whole and a list item with its marker. Emphasis, links and code
 *   spans stream word by word (the healer hides their open markers).
 * - Steps run on their own PACER_STEP_MS clock; the revealed text publishes
 *   on the shared animation frame.
 * - A part's first received text paints with it (its row mounts with that
 *   text); only growth after it is paced.
 * - Commentary is not paced at all. A part the provider marks as commentary
 *   is commentary throughout; a part of unknown phase starts as commentary
 *   and becomes a final answer, paced from that point on, once it grows past
 *   COMMENTARY_MAX_GRAPHEMES or starts a block a preamble never has
 *   (answerStart). A part marked as a final answer is paced throughout.
 * - Fade: words of a final answer fade for adaptiveFadeMs of the reveal
 *   rate, so about FADE_WORDS_IN_FLIGHT words are partly transparent at once
 *   (between FINAL_FADE_MIN_MS and STREAM_FADE_DURATION_MS); commentary words
 *   fade for STREAM_FADE_COMMENTARY_MS. While a part streams nothing paints
 *   unfaded.
 * - A part settles when it ends. When the turn completes, the backlog drains
 *   within PACER_DRAIN_MS, fading for FADE_FLOOR_MS, and the row turns its
 *   fade off once those fades end; a tool call starting after the part (it
 *   is no longer the newest row) shows the rest at once.
 * - A rewrite that does not extend the received text shows it whole.
 * - Received text is never delayed upstream: canonical text, persistence,
 *   copy and tools all read the full text. Only what the live row paints is
 *   paced.
 * - No animation for reduced motion, hidden documents, a live row scrolled
 *   off screen or in a hidden pane (it shows what it received, unfaded), and
 *   replies longer than LONG_REPLY_CHARS; all rows share one animation frame
 *   loop.
 * - State lives in a registry keyed by the row key, so a row that remounts
 *   (virtualization) continues where it was instead of replaying.
 */
import {
  createContext,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { cancelLayoutFrame, scheduleLayoutFrame } from './interaction-frame-scheduler';
import { STREAM_FADE_COMMENTARY_MS, STREAM_FADE_DURATION_MS } from './markdown-stream-fade';
import { revealHold } from './stream-reveal-hold';
import { setStreamPacerBacklogProbe } from './transcript-stream-metrics';

/** One step of the reveal clock. */
export const PACER_STEP_MS = 50;
/** The reveal rate is pulled toward the backlog drained over this long. */
export const PACER_TARGET_LAG_MS = 750;
/** A backlog longer than this much reveal at the current rate is caught up
 *  down to it. */
export const PACER_MAX_LAG_MS = 2000;
/** Graphemes per second the lag bound assumes at least, so the first burst
 *  after a pause (the rate still low) is paced rather than caught up. */
export const PACER_LAG_FLOOR_RATE = 120;
/** The backlog past the lag bound is revealed within this long. */
export const PACER_CATCHUP_MS = 350;
/** When the turn completes, the backlog drains within this long. */
export const PACER_DRAIN_MS = 200;
/** Shortest fade of anything revealed while streaming or draining: caught
 *  up and drained text fades this long. */
export const FADE_FLOOR_MS = 120;
/** Shortest fade of a paced final-answer word. */
export const FINAL_FADE_MIN_MS = 200;
/** A reply longer than this (UTF-16 units) shows as it arrives, unfaded. */
const LONG_REPLY_CHARS = 16_000;
/** Share of the gap to that drain rate the reveal rate closes per step. */
const RATE_PULL = 0.5;
/** Graphemes per second the reveal never drops below while text waits. */
const MIN_RATE = 1;
/** Average graphemes per word, its trailing space included. */
const FADE_WORD_GRAPHEMES = 6;
/** Words partly transparent at once: a fade lasts this many word intervals
 *  at the reveal rate. */
export const FADE_WORDS_IN_FLIGHT = 3;
/** An unseen live row longer than this, in a pane that was not watching the
 *  stream (it mounted mid-stream): show it whole. */
const FRESH_ROW_MAX_CHARS = 600;
/** Rows of a session mounted in a pane at least this long before a live row
 *  was born there: that pane was showing the session (a pane's own first
 *  commits, live row included, land within it). */
const WATCH_SETTLE_MS = 200;
const REGISTRY_LIMIT = 64;
/** A character that paints something (not whitespace or a markdown marker). */
const PAINTING_CHAR = /[^`*_~[\]()<>#|\\!\s]/;
/** A part of unknown phase longer than this many graphemes is a final answer
 *  from there on: preambles before a tool call are a sentence or two. */
export const COMMENTARY_MAX_GRAPHEMES = 300;
/** Line starts of blocks a preamble never has: a list item, a heading, a
 *  fence, a blockquote, a table row with a leading pipe, a rule. */
const ANSWER_BLOCK =
  /^ {0,3}(?:(?:[-*+]|\d{1,9}[.)])[ \t]|#{1,6}(?:[ \t]|$)|```|~~~|>|\||([-*_])(?:[ \t]*\1){2,}[ \t]*$)/m;
/** A table delimiter row: the table starts at the line before it (a header
 *  without a leading pipe). */
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*\|/m;

let graphemes: Intl.Segmenter | null = null;
function graphemeSegmenter(): Intl.Segmenter {
  graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return graphemes;
}

/** Where a part of unknown phase stops reading as commentary: the start of
 *  its first answer-only block, or the end of its COMMENTARY_MAX_GRAPHEMES-th
 *  grapheme when more follow. -1 while it still reads as commentary. */
export function answerStart(text: string): number {
  let at = -1;
  const block = ANSWER_BLOCK.exec(text);
  if (block) at = block.index;
  const delimiter = TABLE_DELIMITER.exec(text);
  if (delimiter) {
    const header = delimiter.index > 0 ? text.lastIndexOf('\n', delimiter.index - 2) + 1 : 0;
    if (at < 0 || header < at) at = header;
  }
  if (text.length > COMMENTARY_MAX_GRAPHEMES) {
    let count = 0;
    for (const { index, segment } of graphemeSegmenter().segment(text)) {
      if (count === COMMENTARY_MAX_GRAPHEMES) {
        if (at < 0 || index < at) at = index;
        break;
      }
      if (at >= 0 && index + segment.length > at) break;
      count += 1;
    }
  }
  return at;
}

/** How long a final-answer word revealed at `rate` (graphemes per second)
 *  fades: FADE_WORDS_IN_FLIGHT word intervals, within FINAL_FADE_MIN_MS and
 *  STREAM_FADE_DURATION_MS. An unknown rate fades for the longest. */
export function adaptiveFadeMs(rate: number): number {
  if (!(rate > 0)) return STREAM_FADE_DURATION_MS;
  const ms = Math.round((FADE_WORDS_IN_FLIGHT * FADE_WORD_GRAPHEMES * 1000) / rate);
  return Math.min(STREAM_FADE_DURATION_MS, Math.max(FINAL_FADE_MIN_MS, ms));
}

export class TranscriptTextPacer {
  target = '';
  /** Reveal position: the end of the last revealed grapheme. */
  shown = 0;
  /** A part that reads as commentary: received text shows at once. A part of
   *  unknown phase is promoted to a final answer by answerStart. */
  commentary = false;
  /** How long the words revealed by the latest change fade. */
  fadeMs: number;
  /** Streaming ended (settle was called). */
  settled = false;
  /** The provider named the part commentary: never promoted. */
  private readonly fixedPhase: boolean;
  /** End of each received grapheme not revealed yet, in order. */
  private ends: number[] = [];
  private head = 0;
  /** The reveal never passes this: the hold-back of the received text. */
  private limit = 0;
  /** End of what paints; never moves back while the text only grows. */
  private painted = 0;
  /** Reveal rate, graphemes per second. */
  private rate = MIN_RATE;
  /** Fraction of a grapheme carried to the next step. */
  private carry = 0;
  /** Clock of the last step; NaN while nothing waits. */
  private stepAt = Number.NaN;
  /** Graphemes past the lag bound still to catch up, and how many per step. */
  private catchUp = 0;
  private catchUpStep = 0;
  /** Completion drain: first queued grapheme, how many, and its start. */
  private drainFrom = 0;
  private drainCount = 0;
  private drainAt = Number.NaN;
  /** After the drain: the fade stays on until its last fades end. */
  private fadeOffAt = Number.NaN;

  constructor(text = '', revealed = false, commentary = false, fixedPhase = false) {
    this.commentary = commentary;
    this.fixedPhase = fixedPhase;
    this.fadeMs = commentary ? STREAM_FADE_COMMENTARY_MS : STREAM_FADE_DURATION_MS;
    if (revealed) {
      this.target = text;
      this.shown = text.length;
      if (commentary && !fixedPhase && answerStart(text) >= 0) {
        this.commentary = false;
        this.fadeMs = STREAM_FADE_DURATION_MS;
      }
      this.repaint();
    } else if (text) {
      this.push(text);
    }
  }

  get pending(): number {
    return this.ends.length - this.head;
  }

  /** Queued graphemes the hold-back lets the reveal reach. */
  get ready(): number {
    let low = this.head;
    let high = this.ends.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.ends[middle] <= this.limit) low = middle + 1;
      else high = middle;
    }
    return low - this.head;
  }

  /** The completion drain is running, or its last fades are. */
  get draining(): boolean {
    return this.drainCount > 0 || !Number.isNaN(this.fadeOffAt);
  }

  /** The frame loop has work: a reveal step or the drain. */
  get waiting(): boolean {
    return this.draining || this.ready > 0;
  }

  /** Some received text is not painted (queued, or held back). */
  get unrevealed(): boolean {
    return this.painted < this.target.length;
  }

  get text(): string {
    return this.painted >= this.target.length ? this.target : this.target.slice(0, this.painted);
  }

  /** What paints: the reveal held back to the start of any unfinished
   *  construct, never shorter than before while the text only grows. */
  private repaint(): void {
    const cut = revealHold(this.target, this.shown, !this.settled);
    this.painted = Math.min(this.target.length, Math.max(cut, this.painted));
  }

  private compact(): void {
    if (this.head > 512) {
      this.ends = this.ends.slice(this.head);
      this.head = 0;
    }
  }

  /** The latest received text. Growth queues its graphemes; a rewrite that
   *  does not extend the received text shows it whole. */
  push(text: string): void {
    if (text === this.target) return;
    if (this.settled) {
      // Text after the end (a final rewrite) shows at once.
      if (!text.startsWith(this.target)) this.painted = 0;
      this.target = text;
      this.flush();
      return;
    }
    if (this.commentary) {
      this.fadeMs = STREAM_FADE_COMMENTARY_MS;
      const at = this.fixedPhase ? -1 : answerStart(text);
      if (at < 0) {
        if (!text.startsWith(this.target)) this.painted = 0;
        this.target = text;
        this.flush();
        return;
      }
      // Promoted: what precedes the answer start shows at once (still with
      // the commentary fade), the rest is paced.
      this.commentary = false;
      if (at > this.shown && text.startsWith(this.target)) {
        this.target = text.slice(0, at);
        this.flush();
      }
    }
    if (!text.startsWith(this.target)) {
      this.painted = 0;
      this.target = text;
      this.flush();
      return;
    }
    // The last queued grapheme may continue in the new text (a combining
    // mark, the rest of a ZWJ sequence): it is segmented again.
    if (this.pending > 0) this.ends.pop();
    const from = this.pending > 0 ? this.ends[this.ends.length - 1] : this.shown;
    this.target = text;
    for (const { index, segment } of graphemeSegmenter().segment(text.slice(from))) {
      this.ends.push(from + index + segment.length);
    }
    this.limit = revealHold(text, text.length, true);
    // Lookahead may finish a construct the reveal is inside.
    this.repaint();
  }

  /** Streaming ended. The backlog drains within PACER_DRAIN_MS, fading for
   *  FADE_FLOOR_MS. */
  settle(now = performance.now()): void {
    if (this.settled) return;
    this.settled = true;
    this.limit = this.target.length;
    this.fadeMs = FADE_FLOOR_MS;
    if (this.pending > 0) {
      this.drainFrom = this.head;
      this.drainCount = this.pending;
      this.drainAt = now;
    }
    this.repaint();
  }

  /** Everything received shows at once (still held back while it streams). */
  flush(): void {
    this.shown = this.target.length;
    this.ends = [];
    this.head = 0;
    this.carry = 0;
    this.stepAt = Number.NaN;
    this.catchUp = 0;
    this.drainCount = 0;
    this.fadeOffAt = Number.NaN;
    this.repaint();
  }

  /** Run the reveal steps due by `now`; true when the revealed text changed.
   *  The step clock starts on the first frame text waits, so an idle gap is
   *  never counted. */
  tick(now: number): boolean {
    if (this.draining) return this.drainStep(now);
    let available = this.ready;
    if (available === 0) {
      this.carry = 0;
      this.catchUp = 0;
      this.stepAt = Number.NaN;
      return false;
    }
    if (Number.isNaN(this.stepAt)) {
      this.stepAt = now;
      return false;
    }
    const steps = Math.floor((now - this.stepAt) / PACER_STEP_MS);
    if (steps <= 0) return false;
    this.stepAt += steps * PACER_STEP_MS;
    const before = this.head;
    let caughtUp = false;
    for (let step = 0; step < steps && available > 0; step += 1) {
      const bound = Math.ceil((Math.max(this.rate, PACER_LAG_FLOOR_RATE) * PACER_MAX_LAG_MS) / 1000);
      // More past the bound than the running catch-up covers: catch all of
      // it up within PACER_CATCHUP_MS from now.
      if (available - bound > this.catchUp) {
        this.catchUp = available - bound;
        this.catchUpStep = Math.ceil((this.catchUp * PACER_STEP_MS) / PACER_CATCHUP_MS);
      }
      const drain = ((available - this.catchUp) * 1000) / PACER_TARGET_LAG_MS;
      this.rate = Math.max(MIN_RATE, this.rate + (drain - this.rate) * RATE_PULL);
      this.carry += (this.rate * PACER_STEP_MS) / 1000;
      const paced = Math.min(available, Math.floor(this.carry));
      this.carry -= paced;
      const extra = Math.min(available - paced, this.catchUp, this.catchUpStep);
      if (extra > 0) caughtUp = true;
      this.catchUp -= extra;
      this.head += paced + extra;
      available -= paced + extra;
    }
    if (this.head === before) return false;
    this.shown = this.ends[this.head - 1];
    this.fadeMs = caughtUp ? FADE_FLOOR_MS : adaptiveFadeMs(this.rate);
    if (available === 0) {
      this.carry = 0;
      this.catchUp = 0;
      this.stepAt = Number.NaN;
    }
    this.compact();
    this.repaint();
    return true;
  }

  private drainStep(now: number): boolean {
    if (this.drainCount === 0) {
      // Drained: the fade turns off once the last drained words are inked.
      if (now < this.fadeOffAt) return false;
      this.fadeOffAt = Number.NaN;
      return true;
    }
    const share = Math.min(1, Math.max(0, now - this.drainAt) / PACER_DRAIN_MS);
    const head = Math.min(this.ends.length, this.drainFrom + Math.ceil(this.drainCount * share));
    if (head <= this.head) return false;
    this.head = head;
    this.shown = this.ends[head - 1];
    if (head >= this.ends.length) {
      this.flush();
      this.fadeOffAt = now + FADE_FLOOR_MS;
    } else {
      this.repaint();
    }
    return true;
  }
}

/** Whether still-streaming `text` paints anything: a row opens only with
 *  text that shows (not only whitespace or markdown markers). */
export function streamingTextPaints(text: string): boolean {
  return PAINTING_CHAR.test(text);
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
  // The reveal step clock.
  const now = performance.now();
  for (const entry of [...active]) {
    if (entry.pacer.tick(now)) notify(entry);
    if (!entry.pacer.waiting) active.delete(entry);
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

interface PacedTranscriptText {
  /** What the row paints. */
  text: string;
  /** The part reads as commentary: shown as it arrives, its words fading
   *  quickly. */
  commentary: boolean;
  /** How long newly painted words fade (0: unfaded). */
  fadeMs: number;
  /** The completion drain is running: the row still paints a prefix, with
   *  its fade on. */
  draining: boolean;
}

/** The provider's phase of a part: 'commentary', 'final_answer', or unknown. */
type PartPhase = string | undefined;

/** Commentary by phase alone, without a pacer: a part of unknown phase until
 *  its answer start. */
function unpacedCommentary(phase: PartPhase, text: string): boolean {
  if (phase === 'commentary') return true;
  return phase !== 'final_answer' && answerStart(text) < 0;
}

/** `text` shown as received, unfaded; while it streams, still held back
 *  before an unfinished construct. */
function unpaced(text: string, streaming: boolean, phase: PartPhase): PacedTranscriptText {
  const cut = streaming ? revealHold(text, text.length, true) : text.length;
  return {
    text: cut >= text.length ? text : text.slice(0, cut),
    commentary: unpacedCommentary(phase, text),
    fadeMs: 0,
    draining: false,
  };
}

/** No animation: reduced motion, a hidden document, or a very long reply. */
function stillMotion(text: string): boolean {
  return pacingDisabled() || text.length > LONG_REPLY_CHARS;
}

function resolve(
  key: string,
  text: string,
  streaming: boolean,
  pace: boolean,
  phase: PartPhase,
  onScreen: boolean
): PacedTranscriptText {
  let entry = registry.get(key);
  if (!pace || stillMotion(text)) {
    if (entry?.pacer.unrevealed) {
      entry.pacer.push(text);
      entry.pacer.flush();
      active.delete(entry);
    }
    return unpaced(text, streaming, phase);
  }
  if (!entry) {
    if (!streaming) return unpaced(text, false, phase);
    // The row mounts with its first received text, which paints with it.
    entry = {
      pacer: new TranscriptTextPacer(text, true, phase !== 'final_answer', phase === 'commentary'),
      listeners: new Set(),
      version: 0,
    };
    remember(key, entry);
  }
  return paint(entry, text, streaming, phase, onScreen);
}

/** Feed `entry` the received text and return what it paints. Off screen,
 *  with no other pane painting it, it shows what it received, unfaded. */
function paint(
  entry: PacerEntry,
  text: string,
  streaming: boolean,
  phase: PartPhase,
  onScreen: boolean
): PacedTranscriptText {
  const pacer = entry.pacer;
  // A phase named after the part started overrides the guess.
  if (phase === 'final_answer') pacer.commentary = false;
  pacer.push(text);
  if (!streaming) pacer.settle();
  if (!onScreen && entry.listeners.size === 0) {
    if (pacer.unrevealed) pacer.flush();
    active.delete(entry);
  } else if (pacer.waiting) {
    active.add(entry);
    schedule();
  }
  return {
    text: pacer.text,
    commentary: pacer.commentary,
    fadeMs: onScreen ? pacer.fadeMs : 0,
    draining: pacer.draining,
  };
}

/** True for a transcript row the list keeps mounted outside its visible range
 *  (overscan, pinned rows): TranscriptList provides it per row from the
 *  virtualizer's range, which it re-renders on every range change. */
export const TranscriptRowOffscreenContext = createContext(false);

/** Whether `element` is on screen: its row is inside the transcript's visible
 *  range and nothing above it is hidden (`display: none`, a retained pane's
 *  `content-visibility: hidden`). Re-read after each commit while `watch`; a
 *  streaming row commits on every arrival, so a pane hidden or shown mid-reply
 *  is noticed by its next burst. No IntersectionObserver: while one exists,
 *  Chromium runs a main-thread frame on every vsync for as long as any
 *  compositor animation (the live spinner) runs in the window. */
function useOnScreen(element: RefObject<Element | null> | undefined, watch: boolean): boolean {
  const offscreen = useContext(TranscriptRowOffscreenContext);
  const [shown, setShown] = useState(true);
  // The last value handed to setShown: an unchanged reading schedules nothing
  // (a same-value setState still cost the streaming row an extra commit).
  const shownRef = useRef(true);
  useEffect(() => {
    const node = element?.current;
    const next = !watch || !node || typeof node.checkVisibility !== 'function' || node.checkVisibility();
    if (next === shownRef.current) return;
    shownRef.current = next;
    setShown(next);
  });
  return !(watch && offscreen) && shown;
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
  phase,
}: {
  key: string;
  scope?: string;
  element?: RefObject<Element | null>;
  text: string;
  streaming: boolean;
  pace: boolean;
  /** The provider's phase of the part; commentary is never paced. */
  phase?: PartPhase;
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
  const onScreen = useOnScreen(element, enabled && streaming);
  const now = performance.now();
  if (!birth.current && enabled && streaming) {
    birth.current = { at: now, text, long: exceedsFreshRow(text) };
  }
  let result: PacedTranscriptText;
  if (!own) {
    result = resolve(key, text, streaming, enabled, phase, onScreen);
  } else if (enabled && !stillMotion(text)) {
    result = paint(own, text, streaming, phase, onScreen);
  } else {
    // Pacing ended for this pane's own pacer: show it whole. The shared
    // entry belongs to the panes that watched the row arrive; never touch it.
    if (own.pacer.unrevealed) {
      own.pacer.push(text);
      own.pacer.flush();
      active.delete(own);
    }
    result = unpaced(text, streaming, phase);
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
      pacer: new TranscriptTextPacer(seen.text, true, phase !== 'final_answer', phase === 'commentary'),
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
      // Off screen this row paints nothing worth pacing: with no other pane
      // subscribed, the entry shows what it received (paint).
      if (!enabled || !onScreen) return () => {};
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
    [enabled, key, own, onScreen]
  );
  const readVersion = useCallback(
    () => (enabled ? ((own ?? registry.get(key))?.version ?? 0) : 0),
    [enabled, key, own]
  );
  useSyncExternalStore(subscribe, readVersion, readVersion);
  // A settled, fully revealed row needs no registry entry (a pane with its
  // own pacer leaves the shared one to the panes using it).
  const draining = result.draining;
  useEffect(() => {
    if (!own && !streaming && !draining) {
      const entry = registry.get(key);
      if (entry?.pacer.settled && !entry.pacer.draining) registry.delete(key);
    }
  }, [key, own, streaming, draining]);
  return result;
}
