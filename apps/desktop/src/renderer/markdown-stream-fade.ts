/**
 * Word-by-word fade-in of a streamed reply.
 *
 * Every word of a reply that streamed on screen gets its own reveal: a start
 * time on the reply's timeline, each word STREAM_FADE_STAGGER_MS after the
 * previous one and never more than STREAM_FADE_MAX_LEAD_MS ahead of now, then
 * a STREAM_FADE_DURATION_MS opacity animation (`[data-stream-fade]` in
 * 22-markdown.css). The newest words therefore show a graded alpha ramp.
 *
 * - Identity: a word is a word-like segment plus the spaces and punctuation
 *   after it. Words are matched by position within their markdown chunk; a
 *   word that grew in place ("hel" → "hello") keeps its reveal. When a chunk
 *   freezes and the next block starts a new chunk, the words cut off its end
 *   hand their reveals to the new chunk's first words.
 * - No replays: the timeline lives per reply (keyed by row), so re-renders,
 *   re-parses and remounts find a word's reveal again. A word whose animation
 *   ended renders as plain text; one still animating keeps its start time, and
 *   a freshly created element for it resumes mid-fade (negative delay).
 * - Stable elements: each wrapper's tag carries its word's id, so the
 *   renderer's tag-and-count keys never hand one word's element to another.
 * - No layout: wrappers are unstyled inline elements; only opacity animates.
 *   Whitespace-only text is never wrapped; math, SVG and code are left whole.
 */
import type { MarkdownAstRoot } from './markdown-ast';

/** Matches the animation duration in 22-markdown.css. */
export const STREAM_FADE_DURATION_MS = 700;
export const STREAM_FADE_STAGGER_MS = 24;
export const STREAM_FADE_MAX_LEAD_MS = 800;
/** Wrapper tags are `${STREAM_FADE_TAG}${id}`. */
export const STREAM_FADE_TAG = 'mx-fade-';
const TIMELINE_LIMIT = 32;
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

export class StreamFadeTimeline {
  /** Start time of each word still animating; settled words are dropped. */
  private readonly starts = new Map<string, number>();
  /** Words of each chunk, in document order, from its latest render. */
  private readonly chunks = new Map<string, FadeWord[]>();
  /** Words cut off the end of a chunk by its latest render. */
  private orphans: FadeWord[] = [];
  private nextStart = 0;
  private nextId = 0;

  /** A new word revealed at `now`. */
  schedule(now: number): string {
    const start = Math.min(Math.max(this.nextStart, now), now + STREAM_FADE_MAX_LEAD_MS);
    this.nextStart = start + STREAM_FADE_STAGGER_MS;
    const id = (this.nextId++).toString(36);
    this.starts.set(id, start);
    return id;
  }

  /** When `id` starts fading; undefined once its animation has ended. */
  startOf(id: string, now: number): number | undefined {
    const start = this.starts.get(id);
    if (start === undefined || start + STREAM_FADE_DURATION_MS > now) return start;
    this.starts.delete(id);
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
      return { content, id: this.schedule(now) };
    });
    if (previous && words.length < previous.length) this.orphans = previous.slice(words.length);
    this.chunks.set(chunk, words);
    return words.map((word) => word.id);
  }
}

const timelines = new Map<string, StreamFadeTimeline>();

/** The fade timeline of the reply row `key`: created while it streams (and
 *  motion is allowed), found again on later renders and remounts; null for a
 *  reply that was never seen streaming. */
export function streamFadeTimeline(key: string, streaming: boolean): StreamFadeTimeline | null {
  const known = timelines.get(key);
  if (known || !streaming || reducedMotion()) return known ?? null;
  const created = new StreamFadeTimeline();
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
  // Code arrives as a unit with its box: word-wrapped, its background showed
  // while the text was still invisible.
  if (node.tagName === 'svg' || node.tagName === 'pre' || node.tagName === 'code') return true;
  const className = node.properties?.className;
  const names = Array.isArray(className) ? className.join(' ') : typeof className === 'string' ? className : '';
  return OPAQUE_CLASS.test(names);
}

/** Text nodes of `root` that take part, in document order. */
function textNodes(node: FadeNode, out: FadeNode[] = []): FadeNode[] {
  if (node.type === 'text') out.push(node);
  else if (!(node.type === 'element' && opaque(node))) for (const child of node.children ?? []) textNodes(child, out);
  return out;
}

export interface StreamFadeResult {
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
  const texts = textNodes(root);
  const split = texts.map((node) => streamFadeWords(node.value ?? ''));
  const ids = timeline.identify(chunk, split.flat(), now);
  const replaced = new Map<FadeNode, FadeNode[]>();
  const tags: string[] = [];
  let index = 0;
  texts.forEach((node, nodeIndex) => {
    const parts: FadeNode[] = [];
    let plain = '';
    let wrapped = false;
    for (const word of split[nodeIndex]) {
      const id = ids[index++];
      const start = id ? timeline.startOf(id, now) : undefined;
      if (start === undefined) {
        plain += word;
        continue;
      }
      if (plain) parts.push({ type: 'text', value: plain });
      plain = '';
      const tag = `${STREAM_FADE_TAG}${id}`;
      tags.push(tag);
      parts.push({
        type: 'element',
        tagName: tag,
        properties: { dataFadeAt: start },
        children: [{ type: 'text', value: word }],
      });
      wrapped = true;
    }
    if (!wrapped) return;
    if (plain) parts.push({ type: 'text', value: plain });
    replaced.set(node, parts);
  });
  if (replaced.size === 0) return { root, tags };
  const rebuild = (node: FadeNode): FadeNode => {
    if (!node.children || (node.type === 'element' && opaque(node))) return node;
    let changed = false;
    const children: FadeNode[] = [];
    for (const child of node.children) {
      const parts = replaced.get(child);
      if (parts) {
        children.push(...parts);
        changed = true;
        continue;
      }
      const next = rebuild(child);
      if (next !== child) changed = true;
      children.push(next);
    }
    return changed ? { ...node, children } : node;
  };
  return { root: rebuild(root) as MarkdownAstRoot, tags };
}
