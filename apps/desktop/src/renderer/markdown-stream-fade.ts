/**
 * Word-by-word fade-in of a streamed reply.
 *
 * Text is revealed in steps (use-transcript-text-reveal); each step's new words
 * fade in over STREAM_FADE_DURATION_MS. Within one step the words start
 * fading top to bottom: each one STREAM_FADE_STAGGER_MS_PER_CHAR per
 * character of the arrival before it, at most STREAM_FADE_STAGGER_MAX_MS
 * after the first, so a large chunk reads from its first line. A step shown
 * with a duration of 0 (a row this pane did not watch arrive) is not wrapped
 * at all.
 * A word keeps its wrapper for as long as the reply's timeline lives, also
 * after its fade and after the reply settles: a fade ending never changes
 * the DOM. Opacity animations live in 22-markdown.css (`[data-stream-fade]`,
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
export const STREAM_FADE_DURATION_MS = 100;
/** A word of an arrival starts fading this long per character of the arrival
 *  before it... */
export const STREAM_FADE_STAGGER_MS_PER_CHAR = 2.5;
/** ...at most this long after the arrival's first word. */
export const STREAM_FADE_STAGGER_MAX_MS = 150;
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

/** One arrival of text: a new object for every arrival. Its new words start
 *  fading top to bottom from the first render that shows them. */
export interface FadeArrival {
  readonly at: number;
}

export class StreamFadeTimeline {
  /** Reveal of each faded word; kept after its fade, so its wrapper stays. */
  private readonly starts = new Map<string, StreamFadeStart>();
  /** Words of each chunk, in document order, from its latest render. */
  private readonly chunks = new Map<string, FadeWord[]>();
  /** Words cut off the end of a chunk by its latest render. */
  private orphans: FadeWord[] = [];
  private nextId = 0;
  /** How long a word revealed from now on fades (0: not at all). */
  durationMs = STREAM_FADE_DURATION_MS;

  /** The arrival whose words are being scheduled, and how many of its
   *  characters were placed. */
  private arrival: FadeArrival | null = null;
  private cursor = 0;

  /** The arrival the next new words belong to. */
  setArrival(arrival: FadeArrival | null): void {
    if (arrival === this.arrival) return;
    this.arrival = arrival;
    this.cursor = 0;
  }

  /** A new word of `size` characters revealed at `now`: it starts fading
   *  after the characters of its arrival before it (staggered, capped). */
  schedule(now: number, size = 0): string {
    const id = (this.nextId++).toString(36);
    if (this.durationMs <= 0) return id;
    const delay = Math.min(STREAM_FADE_STAGGER_MAX_MS, this.cursor * STREAM_FADE_STAGGER_MS_PER_CHAR);
    this.cursor += size;
    this.starts.set(id, { at: now + delay, ms: this.durationMs });
    return id;
  }

  /** How `id` fades; undefined for a word shown unfaded. */
  startOf(id: string): StreamFadeStart | undefined {
    return this.starts.get(id);
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
 *  remounts. A streaming reply (with motion allowed) gets one; its new words
 *  fade over `durationMs` as part of `arrival`. A settled reply keeps the
 *  timeline it streamed with, so its words keep their wrappers and fades
 *  already running finish; anything it shows new is not faded. A reply that
 *  never streamed here has none. */
export function streamFadeTimeline(
  key: string,
  streaming: boolean,
  durationMs = STREAM_FADE_DURATION_MS,
  arrival: FadeArrival | null = null
): StreamFadeTimeline | null {
  const known = timelines.get(key);
  if (known) {
    known.durationMs = streaming ? durationMs : 0;
    known.setArrival(arrival);
    return known;
  }
  if (!streaming || reducedMotion()) return null;
  const created = new StreamFadeTimeline();
  created.durationMs = durationMs;
  created.setArrival(arrival);
  timelines.set(key, created);
  while (timelines.size > TIMELINE_LIMIT) timelines.delete(timelines.keys().next().value as string);
  return created;
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
