import { getSchema, type AnyExtension, type JSONContent } from '@tiptap/core';
import type { Mark, Node as ProseMirrorNode, Schema } from '@tiptap/pm/model';
import { MarkdownManager } from '@tiptap/markdown';
import { Marked, type Token, type Tokens } from 'marked';
import { t } from '../i18n';
import { createRichMarkdownExtensions, INLINE_MATH_SOURCE, richMarkdownMarked } from './rich-markdown-extensions';

/** Plain CommonMark+GFM renderer used only as an independent judge: two
 *  Markdown texts that render the same HTML here mean the same document. */
const reference = new Marked({ gfm: true, async: false });

function referenceHtml(markdown: string): string {
  return reference.parse(markdown, { async: false }) as string;
}

/** Whitespace-sensitive spans of the rendered HTML: code blocks, `$$` math,
 *  inline code and inline `$` math (matched by the editor's own rule). Their
 *  content is compared exactly (block math edges excepted: the editor writes
 *  `$$x$$` as `$$\nx\n$$`). */
const EXACT_SPAN = new RegExp(
  String.raw`<pre\b[\s\S]*?<\/pre>|\$\$[\s\S]*?\$\$|<code>[\s\S]*?<\/code>|` + INLINE_MATH_SOURCE,
  'g'
);
// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL delimits the placeholders written by semanticMarkdown
const EXACT_PLACEHOLDER = /<pre>\u0000(\d+)\u0000<\/pre>|\u0000(\d+)\u0000/g;

/** Rendered HTML with presentation-only differences removed: whitespace
 *  between and inside block tags, and a list item's paragraph wrapper (a
 *  tight list and a loose list hold the same content). Code and math keep
 *  their whitespace. */
export function semanticMarkdown(markdown: string): string {
  const exact: string[] = [];
  return referenceHtml(markdown.replace(/\r\n?/g, '\n'))
    .replace(EXACT_SPAN, (span) => {
      exact.push(span.startsWith('$$') ? `$$${span.slice(2, -2).trim()}$$` : span);
      const id = `\u0000${exact.length - 1}\u0000`;
      return span.startsWith('<pre') ? `<pre>${id}</pre>` : id;
    })
    .replace(/<li>\s*<p>/g, '<li>')
    .replace(/<\/p>\s*<\/li>/g, '</li>')
    .replace(/<\/p>\s*<(ul|ol)>/g, '<$1>')
    .replace(/\s+/g, ' ')
    .replace(
      /\s*(<\/?(?:p|li|ul|ol|blockquote|table|thead|tbody|tr|th|td|h[1-6]|pre|hr|details|summary)\b[^>]*>)\s*/g,
      '$1'
    )
    .trim()
    .replace(EXACT_PLACEHOLDER, (_match, pre?: string, math?: string) => exact[Number(pre ?? math)]);
}

export interface RichMarkdownCodec {
  schema: Schema;
  /** Markdown body → validated editor document JSON. Throws on content the
   *  schema rejects. */
  parse(markdown: string): JSONContent;
  /** Editor document JSON → canonical Markdown (LF line endings). */
  serialize(doc: JSONContent): string;
}

/** Bare URLs as GFM autolinks them; their characters are written as typed,
 *  so the autolink reads back as exactly the typed text. */
const BARE_URL = /(?:(?:https?|ftp):\/\/|www\.)[^\s<]*/gi;
const INLINE_MATH_AT = new RegExp(INLINE_MATH_SOURCE, 'y');

/** Text escaping on top of the manager's own: bare URLs are left as typed,
 *  and `$…$` that would read back as math gets its opening `$` escaped.
 *  A `$` inside a bare URL is never escaped (a backslash there would become
 *  part of the URL): the URL is read first, so math cannot start in it. */
function escapeRichMarkdownText(text: string, base: (text: string) => string): string {
  let out = '';
  let last = 0;
  const urls: Array<[number, number]> = [];
  for (const match of text.matchAll(BARE_URL)) {
    out += base(text.slice(last, match.index));
    urls.push([out.length, out.length + match[0].length]);
    out += match[0];
    last = match.index + match[0].length;
  }
  out += base(text.slice(last));
  let escaped = '';
  let copied = 0;
  let url = 0;
  for (let index = out.indexOf('$'); index !== -1; index = out.indexOf('$', index + 1)) {
    while (url < urls.length && urls[url][1] <= index) url++;
    if (url < urls.length && urls[url][0] <= index) {
      index = urls[url][1] - 1;
      continue;
    }
    INLINE_MATH_AT.lastIndex = index;
    const math = INLINE_MATH_AT.exec(out);
    if (!math) continue;
    escaped += `${out.slice(copied, index)}\\`;
    copied = index;
    index += math[0].length - 1;
  }
  return escaped + out.slice(copied);
}

const escapingManagers = new WeakSet<MarkdownManager>();

/** Installs the rich editor's text escaping on a manager (once). */
function installTextEscaping(manager: MarkdownManager): void {
  if (escapingManagers.has(manager)) return;
  escapingManagers.add(manager);
  const target = manager as unknown as { escapeMarkdownSyntax(text: string): string };
  const base = target.escapeMarkdownSyntax.bind(manager);
  target.escapeMarkdownSyntax = (text) => escapeRichMarkdownText(text, base);
}

/** A codec over an existing schema and Markdown manager (the live editor's own). */
export function richMarkdownCodecFor(schema: Schema, manager: MarkdownManager): RichMarkdownCodec {
  installTextEscaping(manager);
  return {
    schema,
    parse(markdown) {
      const json = manager.parse(markdown.replace(/\r\n?/g, '\n'));
      const node = schema.nodeFromJSON(json.content?.length ? json : { type: 'doc', content: [{ type: 'paragraph' }] });
      node.check();
      return node.toJSON();
    },
    serialize: (doc) => manager.serialize(doc),
  };
}

/** A headless codec over the editor's exact extension set. */
export function createRichMarkdownCodec(
  extensions: AnyExtension[] = createRichMarkdownExtensions()
): RichMarkdownCodec {
  const manager = new MarkdownManager({
    marked: richMarkdownMarked() as never,
    markedOptions: { gfm: true },
    extensions,
  });
  return richMarkdownCodecFor(getSchema(extensions), manager);
}

export type RichMarkdownRoundTrip = { ok: true; doc: JSONContent; canonical: string } | { ok: false; reason: string };

/** Proves a body survives the editor: parsing it and writing it back must
 *  mean the same document, and the written form must be stable. */
export function checkRichMarkdownRoundTrip(codec: RichMarkdownCodec, body: string): RichMarkdownRoundTrip {
  let doc: JSONContent;
  let canonical: string;
  try {
    doc = codec.parse(body);
    canonical = codec.serialize(doc);
  } catch {
    return { ok: false, reason: t('This document has structure the rich editor cannot represent.') };
  }
  if (semanticMarkdown(body) !== semanticMarkdown(canonical)) {
    return { ok: false, reason: t('Some Markdown in this file would change if edited in the rich editor.') };
  }
  let again: string;
  try {
    again = codec.serialize(codec.parse(canonical));
  } catch {
    again = '';
  }
  if (semanticMarkdown(again) !== semanticMarkdown(canonical)) {
    return { ok: false, reason: t('Some Markdown in this file would change if edited in the rich editor.') };
  }
  return { ok: true, doc, canonical };
}

const decodeHref = (href: string) =>
  href.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_entity, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name] ?? name
  );

/** A link GFM makes of bare text by itself (a URL, `www.` host or email
 *  address): it means the same as that text without the link. */
function isAutolink(mark: Mark, text: string | undefined): boolean {
  if (mark.type.name !== 'link' || !text) return false;
  const href = decodeHref(String(mark.attrs.href ?? ''));
  return href === text || href === `http://${text}` || href === `mailto:${text}`;
}

/** A textblock's inline content as Markdown carries it: whitespace outside
 *  code collapses to one unmarked space, and is dropped at the block's edges
 *  and next to line breaks, which themselves vanish at the edges. */
function inlineMeaning(block: ProseMirrorNode): unknown[] {
  const out: unknown[] = [];
  let space = false;
  const push = (marks: string, text: string) => {
    const last = out.at(-1);
    if (Array.isArray(last) && last[0] === 'text' && last[1] === marks) last[2] += text;
    else out.push(['text', marks, text]);
  };
  block.forEach((child) => {
    const marks = JSON.stringify(
      child.marks.filter((mark) => !isAutolink(mark, child.text)).map((mark) => [mark.type.name, mark.attrs])
    );
    if (!child.isText) {
      if (child.type.name === 'hardBreak') {
        space = false;
        if (out.length) out.push('\n');
        return;
      }
      if (space && out.length && out.at(-1) !== '\n') push('', ' ');
      space = false;
      out.push([child.type.name, child.attrs, marks]);
      return;
    }
    const code = child.marks.some((mark) => mark.type.spec.code);
    for (const char of child.text ?? '') {
      if (!code && /[ \t\r\n]/.test(char)) {
        space = true;
        continue;
      }
      if (space && out.length && out.at(-1) !== '\n') push('', ' ');
      space = false;
      push(marks, char);
    }
  });
  while (out.at(-1) === '\n') out.pop();
  return out;
}

/** A node's meaning for comparison; empty paragraphs (which Markdown cannot
 *  hold) are left out. */
function blockMeaning(node: ProseMirrorNode): unknown[] {
  if (node.type.spec.code || node.isLeaf) return [node.type.name, node.attrs, node.textContent];
  if (node.isTextblock) return [node.type.name, node.attrs, inlineMeaning(node)];
  const children: unknown[] = [];
  node.forEach((child) => {
    const meaning = blockMeaning(child);
    if (child.type.name !== 'paragraph' || (meaning[2] as unknown[]).length) children.push(meaning);
  });
  return [node.type.name, node.attrs, children];
}

/** What a run of top-level blocks means, as comparable text. */
export function richMarkdownBlocksMeaning(blocks: readonly ProseMirrorNode[]): string {
  const meanings: unknown[] = [];
  for (const block of blocks) {
    const meaning = blockMeaning(block);
    if (block.type.name !== 'paragraph' || (meaning[2] as unknown[]).length) meanings.push(meaning);
  }
  return JSON.stringify(meanings);
}

/** Whether two editor documents mean the same Markdown: equal up to
 *  whitespace Markdown does not keep, empty paragraphs, and links GFM makes
 *  of bare URLs. */
export function sameRichMarkdownDocument(
  schema: Schema,
  a: JSONContent | ProseMirrorNode,
  b: JSONContent | ProseMirrorNode
): boolean {
  const children = (doc: JSONContent | ProseMirrorNode) => {
    const node = 'nodeSize' in doc ? (doc as ProseMirrorNode) : schema.nodeFromJSON(doc);
    const list: ProseMirrorNode[] = [];
    node.forEach((child) => {
      list.push(child);
    });
    return list;
  };
  return richMarkdownBlocksMeaning(children(a)) === richMarkdownBlocksMeaning(children(b));
}

export const toLf = (text: string) => text.replace(/\r\n/g, '\n');

export function dominantEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > 0 && crlf >= lf ? '\r\n' : '\n';
}

/** A run of source text (a block, a list item, a table row) and what it means. */
interface SourceUnit {
  start: number;
  end: number;
  key: string;
  token?: Token;
}

/** Top-level blocks with their source offsets, or null when the lexer did not
 *  account for every character (offsets would then be unreliable). */
function sourceBlocks(text: string): SourceUnit[] | null {
  let tokens: Token[];
  try {
    tokens = reference.lexer(text);
  } catch {
    return null;
  }
  const blocks: SourceUnit[] = [];
  let offset = 0;
  for (const token of tokens) {
    if (text.slice(offset, offset + token.raw.length) !== token.raw) return null;
    const end = offset + token.raw.length;
    if (token.type !== 'space') blocks.push({ start: offset, end, key: semanticMarkdown(token.raw), token });
    offset = end;
  }
  return offset === text.length ? blocks : null;
}

/** Top-level blocks of `text` as the reference lexer splits them: their
 *  token type and source span (trailing newlines excluded), or null when the
 *  lexer did not account for every character. */
export function markdownBlockSpans(text: string): { type: string; start: number; end: number }[] | null {
  let tokens: Token[];
  try {
    tokens = reference.lexer(text);
  } catch {
    return null;
  }
  const spans: { type: string; start: number; end: number }[] = [];
  let offset = 0;
  for (const token of tokens) {
    if (text.slice(offset, offset + token.raw.length) !== token.raw) return null;
    if (token.type !== 'space')
      spans.push({ type: token.type, start: offset, end: offset + token.raw.replace(/\n+$/, '').length });
    offset += token.raw.length;
  }
  return offset === text.length ? spans : null;
}

/** Consecutive units over `text` from their raw lengths, or null when they do
 *  not tile it exactly. */
function tiledUnits(text: string, parts: { raw: string; key: string }[]): SourceUnit[] | null {
  const units: SourceUnit[] = [];
  let offset = 0;
  for (const part of parts) {
    if (text.slice(offset, offset + part.raw.length) !== part.raw) return null;
    units.push({ start: offset, end: offset + part.raw.length, key: part.key });
    offset += part.raw.length;
  }
  return offset === text.length ? units : null;
}

type Refine = (source: string, unit: SourceUnit, target: string, edited: SourceUnit) => string | null;

/** Work budget (diagonal steps times run length) for one Myers diff. */
const MAX_DIFF_WORK = 2_000_000;

/** A shortest edit script's unchanged pairs between `before[b0, b1)` and
 *  `after[a0, a1)` (Myers, O((n+m)·d)), or null past the work budget. */
function myersPairs(
  before: SourceUnit[],
  after: SourceUnit[],
  b0: number,
  b1: number,
  a0: number,
  a1: number
): [number, number][] | null {
  const n = b1 - b0;
  const m = a1 - a0;
  const max = n + m;
  const maxD = Math.min(max, Math.floor(MAX_DIFF_WORK / Math.max(max, 1)));
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  const same = (x: number, y: number) => before[b0 + x].key === after[a0 + y].key;
  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && same(x, y)) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        const pairs: [number, number][] = [];
        for (let step = d; step > 0; step--) {
          const previous = trace[step];
          const diagonal = x - y;
          const fromK =
            diagonal === -step ||
            (diagonal !== step && previous[offset + diagonal - 1] < previous[offset + diagonal + 1])
              ? diagonal + 1
              : diagonal - 1;
          const fromX = previous[offset + fromK];
          const fromY = fromX - fromK;
          while (x > fromX && y > fromY) pairs.push([b0 + --x, a0 + --y]);
          x = fromX;
          y = fromY;
        }
        while (x > 0 && y > 0) pairs.push([b0 + --x, a0 + --y]);
        return pairs.reverse();
      }
    }
  }
  return null;
}

/** How far `linearPairs` looks ahead for the next equal unit. */
const LINEAR_LOOKAHEAD = 64;

/** Unchanged pairs in linear time, for runs too far apart for a shortest
 *  diff and without unique units to anchor on (repeated identical units):
 *  runs of equal length pair units by position; otherwise a greedy walk
 *  pairs equal units and, at a difference, skips ahead on whichever side
 *  reaches the nearest equal pair (within a bounded window). */
function linearPairs(
  before: SourceUnit[],
  after: SourceUnit[],
  b0: number,
  b1: number,
  a0: number,
  a1: number
): [number, number][] {
  const pairs: [number, number][] = [];
  if (b1 - b0 === a1 - a0) {
    for (let i = b0, j = a0; i < b1; i++, j++) if (before[i].key === after[j].key) pairs.push([i, j]);
    return pairs;
  }
  let i = b0;
  let j = a0;
  while (i < b1 && j < a1) {
    if (before[i].key === after[j].key) {
      pairs.push([i++, j++]);
      continue;
    }
    let skip: [number, number] | null = null;
    for (let distance = 1; distance <= LINEAR_LOOKAHEAD && !skip; distance++) {
      for (let di = 0; di <= distance; di++) {
        const x = i + di;
        const y = j + distance - di;
        if (x < b1 && y < a1 && before[x].key === after[y].key) {
          skip = [x, y];
          break;
        }
      }
    }
    if (skip) [i, j] = skip;
    else {
      i++;
      j++;
    }
  }
  return pairs;
}

/** Index pairs of units that stay unchanged between `before[b0, b1)` and
 *  `after[a0, a1)`. A shortest diff within the work budget; beyond it, units
 *  whose key is unique on both sides anchor the alignment (in order, the
 *  longest increasing run of them) and the gaps between are aligned the same
 *  way, and runs with no such unit are aligned linearly (`linearPairs`), so
 *  unchanged units keep their bytes however far apart the changes are. */
function unchangedPairs(
  before: SourceUnit[],
  after: SourceUnit[],
  b0: number,
  b1: number,
  a0: number,
  a1: number
): [number, number][] {
  const head: [number, number][] = [];
  while (b0 < b1 && a0 < a1 && before[b0].key === after[a0].key) head.push([b0++, a0++]);
  const tail: [number, number][] = [];
  while (b0 < b1 && a0 < a1 && before[b1 - 1].key === after[a1 - 1].key) tail.unshift([--b1, --a1]);
  if (b0 === b1 || a0 === a1) return [...head, ...tail];
  const direct = myersPairs(before, after, b0, b1, a0, a1);
  if (direct) return [...head, ...direct, ...tail];
  const counts = new Map<string, { b: number; a: number; at: number }>();
  for (let i = b0; i < b1; i++) {
    const entry = counts.get(before[i].key) ?? { b: 0, a: 0, at: -1 };
    entry.b++;
    entry.at = i;
    counts.set(before[i].key, entry);
  }
  const candidates: [number, number][] = [];
  for (let j = a0; j < a1; j++) {
    const entry = counts.get(after[j].key);
    if (entry) entry.a++;
  }
  for (let j = a0; j < a1; j++) {
    const entry = counts.get(after[j].key);
    if (entry && entry.b === 1 && entry.a === 1) candidates.push([entry.at, j]);
  }
  // Longest run of candidates increasing on both sides (patience sorting).
  const tails: number[] = [];
  const links: number[] = [];
  candidates.forEach(([b], index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (candidates[tails[mid]][0] < b) low = mid + 1;
      else high = mid;
    }
    links[index] = low ? tails[low - 1] : -1;
    tails[low] = index;
  });
  const anchors: [number, number][] = [];
  for (let index = tails.length ? tails[tails.length - 1] : -1; index !== -1; index = links[index]) {
    anchors.unshift(candidates[index]);
  }
  if (!anchors.length) return [...head, ...linearPairs(before, after, b0, b1, a0, a1), ...tail];
  const pairs: [number, number][] = [...head];
  let b = b0;
  let a = a0;
  for (const anchor of anchors) {
    pairs.push(...unchangedPairs(before, after, b, anchor[0], a, anchor[1]), anchor);
    b = anchor[0] + 1;
    a = anchor[1] + 1;
  }
  pairs.push(...unchangedPairs(before, after, b, b1, a, a1), ...tail);
  return pairs;
}

/**
 * `source` with every run of units that differs from `target` replaced by
 * `target`'s text for it; units both sides share (aligned by key) keep their
 * bytes, also between two separate changes. Where exactly one unit changed
 * on each side, `refine` may rewrite it in place, keeping its own unchanged
 * parts. `separator` joins units appended after the last one.
 */
function spliceUnits(
  source: string,
  before: SourceUnit[],
  target: string,
  after: SourceUnit[],
  separator: string,
  refine?: Refine
): string {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix].key === after[prefix].key) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix].key === after[after.length - 1 - suffix].key
  ) {
    suffix++;
  }
  const sourceAt = (index: number) => (index < before.length ? before[index].start : source.length);
  const targetAt = (index: number) => (index < after.length ? after[index].start : target.length);
  const anchors = [
    ...unchangedPairs(before, after, prefix, before.length - suffix, prefix, after.length - suffix),
    [before.length - suffix, after.length - suffix] as [number, number],
  ];
  let out = source.slice(0, sourceAt(prefix));
  let b = prefix;
  let a = prefix;
  for (const [nextB, nextA] of anchors) {
    const refined = refine && nextB - b === 1 && nextA - a === 1 ? refine(source, before[b], target, after[a]) : null;
    if (refined !== null) {
      out += refined + source.slice(before[b].end, sourceAt(nextB));
    } else if (b < nextB || a < nextA) {
      const middle = target.slice(targetAt(a), targetAt(nextA));
      // Units appended after the original's last one need their own
      // separator, or the first of them would continue the preceding one.
      if (b === before.length && middle) {
        const kept = out.replace(/\n*$/, '');
        out = kept ? kept + separator : kept;
      }
      out += middle;
    }
    // The unchanged unit at the anchor, with the text up to the next unit.
    if (nextB < before.length - suffix) out += source.slice(sourceAt(nextB), sourceAt(nextB + 1));
    b = nextB + 1;
    a = nextA + 1;
  }
  return out + source.slice(sourceAt(before.length - suffix));
}

/** Blocks of `source` the edit left alone keep their bytes; compound blocks
 *  that changed keep their unchanged children. Null when unlexable. */
function spliceMarkdown(source: string, target: string): string | null {
  const before = sourceBlocks(source);
  const after = sourceBlocks(target);
  return before && after ? spliceUnits(source, before, target, after, '\n\n', refineBlock) : null;
}

/** A changed compound block rewritten child by child, keeping its trailing
 *  newlines; null when the two blocks are not the same kind of compound. */
function refineBlock(source: string, unit: SourceUnit, target: string, edited: SourceUnit): string | null {
  const a = unit.token;
  const b = edited.token;
  if (!a || !b || a.type !== b.type) return null;
  const sourceRaw = source.slice(unit.start, unit.end);
  const trailing = /\n*$/.exec(sourceRaw)?.[0] ?? '';
  const sourceCore = sourceRaw.slice(0, sourceRaw.length - trailing.length);
  const targetCore = target.slice(edited.start, edited.end).replace(/\n*$/, '');
  let core: string | null = null;
  if (a.type === 'list' && (a as Tokens.List).ordered === (b as Tokens.List).ordered) {
    core = refineList(sourceCore, a as Tokens.List, targetCore, b as Tokens.List);
  } else if (a.type === 'blockquote') {
    core = refineQuote(sourceCore, targetCore);
  } else if (a.type === 'table') {
    core = refineTable(sourceCore, a as Tokens.Table, targetCore, b as Tokens.Table);
  }
  return core === null ? null : core.replace(/\n+$/, '') + trailing;
}

const BULLET = /^( {0,3})([-*+])(?=[ \t]|$)/;
const ORDINAL = /^( {0,3}\d{1,9})([.)])(?=[ \t]|$)/;

/** A list item's meaning regardless of its marker (an ordinal alone would
 *  render as a list starting there). */
const itemKey = (raw: string) => semanticMarkdown(raw.replace(/^( {0,3})(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)/, '$1-'));

/** List items: unchanged ones keep their bytes; changed ones take the
 *  edit's text with the source list's marker (another bullet character or
 *  delimiter would start a new list). */
function refineList(source: string, a: Tokens.List, target: string, b: Tokens.List): string | null {
  const first = a.items[0]?.raw ?? '';
  const marker = (a.ordered ? ORDINAL : BULLET).exec(first)?.[2];
  if (!marker) return null;
  const adapt = (raw: string) => raw.replace(a.ordered ? ORDINAL : BULLET, `$1${marker}`);
  const items = tiledUnits(
    source,
    a.items.map((item) => ({ raw: item.raw, key: itemKey(item.raw) }))
  );
  const editedRaws = b.items.map((item) => adapt(item.raw));
  const adapted = editedRaws.join('');
  if (target !== b.items.map((item) => item.raw).join('')) return null;
  const editedItems = tiledUnits(
    adapted,
    editedRaws.map((raw) => ({ raw, key: itemKey(raw) }))
  );
  return items && editedItems ? spliceUnits(source, items, adapted, editedItems, '\n', refineItem) : null;
}

const ITEM_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?: {1,4}(?=\S)| ?(?=\n|$))/;

/** A list item's marker and its content with the continuation indent
 *  removed, or null when a line is not indented under the marker. */
function unindentItem(text: string): { marker: string; inner: string } | null {
  const marker = ITEM_MARKER.exec(text)?.[0];
  if (marker === undefined) return null;
  const indent = ' '.repeat(marker.length);
  const [first, ...rest] = text.slice(marker.length).split('\n');
  const lines = [first];
  for (const line of rest) {
    if (!line) lines.push('');
    else if (line.startsWith(indent)) lines.push(line.slice(indent.length));
    else return null;
  }
  return { marker, inner: lines.join('\n') };
}

/** A changed item reconciled on its content (nested lists recursively),
 *  then indented under the source item's own marker. */
function refineItem(source: string, unit: SourceUnit, target: string, edited: SourceUnit): string | null {
  const sourceRaw = source.slice(unit.start, unit.end);
  const trailing = /\n*$/.exec(sourceRaw)?.[0] ?? '';
  const a = unindentItem(sourceRaw.slice(0, sourceRaw.length - trailing.length));
  const b = unindentItem(target.slice(edited.start, edited.end).replace(/\n*$/, ''));
  const inner = a && b ? spliceMarkdown(a.inner, b.inner) : null;
  if (!a || inner === null) return null;
  // A marker followed by nothing keeps no trailing space before content.
  const marker = inner.startsWith('\n') || !inner ? a.marker.trimEnd() : a.marker;
  const indent = ' '.repeat(a.marker.length);
  const [first, ...rest] = inner.replace(/\n+$/, '').split('\n');
  return [marker + first, ...rest.map((line) => (line ? indent + line : ''))].join('\n') + trailing;
}

/** The `>` prefix every line of a quote shares and its unquoted text, or
 *  null when lines are prefixed differently or continue lazily. */
function unquote(text: string): { prefix: string; blank: string; inner: string } | null {
  let prefix: string | null = null;
  let blank: string | null = null;
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^( {0,3}>)( ?)(.*)$/.exec(line);
    if (!match) return null;
    if (!match[3]) {
      if (blank !== null && blank !== line) return null;
      blank = line;
      lines.push('');
      continue;
    }
    if (prefix !== null && prefix !== match[1] + match[2]) return null;
    prefix = match[1] + match[2];
    lines.push(match[3]);
  }
  return { prefix: prefix ?? '> ', blank: blank ?? '>', inner: lines.join('\n') };
}

/** A quote reconciled on its unquoted content, then quoted in the source's
 *  own style. */
function refineQuote(source: string, target: string): string | null {
  const a = unquote(source);
  const b = unquote(target);
  const inner = a && b ? spliceMarkdown(a.inner, b.inner) : null;
  if (!a || inner === null) return null;
  return inner
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => (line ? a.prefix + line : a.blank))
    .join('\n');
}

/** Table rows: unchanged rows (and an unchanged alignment row) keep their bytes. */
function refineTable(source: string, a: Tokens.Table, target: string, b: Tokens.Table): string | null {
  const rows = (text: string, table: Tokens.Table) => {
    const lines = text.split('\n');
    if (lines.length !== table.rows.length + 2) return null;
    const keys = ([table.header, table.align, ...table.rows] as unknown[][]).map((row) =>
      JSON.stringify(
        row.map((cell) => (cell && typeof cell === 'object' ? semanticMarkdown((cell as Tokens.TableCell).text) : cell))
      )
    );
    return tiledUnits(
      text,
      lines.map((line, index) => ({ raw: index < lines.length - 1 ? `${line}\n` : line, key: keys[index] }))
    );
  };
  const before = rows(source, a);
  const after = rows(target, b);
  return before && after ? spliceUnits(source, before, target, after, '\n') : null;
}

/**
 * Carries an edit into the original source: blocks the edit did not change
 * keep their exact original bytes (list markers, emphasis style, blank
 * lines), and so do the unchanged items, rows and quoted blocks inside a
 * changed list, table or quote; only the changed parts take the editor's
 * canonical form. The result is verified to mean exactly `edited`; otherwise
 * `edited` is used. Line endings and the trailing newline follow the original.
 */
export function reconcileMarkdown(original: string, edited: string): string {
  const eol = dominantEol(original);
  const source = toLf(original);
  const target = toLf(edited);
  const trailing = /\n*$/.exec(source)?.[0] ?? '';
  const withTrailing = (text: string) => text.replace(/\n*$/, '') + trailing;
  const meaning = semanticMarkdown(target);
  let result = withTrailing(target);
  const before = sourceBlocks(source);
  const after = sourceBlocks(target);
  if (before && after) {
    // Block-level splicing alone is the fallback when the finer one fails.
    for (const refine of [refineBlock, undefined]) {
      const spliced = withTrailing(spliceUnits(source, before, target, after, '\n\n', refine));
      if (semanticMarkdown(spliced) === meaning) {
        result = spliced;
        break;
      }
    }
  }
  return eol === '\r\n' ? result.replace(/\n/g, '\r\n') : result;
}

/** The smallest single replacement turning `before` into `after`, never
 *  splitting a surrogate pair or a CRLF; null when they are equal. */
export function minimalTextEdit(before: string, after: string): { start: number; end: number; text: string } | null {
  if (before === after) return null;
  const limit = Math.min(before.length, after.length);
  let start = 0;
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  const unsafeBoundary = (text: string, index: number) => {
    const code = text.charCodeAt(index);
    return (code >= 0xdc00 && code <= 0xdfff) || (text[index] === '\n' && text[index - 1] === '\r');
  };
  while (start > 0 && (unsafeBoundary(before, start) || unsafeBoundary(after, start))) start--;
  let tail = 0;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
  ) {
    tail++;
  }
  while (tail > 0 && (unsafeBoundary(before, before.length - tail) || unsafeBoundary(after, after.length - tail))) {
    tail--;
  }
  return { start, end: before.length - tail, text: after.slice(start, after.length - tail) };
}
