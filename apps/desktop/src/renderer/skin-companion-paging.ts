// Mixy's reply in the pet's bubble: its markdown, parsed by the app's own
// parser (markdown-ast.ts) and drawn compact (paragraphs, bold, inline code,
// lists; headings bold; code and tables as plain text blocks), and a long
// one read page by page: as much as fits the page's height budget
// (desktop-pet.css .skin-companion-page), measured in the bubble itself.
import { parseMarkdownToHast } from './markdown-ast';

/** Reading pace: about fourteen characters a second, at least 2.5 s a page. */
export const PAGE_MIN_MS = 2500;
export const PAGE_CHARS_PER_SECOND = 14;

export function pageReadMs(page: string): number {
  return Math.max(PAGE_MIN_MS, Math.round(([...page].length / PAGE_CHARS_PER_SECOND) * 1000));
}

/** A stretch of text with its inline marks. */
export interface ReplyRun {
  text: string;
  strong?: boolean;
  em?: boolean;
  code?: boolean;
}

/** One block the bubble draws: a paragraph, a list item (its own line,
 *  indented by depth, with its marker unless it continues one), or a code
 *  block. `quote` marks a quoted one. */
export interface ReplyBlock {
  kind: 'p' | 'li' | 'pre';
  runs: ReplyRun[];
  depth?: number;
  marker?: string;
  quote?: boolean;
}

/** A page: its blocks, and its words (for its reading time). */
export interface ReplyPage {
  blocks: ReplyBlock[];
  text: string;
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const textOf = (node: HastNode): string =>
  node.type === 'text' ? String(node.value ?? '') : (node.children ?? []).map(textOf).join('');

const classes = (node: HastNode) => {
  const value = node.properties?.className;
  return Array.isArray(value) ? value.map(String) : [];
};

function find(node: HastNode, tag: string): HastNode | null {
  if (node.tagName === tag) return node;
  for (const child of node.children ?? []) {
    const found = find(child, tag);
    if (found) return found;
  }
  return null;
}

/** Inline content as runs: soft line breaks are spaces, `<br>` a break;
 *  links and images are their words; math is its source, as code. */
function inline(node: HastNode, marks: Omit<ReplyRun, 'text'>, out: ReplyRun[]) {
  if (node.type === 'text') {
    const text = String(node.value ?? '').replace(/\s*\n\s*/g, ' ');
    if (text) out.push({ text, ...marks });
    return;
  }
  if (node.type !== 'element') return;
  const tag = node.tagName;
  if (tag === 'br') out.push({ text: '\n', ...marks });
  else if (tag === 'img') out.push({ text: String(node.properties?.alt ?? ''), ...marks });
  else if (tag === 'input') out.push({ text: node.properties?.checked ? '☑ ' : '☐ ', ...marks });
  else if (classes(node).includes('katex')) {
    const source = find(node, 'annotation');
    out.push({ text: source ? textOf(source) : textOf(node), ...marks, code: true });
  } else if (tag === 'code') out.push({ text: textOf(node), ...marks, code: true });
  else {
    const next = {
      ...marks,
      ...(tag === 'strong' || tag === 'b' ? { strong: true } : {}),
      ...(tag === 'em' || tag === 'i' ? { em: true } : {}),
    };
    for (const child of node.children ?? []) inline(child, next, out);
  }
}

/** Runs with the block's outer whitespace trimmed and empty runs dropped. */
function trimmed(runs: ReplyRun[]): ReplyRun[] {
  const out = runs.map((run) => ({ ...run }));
  if (out.length) out[0].text = out[0].text.trimStart();
  if (out.length) out[out.length - 1].text = out[out.length - 1].text.trimEnd();
  return out.filter((run) => run.text);
}

const BLOCK_TAGS = new Set([
  'p',
  'ul',
  'ol',
  'pre',
  'table',
  'blockquote',
  'hr',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

function blocksOf(node: HastNode, quote: boolean, depth: number, out: ReplyBlock[]) {
  const push = (block: ReplyBlock) => {
    const runs = trimmed(block.runs);
    if (runs.length) out.push({ ...block, runs, ...(quote ? { quote: true } : {}) });
  };
  for (const child of node.children ?? []) {
    if (child.type === 'text') {
      if (child.value?.trim()) push({ kind: 'p', runs: [{ text: child.value }] });
      continue;
    }
    if (child.type !== 'element') continue;
    const tag = child.tagName ?? '';
    const runs: ReplyRun[] = [];
    if (tag === 'p') {
      inline(child, {}, runs);
      push({ kind: 'p', runs });
    } else if (/^h[1-6]$/.test(tag)) {
      inline(child, { strong: true }, runs);
      push({ kind: 'p', runs });
    } else if (tag === 'pre') {
      push({ kind: 'pre', runs: [{ text: textOf(child), code: true }] });
    } else if (tag === 'table') {
      const rows = (child.children ?? []).flatMap((part) => (part.tagName === 'tr' ? [part] : (part.children ?? [])));
      const lines = rows
        .filter((row) => row.tagName === 'tr')
        .map((row) =>
          (row.children ?? [])
            .filter((cell) => cell.type === 'element')
            .map((cell) => textOf(cell).trim())
            .join(' · ')
        );
      push({ kind: 'pre', runs: [{ text: lines.join('\n') }] });
    } else if (tag === 'ul' || tag === 'ol') {
      const start = Number(child.properties?.start) || 1;
      const items = (child.children ?? []).filter((item) => item.tagName === 'li');
      items.forEach((item, index) => {
        const marker = tag === 'ol' ? `${start + index}.` : '•';
        let marked = false;
        const own: ReplyRun[] = [];
        const flushOwn = () => {
          const parts = trimmed(own.splice(0));
          if (!parts.length) return;
          out.push({
            kind: 'li',
            runs: parts,
            depth,
            ...(marked ? {} : { marker }),
            ...(quote ? { quote: true } : {}),
          });
          marked = true;
        };
        for (const part of item.children ?? []) {
          if (part.type === 'element' && part.tagName === 'p') {
            flushOwn();
            inline(part, {}, own);
            flushOwn();
          } else if (part.type === 'element' && BLOCK_TAGS.has(part.tagName ?? '')) {
            flushOwn();
            blocksOf({ type: 'root', children: [part] }, quote, depth + 1, out);
          } else inline(part, {}, own);
        }
        flushOwn();
      });
    } else if (tag === 'blockquote') {
      blocksOf(child, true, depth, out);
    } else if (tag === 'hr') {
      // A rule carries no words.
    } else if (BLOCK_TAGS.has(tag) || tag === 'section') {
      blocksOf(child, quote, depth, out);
    } else {
      inline(child, {}, runs);
      push({ kind: 'p', runs });
    }
  }
}

/** The reply's blocks, from the app's markdown parser. */
export function replyBlocks(markdown: string): ReplyBlock[] {
  const out: ReplyBlock[] = [];
  blocksOf(parseMarkdownToHast(markdown) as HastNode, false, 0, out);
  return out;
}

export const blockText = (block: ReplyBlock) => block.runs.map((run) => run.text).join('');

export function replyPage(blocks: ReplyBlock[]): ReplyPage {
  return { blocks, text: blocks.map(blockText).join('\n') };
}

/** `blocks` drawn into `document`: the bubble shows these (data-pet-md). */
export function renderReplyBlocks(doc: Document, blocks: ReplyBlock[]): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  for (const block of blocks) {
    const element = doc.createElement(block.kind === 'pre' ? 'pre' : block.kind === 'li' ? 'div' : 'p');
    element.className = `skin-companion-md-${block.kind}`;
    if (block.quote) element.dataset.quote = 'true';
    if (block.kind === 'li') {
      element.style.setProperty('--depth', String(block.depth ?? 0));
      const mark = doc.createElement('span');
      mark.className = 'skin-companion-md-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = block.marker ?? '';
      element.append(mark);
    }
    for (const run of block.runs) {
      let node: Node = doc.createTextNode(run.text);
      if (run.code && block.kind !== 'pre') node = wrap(doc, 'code', node);
      if (run.em) node = wrap(doc, 'em', node);
      if (run.strong) node = wrap(doc, 'strong', node);
      element.append(node);
    }
    fragment.append(element);
  }
  return fragment;
}

function wrap(doc: Document, tag: string, child: Node): HTMLElement {
  const element = doc.createElement(tag);
  element.append(child);
  return element;
}

/** Runs between text offsets `start` and `end` of the block. */
function sliceRuns(runs: ReplyRun[], start: number, end: number): ReplyRun[] {
  const out: ReplyRun[] = [];
  let at = 0;
  for (const run of runs) {
    const from = Math.max(start, at);
    const to = Math.min(end, at + run.text.length);
    if (to > from) out.push({ ...run, text: run.text.slice(from - at, to - at) });
    at += run.text.length;
  }
  return out;
}

const SENTENCE = /[^.!?。！？…\n]+(?:[.!?。！？…]+["'”’)\]]*)?\s*|[.!?。！？…\n]+\s*/gu;
const LINE = /[^\n]*\n|[^\n]+/g;
const WORD = /\S+\s*|\s+/gu;

/** The [start, end) pieces of `text` from offset `from`: sentences (a code
 *  block: lines), words, then characters. */
function pieces(text: string, from: number, to: number, level: number, pre: boolean): Array<[number, number]> {
  const pattern = level === 0 ? (pre ? LINE : SENTENCE) : level === 1 ? WORD : null;
  const slice = text.slice(from, to);
  if (!pattern)
    return [...slice].reduce<Array<[number, number]>>((out, char) => {
      const start = out.length ? out[out.length - 1][1] : from;
      out.push([start, start + char.length]);
      return out;
    }, []);
  return [...slice.matchAll(new RegExp(pattern.source, pattern.flags))].map((match) => [
    from + (match.index ?? 0),
    from + (match.index ?? 0) + match[0].length,
  ]);
}

/** How a page is measured: whether it fits the budget, and whether it
 *  already holds at least half of it. */
export interface PageMeasure {
  fits(blocks: ReplyBlock[]): boolean;
  half(blocks: ReplyBlock[]): boolean;
}

/** `blocks` in pages that each fit. A block that does not fully fit moves
 *  whole to the next page when the page already holds half its budget;
 *  else (or when it fits no page) it continues there piece by piece, the
 *  page ending at its last sentence end that fits, else its last word (a
 *  word wider than a page, its last character). */
export function splitReplyPages(blocks: ReplyBlock[], measure: PageMeasure): ReplyPage[] {
  const pages: ReplyPage[] = [];
  let page: ReplyBlock[] = [];
  const flush = () => {
    if (page.length) pages.push(replyPage(page));
    page = [];
  };
  for (const block of blocks) {
    if (measure.fits([...page, block])) {
      page.push(block);
      continue;
    }
    if (page.length && measure.half(page)) {
      flush();
      if (measure.fits([block])) {
        page.push(block);
        continue;
      }
    }
    const text = blockText(block);
    // The block's part on the current page: [partStart, partEnd).
    let partStart = 0;
    let partEnd = 0;
    const fragment = (start: number, end: number): ReplyBlock => {
      const runs = trimmed(sliceRuns(block.runs, start, end));
      // Continued on a new page: no second marker.
      return start > 0 && block.marker ? { ...block, runs, marker: undefined } : { ...block, runs };
    };
    const commit = () => {
      if (partEnd > partStart) page.push(fragment(partStart, partEnd));
    };
    const place = (start: number, end: number, level: number) => {
      if (measure.fits([...page, fragment(partStart, end)])) {
        partEnd = end;
        return;
      }
      if ((page.length || partEnd > partStart) && measure.fits([fragment(start, end)])) {
        commit();
        flush();
        partStart = start;
        partEnd = end;
        return;
      }
      if (level < 3) {
        for (const [from, to] of pieces(text, start, end, level, block.kind === 'pre')) place(from, to, level + 1);
        return;
      }
      // One character wider than a page: a page of its own.
      commit();
      flush();
      partStart = start;
      partEnd = end;
    };
    for (const [from, to] of pieces(text, 0, text.length, 0, block.kind === 'pre')) place(from, to, 1);
    commit();
  }
  flush();
  return pages;
}

/** The reply's pages, measured in a hidden copy of the paged bubble inside
 *  the pet's root (the same classes: the same width, font and budget). */
export function measureReplyPages(anchor: HTMLElement, markdown: string): ReplyPage[] {
  const doc = anchor.ownerDocument;
  const root = anchor.closest('.skin-companion') ?? doc.body;
  const probe = doc.createElement('div');
  probe.className = 'skin-companion-bubble skin-companion-measure';
  probe.dataset.state = 'reply';
  probe.dataset.paged = 'true';
  probe.setAttribute('aria-hidden', 'true');
  const body = doc.createElement('div');
  body.className = 'skin-companion-page skin-companion-md';
  probe.append(body);
  root.append(probe);
  try {
    const budget = Number.parseFloat(getComputedStyle(body).maxHeight);
    const show = (blocks: ReplyBlock[]) => body.replaceChildren(renderReplyBlocks(doc, blocks));
    return splitReplyPages(replyBlocks(markdown), {
      fits: (blocks) => {
        show(blocks);
        return body.scrollHeight <= body.clientHeight + 1;
      },
      half: (blocks) => {
        show(blocks);
        return body.scrollHeight >= budget / 2;
      },
    });
  } finally {
    probe.remove();
  }
}
