/**
 * Phrase fade-in of a streamed reply.
 *
 * The reveal (use-transcript-text-reveal) shows a growing prefix of the
 * reply. The timeline records, by offset in that revealed text, the phrase
 * each character belongs to and when it came on screen; it fades in over
 * STREAM_FADE_DURATION_MS from then, linear (22-markdown.css
 * `[data-stream-fade]`, `[data-stream-fade-box]`):
 * - Text revealed within STREAM_FADE_PHRASE_OPEN_MS of a phrase opening joins
 *   it: one start, no delay, no stagger. Later text opens the next phrase.
 * - A phrase fades from when a body first shows it (appearing / appear): a
 *   parse that lands after the reveal (a streaming tail parsed off the main
 *   thread) brings its text in with its whole fade. What has been on screen
 *   is kept as ranges, since each chunk's body shows its text on its own;
 *   until all revealed text has, the row stays live (owes).
 * - Identity is the offset: a character keeps the phrase it showed in, in
 *   whatever word, segment or element a later character or a re-parse puts
 *   it, so text already shown never fades again, and the letters that
 *   continue a word fade from their own start.
 * - Arrivals faster than STREAM_FADE_FAST_CHARS_PER_MS show unfaded.
 * - A revision of the reveal (a rewrite, or text shown while the document was
 *   hidden) and a primed first text show unfaded.
 * - The part ending: what had not shown yet shows at once as one last
 *   phrase starting then (also after fast arrivals).
 * - Nothing outlives its fade: a phrase is dropped once all of it came on
 *   screen, a stretch once it ended, and a body renders again then to unwrap
 *   it (MarkdownAstBody), so neither history nor wrapper elements stay. Past
 *   what it owes, the row is live exactly while a body shows a fade
 *   (visibleUntil): a phrase of text nothing fades in holds nothing.
 * - Render purity: read() and appearing() work out a render's pass and what
 *   a body brings on screen from what was committed, changing none of it;
 *   commit() and appear() (layout effects) record them: a render React
 *   discards changes nothing.
 *
 * Wrapping: markdown nodes carry their offset in the parsed chunk, and a
 * text node where each of its decoded characters sits (markdown-ast: escapes,
 * references, dropped container markers; markdown-plugins places the text
 * nodes it makes). Each stretch of one phrase within a
 * text node is one inline wrapper, its tag named by its first offset, so the
 * renderer's tag-and-count keys never hand one stretch's element to another.
 * A freshly created element resumes mid-fade (negative delay).
 * - Structure fades with its text: a list item's marker, a table row, a
 *   blockquote and a rule start fading with the first character inside them,
 *   and an inline code chip fades as one, so no chrome paints at full ink
 *   while its text is still transparent. Text fading together with the box
 *   around it is left to the box's fade (never faded twice).
 * - No layout: wrappers are unstyled inline elements; only opacity (and a
 *   marker's color) animates. Whitespace-only text is never wrapped; math,
 *   SVG and code blocks are left whole.
 */
import type { MarkdownAstRoot } from './markdown-ast';

/** How long a phrase fades in (the default duration in 22-markdown.css). */
export const STREAM_FADE_DURATION_MS = 400;
/** Text revealed this long after a phrase opened still joins it. */
const STREAM_FADE_PHRASE_OPEN_MS = 100;
/** Arrivals faster than this (characters per ms, over windows of at least
 *  STREAM_FADE_SPEED_WINDOW_MS) show unfaded. */
export const STREAM_FADE_FAST_CHARS_PER_MS = 1.6;
const STREAM_FADE_SPEED_WINDOW_MS = 100;
/** Arrivals stay unfaded this long after the last fast window. */
const FAST_HOLD_MS = 400;
/** read compares this much of the end of the text the last pass showed. */
const SYNC_TAIL_CHARS = 16;
/** Wrapper tags are `${STREAM_FADE_TAG}${first offset in base 36}`. */
const STREAM_FADE_TAG = 'mx-fade-';
const TIMELINE_LIMIT = 64;
/** Rendered as-is: wrapping inside typeset math or SVG would break it. */
const OPAQUE_CLASS = /\bkatex\b/;

interface FadeNode {
  type: 'root' | 'element' | 'text';
  tagName?: string;
  value?: string;
  offset?: number;
  jumps?: number[];
  properties?: Record<string, unknown>;
  children?: FadeNode[];
}

/** Characters [from, to) of a text node's value, sitting at consecutive
 *  offsets of the revealed text from `at`. */
interface FadeStretch {
  from: number;
  to: number;
  at: number;
}

/** Where the characters of text `node` sit, its first at `own`: markdown-ast
 *  records where decoding or dropped syntax breaks their run (`jumps`, offsets
 *  in the chunk at `base`). A text node with no offset has no place in the
 *  revealed text (none of this renderer's: its parser and plugins place every
 *  text node): it is never wrapped. */
function stretchesOf(node: FadeNode, own: number, base: number): FadeStretch[] {
  if (node.offset === undefined) return [];
  const length = node.value?.length ?? 0;
  const jumps = node.jumps ?? [];
  const found: FadeStretch[] = [];
  let from = 0;
  let at = own;
  for (let index = 0; index < jumps.length; index += 2) {
    if (jumps[index] > from) found.push({ from, to: jumps[index], at });
    from = jumps[index];
    at = base + jumps[index + 1];
  }
  if (length > from) found.push({ from, to: length, at });
  return found;
}

/** A text node holding [from, to) of text node `node`'s value, keeping where
 *  its characters sit (`offset`, `jumps`; unplaced if `node` was). */
export function placedTextSlice<Node extends FadeNode>(node: Node, from: number, to: number): Node {
  const value = (node.value ?? '').slice(from, to);
  if (node.offset === undefined) return { type: 'text', value } as Node;
  const jumps = node.jumps ?? [];
  const offsetAt = (index: number) => {
    let offset = node.offset! + index;
    for (let at = 0; at < jumps.length && jumps[at] <= index; at += 2) offset = jumps[at + 1] + index - jumps[at];
    return offset;
  };
  const inner: number[] = [];
  for (let at = 0; at < jumps.length; at += 2) {
    if (jumps[at] > from && jumps[at] < to) inner.push(jumps[at] - from, jumps[at + 1]);
  }
  return { type: 'text', value, offset: offsetAt(from), ...(inner.length > 0 ? { jumps: inner } : {}) } as Node;
}

/** When a stretch of revealed text starts fading, and for how long. */
export interface StreamFadeStart {
  at: number;
  ms: number;
}

/** A phrase: revealed text [from, to) that fades together, over `ms`. */
interface FadePhrase {
  from: number;
  to: number;
  ms: number;
}

/** A stretch of a phrase as it came on screen: from `at`. `phrase` names it
 *  (its `from`). */
interface FadeShown extends StreamFadeStart {
  from: number;
  to: number;
  phrase: number;
}

/** What a body's render brings on screen: the revealed text [from, to) has
 *  shown, `stretches` of it for the first time (StreamFadeTimeline.appear). */
export interface StreamFadeAppearance {
  readonly from: number;
  readonly to: number;
  readonly stretches: readonly FadeShown[];
}

/** The parts of [from, to) outside `ranges` (sorted, disjoint [from, to)
 *  pairs), as [from, to) pairs. */
function offScreen(ranges: readonly number[], from: number, to: number): Array<[number, number]> {
  const gaps: Array<[number, number]> = [];
  let at = from;
  for (let index = 0; index < ranges.length && at < to; index += 2) {
    if (ranges[index + 1] <= at) continue;
    if (ranges[index] >= to) break;
    if (ranges[index] > at) gaps.push([at, ranges[index]]);
    at = Math.max(at, ranges[index + 1]);
  }
  if (at < to) gaps.push([at, to]);
  return gaps;
}

function shownAt(ranges: readonly number[], offset: number): boolean {
  for (let index = 0; index < ranges.length; index += 2) {
    if (offset < ranges[index]) return false;
    if (offset < ranges[index + 1]) return true;
  }
  return false;
}

/** `ranges` with [from, to) added (`ranges` itself when it held it). */
function withRange(ranges: number[], from: number, to: number): number[] {
  if (from >= to || offScreen(ranges, from, to).length === 0) return ranges;
  const merged: number[] = [];
  let start = from;
  let end = to;
  for (let index = 0; index < ranges.length; index += 2) {
    if (ranges[index + 1] < start || ranges[index] > end) {
      merged.push(ranges[index], ranges[index + 1]);
      continue;
    }
    start = Math.min(start, ranges[index]);
    end = Math.max(end, ranges[index + 1]);
  }
  merged.push(start, end);
  const pairs: Array<[number, number]> = [];
  for (let index = 0; index < merged.length; index += 2) pairs.push([merged[index], merged[index + 1]]);
  return pairs.sort((left, right) => left[0] - right[0]).flat();
}

/** `ranges` cut to [0, length). */
function withinLength(ranges: readonly number[], length: number): number[] {
  const kept: number[] = [];
  for (let index = 0; index < ranges.length && ranges[index] < length; index += 2) {
    kept.push(ranges[index], Math.min(ranges[index + 1], length));
  }
  return kept;
}

/** The timeline after one render pass (StreamFadeTimeline.read). */
export interface StreamFadePass {
  /** Phrases with text not on screen yet (and the last one while it is
   *  open), in text order. */
  readonly phrases: readonly FadePhrase[];
  /** Length and end of the text the pass showed. */
  readonly length: number;
  readonly tail: string;
  /** The latest reveal revision seen. */
  readonly revision: number;
  /** When the last phrase opened while it may still take text; null: none. */
  readonly openedAt: number | null;
  readonly fast: boolean;
  readonly speed: { readonly since: number; readonly length: number; readonly fastAt: number };
}

/** A stretch of revealed text with how it fades (undefined: unfaded). */
interface FadeRun {
  from: number;
  to: number;
  start: StreamFadeStart | undefined;
}

export class StreamFadeTimeline {
  /** How long a phrase revealed from now on fades (0: not at all). */
  durationMs = STREAM_FADE_DURATION_MS;
  /** What the last committed pass left. */
  private state: StreamFadePass;
  /** The latest pass read, until it commits. */
  private pending: StreamFadePass | null = null;
  /** What each body shows fading, until when (show). */
  private readonly shown = new Map<object, number>();
  /** The revealed text that has been on screen (appear), as sorted, disjoint
   *  [from, to) pairs: bodies render their chunks independently, so an
   *  earlier chunk may still be parsing while a later one shows. */
  private onScreen: number[];
  /** Stretches on screen still fading, in text order. */
  private stretches: FadeShown[] = [];
  private readonly listeners = new Set<() => void>();
  /** Changes when what is on screen or fading does (subscribe). */
  version = 0;

  /** `primed`: the first text, shown at once: it shows unfaded. */
  constructor(now = performance.now(), primed = '') {
    this.state = {
      phrases: [],
      length: primed.length,
      tail: primed.slice(-SYNC_TAIL_CHARS),
      revision: 0,
      openedAt: null,
      fast: false,
      speed: { since: now, length: primed.length, fastAt: Number.NEGATIVE_INFINITY },
    };
    this.onScreen = primed.length > 0 ? [0, primed.length] : [];
  }

  /** Calls `listener` when what is on screen or fading changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  /** The pass of a render that shows `text` at `now` (`ended`: the part
   *  ended, `text` is all of it). It measures the arrival rate and gives the
   *  text revealed since the last pass its phrase. A rewrite shows unfaded: a
   *  `revision` above any seen, else text that shrank or whose last
   *  SYNC_TAIL_CHARS moved (the rest of the prefix is never rescanned). Ended
   *  phrases are left out. Nothing recorded changes until commit(). */
  read(text: string, now: number, revision = 0, ended = false): StreamFadePass {
    const prior = this.state;
    let { since, length: measured, fastAt } = prior.speed;
    let { fast } = prior;
    if (now - since >= STREAM_FADE_SPEED_WINDOW_MS) {
      const limit = STREAM_FADE_FAST_CHARS_PER_MS * (fast ? 0.75 : 1);
      const quick = (text.length - measured) / (now - since) > limit;
      // Two fast windows in a row turn fading off; it stays off while
      // windows are fast, and FAST_HOLD_MS after the last one.
      fast = quick ? fast || fastAt === since : fast && now - fastAt < FAST_HOLD_MS;
      if (quick) fastAt = now;
      since = now;
      measured = text.length;
    }
    let openedAt = prior.openedAt;
    const open = openedAt !== null && now - openedAt < STREAM_FADE_PHRASE_OPEN_MS;
    // A phrase all on screen lives on in its stretches; the open one still
    // takes text.
    let phrases = prior.phrases.filter(
      (phrase, index) =>
        offScreen(this.onScreen, phrase.from, phrase.to).length > 0 || (open && index === prior.phrases.length - 1)
    );
    const rewritten =
      revision > prior.revision ||
      text.length < prior.length ||
      !text.startsWith(prior.tail, prior.length - prior.tail.length);
    const added = text.slice(prior.length);
    if (rewritten) {
      phrases = [];
      openedAt = null;
    } else if (added) {
      const last = phrases[phrases.length - 1];
      if (!ended && open && last?.to === prior.length) {
        phrases = [...phrases.slice(0, -1), { ...last, to: text.length }];
      } else if (!/\S/.test(added)) {
        // Only spaces: nothing to fade.
      } else if (this.durationMs > 0 && (ended || !fast)) {
        phrases = [...phrases, { from: prior.length, to: text.length, ms: this.durationMs }];
        openedAt = now;
      } else {
        openedAt = null;
      }
    }
    const pass: StreamFadePass = {
      phrases,
      length: text.length,
      tail: text.slice(-SYNC_TAIL_CHARS),
      revision: Math.max(revision, prior.revision),
      openedAt: ended ? null : openedAt,
      fast,
      speed: { since, length: measured, fastAt },
    };
    this.pending = pass;
    return pass;
  }

  /** Whether revealed text of `length` characters has text not on screen
   *  yet (a body still parsing it): the row stays live until it shows. */
  owes(length: number): boolean {
    return offScreen(this.onScreen, 0, length).length > 0;
  }

  /** What a body's render that shows revealed text [from, to) brings on
   *  screen at `now` (nothing recorded; the body commits it with appear).
   *  Text that has been on screen keeps its stretches. A phrase's text that
   *  comes on screen now starts fading now: when it shows, not when it was
   *  revealed (a parse may land later). It joins a stretch of its phrase
   *  that came on screen less than STREAM_FADE_PHRASE_OPEN_MS before. */
  appearing(from: number, to: number, now: number): StreamFadeAppearance {
    const stretches: FadeShown[] = [];
    for (const [gapFrom, gapTo] of offScreen(this.onScreen, from, to)) {
      for (const phrase of (this.pending ?? this.state).phrases) {
        const head = Math.max(gapFrom, phrase.from);
        const end = Math.min(gapTo, phrase.to);
        if (head >= end) continue;
        const joined = this.stretches.findLast(
          (stretch) => stretch.phrase === phrase.from && now - stretch.at < STREAM_FADE_PHRASE_OPEN_MS
        );
        stretches.push({ from: head, to: end, at: joined?.at ?? now, ms: phrase.ms, phrase: phrase.from });
      }
    }
    return { from, to, stretches };
  }

  /** A body committed showing `appearance`; stretches that ended by `now`
   *  are dropped. */
  appear(appearance: StreamFadeAppearance, now: number): void {
    const fresh = appearance.stretches.filter(
      (stretch) => !this.stretches.some((known) => known.from < stretch.to && stretch.from < known.to)
    );
    const stretches = [...this.stretches, ...fresh]
      .filter((stretch) => stretch.at + stretch.ms > now)
      .sort((left, right) => left.from - right.from);
    const onScreen = withRange(this.onScreen, appearance.from, appearance.to);
    if (onScreen === this.onScreen && fresh.length === 0 && stretches.length === this.stretches.length) return;
    this.onScreen = onScreen;
    this.stretches = stretches;
    this.changed();
  }

  /** Length of the revealed text the latest pass shows. */
  revealedLength(): number {
    return (this.pending ?? this.state).length;
  }

  /** Whether anything in revealed text [from, to) may fade. */
  fadesBetween(from: number, to: number, appearing: StreamFadeAppearance): boolean {
    return appearing.stretches.length > 0 || this.stretches.some((stretch) => stretch.from < to && from < stretch.to);
  }

  /** When the last stretch on screen ends fading (0: none runs at `now`). */
  fadesUntil(now: number): number {
    let until = 0;
    for (const stretch of this.stretches)
      if (stretch.at + stretch.ms > now) until = Math.max(until, stretch.at + stretch.ms);
    return until;
  }

  /** The body `holder` shows fades until `until` (0: none): what its tree
   *  wrapped (applyStreamFade), so text nothing fades in (a code block, a
   *  markdown marker) holds nothing. Recorded as the body commits. */
  show(holder: object, until: number): void {
    if ((this.shown.get(holder) ?? 0) === until) return;
    if (until > 0) this.shown.set(holder, until);
    else this.shown.delete(holder);
    this.changed();
  }

  /** When the last fade a body shows ends (0: none runs at `now`). */
  visibleUntil(now: number): number {
    let until = 0;
    for (const end of this.shown.values()) if (end > now && end > until) until = end;
    return until;
  }

  /** The render that read `pass` committed. */
  commit(pass: StreamFadePass): void {
    this.state = pass;
    if (this.pending === pass) this.pending = null;
    // Rewritten shorter: what follows has not been on screen.
    const last = this.onScreen[this.onScreen.length - 1];
    if (last !== undefined && pass.length < last) {
      this.onScreen = withinLength(this.onScreen, pass.length);
      this.stretches = this.stretches.filter((stretch) => stretch.to <= pass.length);
    }
  }

  /** How the revealed character at `offset` fades at `now` (undefined:
   *  unfaded): from the stretch it came on screen in, or, not on screen yet,
   *  as `appearing` brings it. */
  startAt(offset: number, now: number, appearing: StreamFadeAppearance): StreamFadeStart | undefined {
    const stretches = shownAt(this.onScreen, offset) ? this.stretches : appearing.stretches;
    for (const stretch of stretches) {
      if (offset >= stretch.from && offset < stretch.to) return stretch.at + stretch.ms > now ? stretch : undefined;
    }
    return undefined;
  }

  /** Revealed text [from, to) cut where how it fades changes. */
  runs(from: number, to: number, now: number, appearing: StreamFadeAppearance): FadeRun[] {
    const cuts = new Set([from, to]);
    const cut = (at: number) => {
      if (at > from && at < to) cuts.add(at);
    };
    for (const bound of this.onScreen) cut(bound);
    for (const stretch of [...this.stretches, ...appearing.stretches]) {
      cut(stretch.from);
      cut(stretch.to);
    }
    const points = [...cuts].sort((left, right) => left - right);
    const runs: FadeRun[] = [];
    for (let index = 0; index + 1 < points.length; index += 1) {
      const start = this.startAt(points[index], now, appearing);
      const last = runs[runs.length - 1];
      if (last && sameFade(last.start, start)) last.to = points[index + 1];
      else runs.push({ from: points[index], to: points[index + 1], start });
    }
    return runs;
  }
}

const timelines = new Map<string, StreamFadeTimeline>();

/** The fade timeline of the reply row `key`, found again on later renders and
 *  remounts. A streaming reply (with motion allowed) gets one. A settled reply
 *  keeps it until dropStreamFadeTimeline, once its fades ended. A reply that
 *  never streamed here has none. `primed`: the text a new timeline opens on
 *  when it showed at once; it shows unfaded. */
export function streamFadeTimeline(key: string, streaming: boolean, primed?: string): StreamFadeTimeline | null {
  const known = timelines.get(key);
  if (known) return known;
  if (!streaming || reducedMotion()) return null;
  const created = new StreamFadeTimeline(performance.now(), primed);
  timelines.set(key, created);
  while (timelines.size > TIMELINE_LIMIT) timelines.delete(timelines.keys().next().value as string);
  return created;
}

/** The reply `key` settled: its words show unwrapped from now on. */
export function dropStreamFadeTimeline(key: string): void {
  timelines.delete(key);
}

/** Drop the timelines of every reply whose key starts with one of
 *  `prefixes` (a deleted session's rows). */
export function dropStreamFadeTimelines(prefixes: readonly string[]): void {
  for (const key of timelines.keys()) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) timelines.delete(key);
  }
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function opaque(node: FadeNode): boolean {
  if (node.tagName === 'svg' || node.tagName === 'pre') return true;
  const className = node.properties?.className;
  if (Array.isArray(className)) return OPAQUE_CLASS.test(className.join(' '));
  return OPAQUE_CLASS.test(typeof className === 'string' ? className : '');
}

/** Elements that fade as one: an inline code chip arrives with its box (its
 *  background showed while its text was invisible), and a rule has no text. */
function unitElement(node: FadeNode): boolean {
  return node.type === 'element' && (node.tagName === 'code' || node.tagName === 'hr');
}

/** Boxes whose chrome fades with their first character: `marker` fades only
 *  the list marker (its text fades itself), `box` fades the whole element. */
const FADE_BOXES: Record<string, 'marker' | 'box'> = { li: 'marker', tr: 'box', blockquote: 'box' };
/** Tags rendered through the fading box component (MarkdownAstBody). */
export const STREAM_FADE_BOX_TAGS = ['li', 'tr', 'blockquote', 'hr', 'code'] as const;

function sameStart(left: StreamFadeStart | undefined, right: StreamFadeStart | undefined): boolean {
  return Boolean(left && right && left.at === right.at && left.ms === right.ms);
}

/** Both unfaded, or fading alike. */
function sameFade(left: StreamFadeStart | undefined, right: StreamFadeStart | undefined): boolean {
  return left === right || sameStart(left, right);
}

function fadeProperties(start: StreamFadeStart): Record<string, unknown> {
  return { dataFadeAt: start.at, dataFadeMs: start.ms };
}

interface StreamFadeResult {
  root: MarkdownAstRoot;
  /** Wrapper tags in `root`. */
  tags: string[];
  /** When the last fade `root` shows ends (0: none): its body renders again
   *  then, unwrapped. */
  until: number;
  /** What `root` brings on screen: its body commits it (appear). */
  appearance: StreamFadeAppearance;
}

/** `root`, parsed from the revealed text [base, end) (`end`: by default all
 *  revealed so far), with its still-fading text wrapped. */
export function applyStreamFade(
  root: MarkdownAstRoot,
  base: number,
  timeline: StreamFadeTimeline,
  now: number,
  end = timeline.revealedLength()
): StreamFadeResult {
  const appearance = timeline.appearing(base, end, now);
  if (!timeline.fadesBetween(base, end, appearance)) return { root, tags: [], until: 0, appearance };
  // Each node's offset in the revealed text, and where a text node's
  // characters sit.
  const offsets = new Map<FadeNode, number>();
  const stretches = new Map<FadeNode, FadeStretch[]>();
  const place = (node: FadeNode, cursor: number): number => {
    const own = node.offset === undefined ? cursor : base + node.offset;
    offsets.set(node, own);
    if (node.type === 'text') {
      const parts = stretchesOf(node, own, base);
      stretches.set(node, parts);
      const last = parts[parts.length - 1];
      return last ? last.at + last.to - last.from : own;
    }
    if (node.type === 'element' && opaque(node)) return own;
    let at = own;
    for (const child of node.children ?? []) at = place(child, at);
    return at;
  };
  place(root as FadeNode, base);
  const tags: string[] = [];
  let until = 0;
  const shown = (start: StreamFadeStart): StreamFadeStart => {
    until = Math.max(until, start.at + start.ms);
    return start;
  };

  /** Offset of the first character with ink inside `node`. */
  const firstInk = (node: FadeNode): number | undefined => {
    if (node.type === 'text') {
      const index = (node.value ?? '').search(/\S/);
      const stretch = stretches.get(node)?.find((part) => index >= part.from && index < part.to);
      return index === -1 || !stretch ? undefined : stretch.at + index - stretch.from;
    }
    if (node.type === 'element' && opaque(node)) return undefined;
    for (const child of node.children ?? []) {
      const found = firstInk(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const startOf = (offset: number | undefined) =>
    offset === undefined ? undefined : timeline.startAt(offset, now, appearance);

  /** A text node with its fading stretches wrapped (null: unchanged). Text
   *  fading with the enclosing box (`box`) is left to it. */
  const wrapText = (node: FadeNode, box: StreamFadeStart | undefined): FadeNode[] | null => {
    const value = node.value ?? '';
    const parts: FadeNode[] = [];
    let plain = '';
    let wrapped = false;
    const runs = (stretches.get(node) ?? []).flatMap((stretch) =>
      timeline.runs(stretch.at, stretch.at + stretch.to - stretch.from, now, appearance).map((run) => ({
        ...run,
        letters: value.slice(stretch.from + run.from - stretch.at, stretch.from + run.to - stretch.at),
      }))
    );
    for (const run of runs) {
      const { letters } = run;
      if (!run.start || sameStart(run.start, box) || !/\S/.test(letters)) {
        plain += letters;
        continue;
      }
      if (plain) parts.push({ type: 'text', value: plain });
      plain = '';
      const tag = `${STREAM_FADE_TAG}${run.from.toString(36)}`;
      tags.push(tag);
      parts.push({
        type: 'element',
        tagName: tag,
        properties: fadeProperties(shown(run.start)),
        children: [{ type: 'text', value: letters }],
      });
      wrapped = true;
    }
    if (!wrapped) return null;
    if (plain) parts.push({ type: 'text', value: plain });
    return parts;
  };

  const rebuild = (node: FadeNode, box: StreamFadeStart | undefined): FadeNode => {
    if (node.type === 'element' && opaque(node)) return node;
    if (unitElement(node)) {
      const start = startOf(node.tagName === 'hr' ? offsets.get(node) : firstInk(node));
      if (!start || sameStart(start, box)) return node;
      return {
        ...node,
        properties: { ...node.properties, ...fadeProperties(shown(start)), dataStreamFadeBox: 'box' },
      };
    }
    if (!node.children) return node;
    let properties = node.properties;
    let inner = box;
    const kind = node.type === 'element' ? FADE_BOXES[node.tagName ?? ''] : undefined;
    if (kind) {
      const start = startOf(firstInk(node));
      if (start && !sameStart(start, box)) {
        properties = { ...properties, ...fadeProperties(shown(start)), dataStreamFadeBox: kind };
        // A marker fade leaves the item's text to fade itself.
        if (kind === 'box') inner = start;
      }
    }
    let changed = properties !== node.properties;
    const children: FadeNode[] = [];
    for (const child of node.children) {
      const parts = child.type === 'text' ? wrapText(child, inner) : null;
      if (parts) {
        children.push(...parts);
        changed = true;
        continue;
      }
      const next = child.type === 'text' ? child : rebuild(child, inner);
      if (next !== child) changed = true;
      children.push(next);
    }
    return changed ? { ...node, properties, children } : node;
  };
  return { root: rebuild(root as FadeNode, undefined) as MarkdownAstRoot, tags, until, appearance };
}
