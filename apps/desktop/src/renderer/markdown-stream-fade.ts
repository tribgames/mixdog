/**
 * Word-by-word fade-in of a streamed reply.
 *
 * Text is revealed in steps (use-transcript-text-reveal); new words fade in
 * over STREAM_FADE_DURATION_MS, linear, in chunks on one chain:
 * - A new word joins the open chunk while it has room (STREAM_FADE_PASS_
 *   CHUNK_CHARS within one render pass, STREAM_FADE_CHUNK_CHARS across
 *   passes); else it opens the next chunk, starting STREAM_FADE_MS_PER_CHAR
 *   per character after the chain's last start, at most STREAM_FADE_AHEAD_
 *   MAX_MS ahead of now, so a large step reads top to bottom.
 * - A chunk closes once it stood STREAM_FADE_CHUNK_OPEN_MS and a new word
 *   starts (StreamFadeTimeline.sync, once per render pass).
 * - Arrivals faster than STREAM_FADE_FAST_CHARS_PER_MS show unfaded.
 * - A word whose chunk ended fading by the latest close shows unwrapped, as
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
 * - Stable elements: each wrapper's tag carries its word's id, so the
 *   renderer's tag-and-count keys never hand one word's element to another.
 * - No layout: wrappers are unstyled inline elements; only opacity (and a
 *   marker's color) animates. Whitespace-only text is never wrapped; math,
 *   SVG and code blocks are left whole.
 */
import type { MarkdownAstRoot } from './markdown-ast';

/** How long a new word fades in (the default duration in 22-markdown.css). */
export const STREAM_FADE_DURATION_MS = 200;
/** Each fade chunk starts this long per character after the last one... */
export const STREAM_FADE_MS_PER_CHAR = 2.5;
/** ...at most this far ahead of now. */
export const STREAM_FADE_AHEAD_MAX_MS = 600;
/** A chunk takes words up to this many characters within one render pass... */
export const STREAM_FADE_PASS_CHUNK_CHARS = 16;
/** ...and up to this many across passes. */
export const STREAM_FADE_CHUNK_CHARS = 48;
/** A chunk stays open at least this long; it closes when a new word starts. */
export const STREAM_FADE_CHUNK_OPEN_MS = 100;
/** Arrivals faster than this (characters per ms, over windows of at least
 *  STREAM_FADE_SPEED_WINDOW_MS) show unfaded. */
export const STREAM_FADE_FAST_CHARS_PER_MS = 1.6;
export const STREAM_FADE_SPEED_WINDOW_MS = 100;
/** Arrivals stay unfaded this long after the last fast window. */
const FAST_HOLD_MS = 400;
/** A reply keeps fading this long after it stops streaming: the rest it then
 *  shows at once still fades in. */
export const STREAM_FADE_SETTLE_MS = 1000;
const NEW_WORD = /\s\S/;
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
}

/** Words fading together: one start (`at`) and duration. */
interface FadeChunk extends StreamFadeStart {
  /** Its start after it opened. */
  delay: number;
  /** When its last word's fade ends. */
  endsAt: number;
  chars: number;
  /** The render pass it opened in. */
  pass: number;
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
  /** How long a word revealed from now on fades (0: not at all). */
  durationMs = STREAM_FADE_DURATION_MS;

  private pass = 0;
  private open: FadeChunk | null = null;
  private openedAt = 0;
  /** Chunks whose fades ended by this time show unwrapped. */
  private horizon = 0;
  /** Start of the latest chunk on the chain. */
  private lastAssigned = 0;
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
   *  closes the open chunk once it stood its time and a new word starts. A
   *  rewrite shows every word unfaded: a `revision` above any seen (the
   *  reveal names its rewrites), else text that shrank or whose last
   *  SYNC_TAIL_CHARS moved. The rest of the prefix is never rescanned. */
  sync(text: string, now: number, revision = 0): void {
    this.pass += 1;
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
    } else if (text.length > this.lastLength) {
      const added = this.lastTail.slice(-1) + text.slice(this.lastLength);
      if (this.open && now - this.openedAt >= STREAM_FADE_CHUNK_OPEN_MS && NEW_WORD.test(added)) this.close(now);
    }
    this.lastLength = text.length;
    this.lastTail = text.slice(-SYNC_TAIL_CHARS);
  }

  private close(now: number): void {
    this.open = null;
    this.horizon = now;
  }

  /** A new word of `size` characters revealed at `now`: it joins the open
   *  chunk while that has room, else opens the next one on the chain. */
  schedule(now: number, size = 0): string {
    const id = (this.nextId++).toString(36);
    if (this.durationMs <= 0) return id;
    let chunk = this.open;
    const room = chunk?.pass === this.pass ? STREAM_FADE_PASS_CHUNK_CHARS : STREAM_FADE_CHUNK_CHARS;
    if (!chunk || chunk.chars + size > room) {
      const step = this.fast ? 0 : size * STREAM_FADE_MS_PER_CHAR;
      const start = Math.min(Math.max(now, this.lastAssigned) + step, now + STREAM_FADE_AHEAD_MAX_MS);
      const delay = Math.round(start - now);
      if (!chunk) this.openedAt = now;
      chunk = {
        at: now + delay,
        ms: this.durationMs,
        delay,
        endsAt: 0,
        chars: 0,
        pass: this.pass,
        done: this.fast && delay === 0,
      };
      this.open = chunk;
      this.lastAssigned = start;
    } else if (!this.fast) {
      this.lastAssigned = Math.min(this.lastAssigned + size * STREAM_FADE_MS_PER_CHAR, now + STREAM_FADE_AHEAD_MAX_MS);
    }
    chunk.endsAt = Math.max(chunk.endsAt, now + chunk.delay + chunk.ms);
    chunk.chars += size;
    this.starts.set(id, chunk);
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
      const known = previous ? previous[index] : aligned ? inherited?.[index] : undefined;
      // A word grows in place, and loses its trailing space where a block
      // ends: either way it is the same word.
      const was = known?.content.trimEnd() ?? '';
      const is = content.trimEnd();
      if (known?.id && (is.startsWith(was) || was.startsWith(is))) return { content, id: known.id };
      aligned = false;
      return { content, id: this.schedule(now, content.length) };
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
  const names = Array.isArray(className) ? className.join(' ') : typeof className === 'string' ? className : '';
  return OPAQUE_CLASS.test(names);
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
    const words =
      node.type === 'text' ? streamFadeWords(node.value ?? '') : [node.tagName === 'hr' ? '—' : textOf(node)];
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
  return { dataFadeAt: start.at, dataFadeMs: start.ms };
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

  /** A text unit with its animating words wrapped (null: unchanged).
   *  Words fading with the enclosing box (`box`) are left to it. */
  const wrapWords = (unit: FadeUnit, box: StreamFadeStart | undefined): FadeNode[] | null => {
    const parts: FadeNode[] = [];
    let plain = '';
    let wrapped = false;
    unit.words.forEach((word, offset) => {
      const index = unit.from + offset;
      const start = starts[index];
      if (!start || sameStart(start, box)) {
        plain += word;
        return;
      }
      if (plain) parts.push({ type: 'text', value: plain });
      plain = '';
      const tag = `${STREAM_FADE_TAG}${ids[index]}`;
      tags.push(tag);
      parts.push({
        type: 'element',
        tagName: tag,
        properties: fadeProperties(start),
        children: [{ type: 'text', value: word }],
      });
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
