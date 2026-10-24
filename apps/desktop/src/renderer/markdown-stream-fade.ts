/**
 * Phrase fade-in of a streamed reply.
 *
 * Text is revealed in steps (use-transcript-text-reveal); new words fade in
 * over STREAM_FADE_DURATION_MS, linear, a phrase at a time:
 * - Every word revealed while a phrase is open joins it: one start, no delay
 *   and no stagger. A phrase closes once it stood STREAM_FADE_CHUNK_OPEN_MS
 *   and the text grew (StreamFadeTimeline.sync, once per render pass); the
 *   next new word opens the next one.
 * - Neighbouring words of one phrase share one wrapper element.
 * - Arrivals faster than STREAM_FADE_FAST_CHARS_PER_MS show unfaded.
 * - Settle: the render showing the reply stopped streaming fades the rest
 *   shown at once as one phrase of STREAM_FADE_SETTLE_FADE_MS (sync's
 *   `settled`); once that render commits (StreamFadeTimeline.settle), every
 *   running fade ends within that long, keeping its progress
 *   (settleStreamFades for elements already on screen, settledStreamFade for
 *   elements created later).
 * - A word whose phrase ended fading by the latest close shows unwrapped, as
 *   does every word once the reply settled for STREAM_FADE_SETTLE_MS (until
 *   then what it shows still fades) or was rewritten.
 * Opacity animations live in 22-markdown.css (`[data-stream-fade]`,
 * `[data-stream-fade-box]`).
 *
 * - Structure fades with its words: a list item's marker, a table row, a
 *   blockquote and a rule start fading with the first word inside them, and
 *   an inline code chip fades as one word, so no chrome paints at full ink
 *   while its text is still transparent. A word fading together with the box
 *   around it is left to the box's fade (never faded twice).
 *
 * - Identity: a word is a word-like segment plus the spaces and punctuation
 *   after it. Words are matched by position within their markdown chunk; a
 *   word that grew in place ("hel" → "hello") keeps its reveal. When a chunk
 *   freezes and the next block starts a new chunk, the words cut off its end
 *   hand their reveals to the new chunk's first words.
 * - No replays: the timeline lives per reply (keyed by row), so re-renders,
 *   re-parses and remounts find a word's reveal again. A word keeps its start
 *   time, and a freshly created element for it resumes mid-fade, or shows
 *   inked once its fade is over (negative delay).
 * - Stable elements: each wrapper's tag carries its first word's id, so the
 *   renderer's tag-and-count keys never hand one word's element to another.
 * - No layout: wrappers are unstyled inline elements; only opacity (and a
 *   marker's color) animates. Whitespace-only text is never wrapped; math,
 *   SVG and code blocks are left whole.
 */
import type { MarkdownAstRoot } from './markdown-ast';

/** How long a phrase fades in (the default duration in 22-markdown.css). */
export const STREAM_FADE_DURATION_MS = 400;
/** A phrase stays open at least this long; it closes when the text grows. */
export const STREAM_FADE_CHUNK_OPEN_MS = 100;
/** At settle every running fade ends within this long, and the rest shown at
 *  once fades over it. */
export const STREAM_FADE_SETTLE_FADE_MS = 120;
/** Arrivals faster than this (characters per ms, over windows of at least
 *  STREAM_FADE_SPEED_WINDOW_MS) show unfaded. */
export const STREAM_FADE_FAST_CHARS_PER_MS = 1.6;
export const STREAM_FADE_SPEED_WINDOW_MS = 100;
/** Arrivals stay unfaded this long after the last fast window. */
const FAST_HOLD_MS = 400;
/** A reply keeps its wrappers this long after it stops streaming: the rest it
 *  then shows at once still fades in, and every fade has ended. */
export const STREAM_FADE_SETTLE_MS = 700;
/** CSS animations of the fade (22-markdown.css). */
const FADE_ANIMATION = /^markdown-stream-fade/;
/** sync compares this much of the end of the text it last showed. */
const SYNC_TAIL_CHARS = 16;
/** Wrapper tags are `${STREAM_FADE_TAG}${id}`. */
const STREAM_FADE_TAG = 'mx-fade-';
const TIMELINE_LIMIT = 64;
const SEGMENT_CACHE_LIMIT = 512;
/** Rendered as-is: wrapping inside typeset math or SVG would break it. */
const OPAQUE_CLASS = /\bkatex\b/;

interface FadeNode {
  type: 'root' | 'element' | 'text';
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: FadeNode[];
}

interface FadeWord {
  content: string;
  id: string;
}

interface StreamFadeStart {
  at: number;
  ms: number;
  /** When its reply settled while it still had more than
   *  STREAM_FADE_SETTLE_FADE_MS to run (settledStreamFade). */
  settle?: number;
}

/** A phrase: words fading together, from one start (`at`) over one duration. */
interface FadeChunk extends StreamFadeStart {
  /** When its fade ends. */
  endsAt: number;
  /** Shown unfaded from now on. */
  done: boolean;
}

export class StreamFadeTimeline {
  /** The chunk of each word revealed here. */
  private readonly starts = new Map<string, FadeChunk>();
  /** Words of each chunk, in document order, from its latest render. */
  private readonly chunks = new Map<string, FadeWord[]>();
  /** Words cut off the end of a chunk by its latest render. */
  private orphans: FadeWord[] = [];
  private nextId = 0;
  /** How long a phrase revealed from now on fades while streaming (0: not
   *  at all). */
  durationMs = STREAM_FADE_DURATION_MS;

  private open: FadeChunk | null = null;
  private openedAt = 0;
  /** Phrases whose fades ended by this time show unwrapped. */
  private horizon = 0;
  /** The latest render pass showed the reply settled. */
  private settling = false;
  private fast = false;
  private speed: { since: number; length: number; fastAt: number };
  /** Length and end of the text the last pass showed. */
  private lastLength = 0;
  private lastTail = '';
  /** The latest rewrite revision seen. */
  private revision = 0;

  constructor(now = performance.now()) {
    this.speed = { since: now, length: 0, fastAt: Number.NEGATIVE_INFINITY };
  }

  /** A render pass shows `text` at `now`: it measures the arrival rate and
   *  closes the open phrase once it stood its time and the text grew. A
   *  rewrite shows every word unfaded: a `revision` above any seen (the
   *  reveal names its rewrites), else text that shrank or whose last
   *  SYNC_TAIL_CHARS moved. The rest of the prefix is never rescanned.
   *  `settled`: the pass shows the reply stopped streaming, so a phrase it
   *  opens fades over STREAM_FADE_SETTLE_FADE_MS. Every pass says so anew (a
   *  pass React discards leaves no lasting state), and a change of mode
   *  closes the open phrase. */
  sync(text: string, now: number, revision = 0, settled = false): void {
    if (settled !== this.settling && this.open) this.close(now);
    this.settling = settled;
    const { since, length, fastAt } = this.speed;
    if (now - since >= STREAM_FADE_SPEED_WINDOW_MS) {
      const limit = STREAM_FADE_FAST_CHARS_PER_MS * (this.fast ? 0.75 : 1);
      const fast = (text.length - length) / (now - since) > limit;
      // Two fast windows in a row turn fading off; it stays off while
      // windows are fast, and FAST_HOLD_MS after the last one.
      this.fast = fast ? this.fast || fastAt === since : this.fast && now - fastAt < FAST_HOLD_MS;
      this.speed = { since: now, length: text.length, fastAt: fast ? now : fastAt };
    }
    const rewritten =
      revision > this.revision ||
      text.length < this.lastLength ||
      !text.startsWith(this.lastTail, this.lastLength - this.lastTail.length);
    if (revision > this.revision) this.revision = revision;
    if (rewritten) {
      for (const chunk of this.starts.values()) chunk.done = true;
      this.close(now);
    } else if (text.length > this.lastLength && this.open && now - this.openedAt >= STREAM_FADE_CHUNK_OPEN_MS) {
      this.close(now);
    }
    this.lastLength = text.length;
    this.lastTail = text.slice(-SYNC_TAIL_CHARS);
  }

  private close(now: number): void {
    this.open = null;
    this.horizon = now;
  }

  /** The settled reply committed at `now` (call from the commit, not from
   *  render): every phrase with more than STREAM_FADE_SETTLE_FADE_MS left
   *  ends that long from now, for elements created from now on; the ones on
   *  screen are sped up by settleStreamFades. */
  settle(now: number): void {
    for (const chunk of this.starts.values()) {
      if (chunk.done || chunk.endsAt - now <= STREAM_FADE_SETTLE_FADE_MS) continue;
      chunk.settle = now;
      chunk.endsAt = now + STREAM_FADE_SETTLE_FADE_MS;
    }
    this.close(now);
  }

  /** A new word revealed at `now`: it joins the open phrase, else opens the
   *  next one, starting now. */
  schedule(now: number): string {
    const id = (this.nextId++).toString(36);
    if (this.durationMs <= 0) return id;
    if (!this.open) {
      const ms = this.settling ? STREAM_FADE_SETTLE_FADE_MS : this.durationMs;
      this.open = { at: now, ms, endsAt: now + ms, done: this.fast };
      this.openedAt = now;
    }
    this.starts.set(id, this.open);
    return id;
  }

  /** How `id` fades; undefined for a word shown unfaded or settled. */
  startOf(id: string): StreamFadeStart | undefined {
    const chunk = this.starts.get(id);
    if (!chunk || chunk.done) return undefined;
    if (this.horizon < chunk.endsAt) return chunk;
    chunk.done = true;
    return undefined;
  }

  /** Match `contents` (one chunk's words, in order) to known words. */
  identify(chunk: string, contents: readonly string[], now: number): string[] {
    const previous = this.chunks.get(chunk);
    const inherited = previous ? null : this.orphans;
    if (inherited) this.orphans = [];
    let aligned = true;
    const words = contents.map((content, index): FadeWord => {
      // Blank text (between list items, table cells) shows nothing to fade.
      if (!/\S/.test(content)) return { content, id: '' };
      const known = (previous ?? (aligned ? inherited : null))?.[index];
      // A word grows in place, and loses its trailing space where a block
      // ends: either way it is the same word.
      const was = known?.content.trimEnd() ?? '';
      const is = content.trimEnd();
      if (known?.id && (is.startsWith(was) || was.startsWith(is))) return { content, id: known.id };
      aligned = false;
      return { content, id: this.schedule(now) };
    });
    if (previous && words.length < previous.length) this.orphans = previous.slice(words.length);
    this.chunks.set(chunk, words);
    return words.map((word) => word.id);
  }
}

const timelines = new Map<string, StreamFadeTimeline>();

/** The fade timeline of the reply row `key`, found again on later renders and
 *  remounts. A streaming reply (with motion allowed) gets one. A settled reply
 *  keeps it until dropStreamFadeTimeline (STREAM_FADE_SETTLE_MS later): what
 *  it shows meanwhile still fades. A reply that never streamed here has none. */
export function streamFadeTimeline(key: string, streaming: boolean): StreamFadeTimeline | null {
  const known = timelines.get(key);
  if (known) return known;
  if (!streaming || reducedMotion()) return null;
  const created = new StreamFadeTimeline();
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

/** How an element created now fades for a phrase that started at `at` and
 *  runs `ms`: unchanged, or (`settle` set) from the progress it had when its
 *  reply settled, ending STREAM_FADE_SETTLE_FADE_MS after that. */
export function settledStreamFade(at: number, ms: number, settle?: number): { at: number; ms: number } {
  if (settle === undefined) return { at, ms };
  const progress = Math.min(1, Math.max(0, (settle - at) / ms));
  const duration = STREAM_FADE_SETTLE_FADE_MS / (1 - progress);
  return { at: settle - progress * duration, ms: duration };
}

/** The reply under `root` settled: each of its running fade animations keeps
 *  its progress and ends within STREAM_FADE_SETTLE_FADE_MS. */
export function settleStreamFades(root: Pick<Element, 'getAnimations'>): void {
  for (const animation of root.getAnimations({ subtree: true })) {
    if (!FADE_ANIMATION.test((animation as CSSAnimation).animationName ?? '')) continue;
    const end = Number(animation.effect?.getComputedTiming().endTime ?? 0);
    const rate = animation.playbackRate;
    const left = (end - Number(animation.currentTime ?? end)) / rate;
    if (left > STREAM_FADE_SETTLE_FADE_MS) animation.updatePlaybackRate((rate * left) / STREAM_FADE_SETTLE_FADE_MS);
  }
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

let segmenter: Intl.Segmenter | null = null;
const segmentCache = new Map<string, string[]>();

/** `value` cut into words, each with the spaces and punctuation after it
 *  (text before the first word joins that word). */
export function streamFadeWords(value: string): string[] {
  const cached = segmentCache.get(value);
  if (cached) return cached;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
  const words: string[] = [];
  let lead = '';
  for (const { segment, isWordLike } of segmenter.segment(value)) {
    if (isWordLike) {
      words.push(lead + segment);
      lead = '';
    } else if (words.length > 0) words[words.length - 1] += segment;
    else lead += segment;
  }
  if (lead) words.push(lead);
  segmentCache.set(value, words);
  if (segmentCache.size > SEGMENT_CACHE_LIMIT) segmentCache.delete(segmentCache.keys().next().value as string);
  return words;
}

function opaque(node: FadeNode): boolean {
  if (node.tagName === 'svg' || node.tagName === 'pre') return true;
  const className = node.properties?.className;
  if (Array.isArray(className)) return OPAQUE_CLASS.test(className.join(' '));
  return OPAQUE_CLASS.test(typeof className === 'string' ? className : '');
}

/** Elements that fade as one word: an inline code chip arrives with its box
 *  (word-wrapped, its background showed while the text was invisible), and a
 *  rule has no words at all. */
function unitElement(node: FadeNode): boolean {
  return node.type === 'element' && (node.tagName === 'code' || node.tagName === 'hr');
}

/** Boxes whose chrome fades with their first word: `marker` fades only the
 *  list marker (its words fade themselves), `box` fades the whole element. */
const FADE_BOXES: Record<string, 'marker' | 'box'> = { li: 'marker', tr: 'box', blockquote: 'box' };
/** Tags rendered through the fading box component (MarkdownAstBody). */
export const STREAM_FADE_BOX_TAGS = ['li', 'tr', 'blockquote', 'hr', 'code'] as const;

function textOf(node: FadeNode): string {
  return node.type === 'text' ? (node.value ?? '') : (node.children ?? []).map(textOf).join('');
}

/** A part of the document that takes part: a text node cut into words, or a
 *  unit element counted as one word. `from` indexes its first word in the
 *  chunk's word list. */
interface FadeUnit {
  words: string[];
  from: number;
}

/** Units of `node`, in document order. */
function collectUnits(node: FadeNode, units: Map<FadeNode, FadeUnit>, contents: string[]): void {
  if (node.type === 'text' || unitElement(node)) {
    let words: string[];
    if (node.type === 'text') words = streamFadeWords(node.value ?? '');
    else words = [node.tagName === 'hr' ? '—' : textOf(node)];
    units.set(node, { words, from: contents.length });
    contents.push(...words);
    return;
  }
  if (node.type === 'element' && opaque(node)) return;
  for (const child of node.children ?? []) collectUnits(child, units, contents);
}

function sameStart(left: StreamFadeStart | undefined, right: StreamFadeStart | undefined): boolean {
  return Boolean(left && right && left.at === right.at && left.ms === right.ms);
}

function fadeProperties(start: StreamFadeStart): Record<string, unknown> {
  return { dataFadeAt: start.at, dataFadeMs: start.ms, dataFadeSettle: start.settle };
}

interface StreamFadeResult {
  root: MarkdownAstRoot;
  /** Wrapper tags in `root`. */
  tags: string[];
}

/** `root` of chunk `chunk` with its still-animating words wrapped. */
export function applyStreamFade(
  root: MarkdownAstRoot,
  chunk: string,
  timeline: StreamFadeTimeline,
  now: number
): StreamFadeResult {
  const units = new Map<FadeNode, FadeUnit>();
  const contents: string[] = [];
  collectUnits(root as FadeNode, units, contents);
  const ids = timeline.identify(chunk, contents, now);
  const starts = ids.map((id) => (id ? timeline.startOf(id) : undefined));
  if (!starts.some(Boolean)) return { root, tags: [] };
  const tags: string[] = [];

  /** The reveal of the first word inside `node` (undefined when it showed
   *  unfaded, or there is none). */
  const firstStart = (node: FadeNode): { found: boolean; start?: StreamFadeStart } => {
    const unit = units.get(node);
    if (unit) {
      for (let index = unit.from; index < unit.from + unit.words.length; index += 1) {
        if (ids[index]) return { found: true, start: starts[index] };
      }
      return { found: false };
    }
    if (node.type === 'element' && opaque(node)) return { found: false };
    for (const child of node.children ?? []) {
      const first = firstStart(child);
      if (first.found) return first;
    }
    return { found: false };
  };

  /** A text unit with its animating words wrapped, neighbours of one phrase
   *  in one element named by the first (null: unchanged). Words fading with
   *  the enclosing box (`box`) are left to it. */
  const wrapWords = (unit: FadeUnit, box: StreamFadeStart | undefined): FadeNode[] | null => {
    const parts: FadeNode[] = [];
    let plain = '';
    let wrapped = false;
    let run: { start: StreamFadeStart; text: FadeNode } | null = null;
    unit.words.forEach((word, offset) => {
      const index = unit.from + offset;
      const start = starts[index];
      if (!start || sameStart(start, box)) {
        plain += word;
        run = null;
        return;
      }
      if (run?.start === start) {
        run.text.value += word;
        return;
      }
      if (plain) parts.push({ type: 'text', value: plain });
      plain = '';
      const tag = `${STREAM_FADE_TAG}${ids[index]}`;
      tags.push(tag);
      run = { start, text: { type: 'text', value: word } };
      parts.push({ type: 'element', tagName: tag, properties: fadeProperties(start), children: [run.text] });
      wrapped = true;
    });
    if (!wrapped) return null;
    if (plain) parts.push({ type: 'text', value: plain });
    return parts;
  };

  const rebuild = (node: FadeNode, box: StreamFadeStart | undefined): FadeNode => {
    if (node.type === 'element' && opaque(node)) return node;
    const unit = units.get(node);
    if (unit && unitElement(node)) {
      const start = starts[unit.from];
      if (!start || sameStart(start, box)) return node;
      return {
        ...node,
        properties: { ...node.properties, ...fadeProperties(start), dataStreamFadeBox: 'box' },
      };
    }
    if (!node.children) return node;
    let properties = node.properties;
    let inner = box;
    const kind = node.type === 'element' ? FADE_BOXES[node.tagName ?? ''] : undefined;
    if (kind) {
      const { start } = firstStart(node);
      if (start && !sameStart(start, box)) {
        properties = { ...properties, ...fadeProperties(start), dataStreamFadeBox: kind };
        // A marker fade leaves the item's words to fade themselves.
        if (kind === 'box') inner = start;
      }
    }
    let changed = properties !== node.properties;
    const children: FadeNode[] = [];
    for (const child of node.children) {
      const childUnit = child.type === 'text' ? units.get(child) : undefined;
      const parts = childUnit ? wrapWords(childUnit, inner) : null;
      if (parts) {
        children.push(...parts);
        changed = true;
        continue;
      }
      const next = childUnit ? child : rebuild(child, inner);
      if (next !== child) changed = true;
      children.push(next);
    }
    return changed ? { ...node, properties, children } : node;
  };
  return { root: rebuild(root as FadeNode, undefined) as MarkdownAstRoot, tags };
}
