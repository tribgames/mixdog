import type { MarkdownAstRoot } from './markdown-ast';
import {
  canSyncParseMarkdown,
  LatestMarkdownAstQueue,
  parseLiveMarkdownAst,
  parseStreamingMarkdownAst,
  readCachedStreamingMarkdownAst,
  SYNC_MARKDOWN_PARSE_BUDGET_MS,
  SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS,
  syncMarkdownParser,
} from './markdown-worker-client';
import { containsFencedCodeMarkdown } from './MarkdownSourceFallback';
import {
  createStreamingMarkdownCache,
  healStreamingMarkdownTail,
  resolveStreamingMarkdownChunks,
} from './streaming-markdown';
import { noteStreamSyncParse, noteStreamWorkerParse } from './transcript-stream-metrics';

export type MarkdownAstChild = MarkdownAstRoot['children'][number];

/** Children of a page, at every level. */
export const PAGE_FANOUT = 32;
/** Levels of pages, the root's included: room for 32^4 units, more than a
 *  reply holds (units past that join the last page). */
export const PAGE_LEVELS = 4;

/** One top-level child of a reply's parse, as the reply shows it. */
export interface MarkdownUnit {
  /** Its role and where it starts in the reply; a child without a place in
   *  the text (one a plugin made) is keyed after the last one that has one. */
  readonly key: string;
  /** null: the parse of `text` is still to land. */
  readonly node: MarkdownAstChild | null;
  /** Where the offsets in `node` count from in the reply. */
  readonly base: number;
  /** The reply's text it shows: [from, end). */
  readonly from: number;
  readonly end: number;
  /** Stays in the DOM while the reply grows: the open block and the unit
   *  right before it. */
  readonly held: boolean;
  /** Without a node: the text waiting for its parse, and whether a parse is
   *  awaited at all. */
  readonly text?: string;
  readonly pending?: boolean;
}

/** Up to PAGE_FANOUT pages or, at the last level, units. */
export interface MarkdownPage {
  readonly key: string;
  readonly items: readonly MarkdownPageItem[];
}

export type MarkdownPageItem = MarkdownPage | MarkdownUnit;

export const isMarkdownPage = (item: MarkdownPageItem): item is MarkdownPage => 'items' in item;

const EMPTY_ROOT: MarkdownPage = { key: 'root', items: [] };

/** `root` with positions [at, at + units.length) holding `units`. Only the
 *  pages on their paths are new; the rest are `root`'s. */
function writeUnits(root: MarkdownPage, at: number, units: readonly MarkdownUnit[]): MarkdownPage {
  if (units.length === 0) return root;
  const to = at + units.length;
  const last = PAGE_FANOUT - 1;
  const write = (page: MarkdownPage | undefined, key: string, level: number, start: number, end: number) => {
    const items = page ? page.items.slice() : [];
    const from = Math.max(at, start);
    const until = Math.min(to, end);
    if (level === 1) {
      for (let position = from; position < until; position += 1) items[position - start] = units[position - at];
    } else {
      const span = PAGE_FANOUT ** (level - 1);
      const first = Math.min(last, Math.floor((from - start) / span));
      const final = Math.min(last, Math.floor((until - 1 - start) / span));
      for (let index = first; index <= final; index += 1) {
        const childStart = start + index * span;
        // The last page of a level takes what lies past the levels' room.
        const childEnd = index === last ? end : childStart + span;
        const child = items[index] as MarkdownPage | undefined;
        items[index] = write(child, child?.key ?? String(index), level - 1, childStart, childEnd);
      }
    }
    return { key, items } satisfies MarkdownPage;
  };
  return write(root, root.key, PAGE_LEVELS, 0, Number.POSITIVE_INFINITY);
}

/** `units`, in order, filling pages. */
export function markdownPagesOf(units: readonly MarkdownUnit[]): MarkdownPage {
  return writeUnits(EMPTY_ROOT, 0, units);
}

const roleOf = (node: MarkdownAstChild) => (node.type === 'element' ? String(node.tagName) : node.type);

/** The units of `root`, parsed from the reply's text [from, end), its
 *  offsets counting from `base`. */
export function unitsOf(root: MarkdownAstRoot, base: number, from: number, end: number): MarkdownUnit[] {
  const children = root.children;
  // Where the next child with a place in the text starts, from each child on.
  const next: number[] = new Array(children.length + 1);
  next[children.length] = end;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const offset = children[index].offset;
    next[index] = offset === undefined ? next[index + 1] : base + offset;
  }
  const units: MarkdownUnit[] = [];
  let anchor = `^${from}`;
  let seen = new Map<string, number>();
  let start = from;
  children.forEach((node, index) => {
    const role = roleOf(node);
    let key: string;
    if (node.offset === undefined) {
      const occurrence = seen.get(role) ?? 0;
      seen.set(role, occurrence + 1);
      key = `${anchor}+${role}#${occurrence}`;
    } else {
      anchor = `${role}@${base + node.offset}`;
      key = anchor;
      seen = new Map();
    }
    const stop = Math.max(start, next[index + 1]);
    units.push({ key, node, base, from: start, end: stop, held: false });
    start = stop;
  });
  return units;
}

function waitingUnit(from: number, text: string, pending: boolean): MarkdownUnit {
  return { key: `wait@${from}`, node: null, base: from, from, end: from + text.length, held: false, text, pending };
}

/** The pages of a finished reply, parsed whole as `root` from text of
 *  `length`. Each child the pages `shown` held (by key: role and place in the
 *  text) stays in its page under its key and takes its final node; the others
 *  join the page of the child before them. Pages left empty go. Without
 *  `shown`, the children fill pages in order. */
export function finishDocument(shown: MarkdownPage | null, root: MarkdownAstRoot, length: number): MarkdownPage {
  const units = unitsOf(root, 0, 0, length);
  if (!shown || shown.items.length === 0) return markdownPagesOf(units);
  const leafOf = new Map<string, number>();
  let leaves = 0;
  const index = (page: MarkdownPage, level: number) => {
    if (level === 1) {
      for (const item of page.items) leafOf.set(item.key, leaves);
      leaves += 1;
      return;
    }
    for (const item of page.items) index(item as MarkdownPage, level - 1);
  };
  index(shown, PAGE_LEVELS);
  const placed: MarkdownUnit[][] = Array.from({ length: leaves }, () => []);
  let leaf = 0;
  for (const unit of units) {
    const at = leafOf.get(unit.key);
    if (at !== undefined && at >= leaf) leaf = at;
    placed[leaf].push(unit);
  }
  let built = 0;
  const rebuild = (page: MarkdownPage, level: number): MarkdownPage | null => {
    if (level === 1) {
      const items = placed[built++];
      return items.length > 0 ? { key: page.key, items } : null;
    }
    const items: MarkdownPage[] = [];
    for (const item of page.items) {
      const child = rebuild(item as MarkdownPage, level - 1);
      if (child) items.push(child);
    }
    return items.length > 0 ? { key: page.key, items } : null;
  };
  return rebuild(shown, PAGE_LEVELS) ?? { key: shown.key, items: [] };
}

/** A completed block of the live reply, waiting for its parse, or parsed and
 *  waiting for those before it: blocks enter the frozen pages in order. */
interface WaitingBlock {
  readonly start: number;
  readonly text: string;
  units: MarkdownUnit[];
  parsed: boolean;
  requested: boolean;
}

/** A live reply's pages. Completed blocks are parsed once, from their own
 *  text, and enter fixed pages that never change again; the open block is
 *  healed and parsed anew as it grows, at the positions it will keep once
 *  complete. Parses that cannot run now go to the worker, and `changed` is
 *  called when one lands. */
export class LiveMarkdownDocument {
  private readonly cache = createStreamingMarkdownCache();
  private generation = 0;
  private frozen: MarkdownPage = EMPTY_ROOT;
  private count = 0;
  private last: MarkdownUnit | null = null;
  private waiting: WaitingBlock[] = [];
  private tailStart = 0;
  private tailText = '';
  private tailParseText = '';
  private tailParse = true;
  /** What shows of the open block: the latest parse that landed for it, or
   *  until one lands for it where it starts now, what showed of it before. */
  private tailUnits: MarkdownUnit[] = [];
  private tailShown = false;
  /** The healed text `tailUnits` were parsed from (null: an earlier open block). */
  private tailShownText: string | null = null;
  private tailShownLength = 0;
  private tailRequested: string | null = null;
  private readonly tailQueue = new LatestMarkdownAstQueue(parseLiveMarkdownAst);
  /** The open block parses on the worker from this length on: a main-thread
   *  parse of it took too long. */
  private slowAt = Number.POSITIVE_INFINITY;
  private text: string | null = null;
  private view: MarkdownPage = EMPTY_ROOT;
  private dirty = true;
  private retired = false;
  private readonly heldCopies = new WeakMap<MarkdownUnit, MarkdownUnit>();

  constructor(private readonly changed: () => void) {}

  /** The pages showing the live reply `text`. */
  update(text: string): MarkdownPage {
    if (text !== this.text) {
      this.advance(text);
      this.text = text;
      this.dirty = true;
    }
    return this.current();
  }

  /** The pages last shown. */
  current(): MarkdownPage {
    if (this.dirty) {
      this.view = this.publish();
      this.dirty = false;
    }
    return this.view;
  }

  /** Sends the parses that could not run in the render to the worker. */
  flush(): void {
    if (this.retired) return;
    const generation = this.generation;
    for (const block of this.waiting) {
      if (block.parsed || block.requested) continue;
      block.requested = true;
      const requestedAt = performance.now();
      void parseStreamingMarkdownAst(block.text).then(
        (root) => {
          if (this.retired || this.generation !== generation) return;
          noteStreamWorkerParse(requestedAt);
          block.units = unitsOf(root, block.start, block.start, block.start + block.text.length);
          block.parsed = true;
          this.admit();
          this.dirty = true;
          this.changed();
        },
        () => undefined
      );
    }
    const parseText = this.tailParseText;
    if (!this.wantsTailParse() || parseText === this.tailRequested) return;
    this.tailRequested = parseText;
    const start = this.tailStart;
    const sourceLength = this.tailText.length;
    const requestedAt = performance.now();
    this.tailQueue.request(parseText, (root, parsedText) => {
      if (this.retired || this.generation !== generation || this.tailStart !== start) return;
      noteStreamWorkerParse(requestedAt);
      // An older parse than the one showing is dropped.
      if (sourceLength < this.tailShownLength) return;
      this.showTail(root, parsedText, sourceLength);
      this.dirty = true;
      this.changed();
    });
  }

  /** Nothing more is shown from this reply's live parses. */
  retire(): void {
    this.retired = true;
    this.tailQueue.dispose();
    this.waiting = [];
    this.tailUnits = [];
    this.frozen = EMPTY_ROOT;
    this.last = null;
  }

  private advance(text: string): void {
    const parts = resolveStreamingMarkdownChunks(text, this.cache);
    if (parts.generation !== this.generation) {
      // The text no longer continues what was frozen.
      this.generation = parts.generation;
      this.frozen = EMPTY_ROOT;
      this.count = 0;
      this.last = null;
      this.waiting = [];
      this.tailStart = -1;
      this.tailUnits = [];
    }
    for (const { start, text: blockText } of parts.added) {
      const root = this.parseNow(blockText, false);
      const end = start + blockText.length;
      // Until its parse lands, a block shows what the open block showed of it.
      const shown = root ? [] : this.tailUnits.filter((unit) => unit.node && unit.from >= start && unit.from < end);
      let units = shown.length > 0 ? shown : [waitingUnit(start, blockText, true)];
      if (root) units = unitsOf(root, start, start, end);
      this.waiting.push({
        start,
        text: blockText,
        units,
        parsed: Boolean(root),
        requested: false,
      });
    }
    this.admit();
    if (parts.unstableStart !== this.tailStart) {
      this.tailStart = parts.unstableStart;
      this.tailUnits = this.tailUnits.filter((unit) => unit.node && unit.from >= this.tailStart);
      this.tailShown = this.tailUnits.length > 0;
      this.tailShownText = null;
      this.tailShownLength = 0;
      this.tailRequested = null;
      this.slowAt = Number.POSITIVE_INFINITY;
    }
    this.tailText = parts.unstableText;
    this.tailParse = parts.parseUnstable;
    this.tailParseText = parts.parseUnstable ? healStreamingMarkdownTail(parts.unstableText) : '';
    if (this.wantsTailParse()) {
      const root = this.parseNow(this.tailParseText, true);
      if (root) this.showTail(root, this.tailParseText, this.tailText.length);
    }
  }

  private wantsTailParse(): boolean {
    return this.tailParse && this.tailText !== '' && this.tailParseText !== this.tailShownText;
  }

  /** `text`'s parse, if it can be had in this render. The open block, parsed
   *  anew as it grows, goes to the worker from the length that parsed slowly. */
  private parseNow(text: string, open: boolean): MarkdownAstRoot | null {
    const cached = readCachedStreamingMarkdownAst(text);
    if (cached) return cached;
    const parser = canSyncParseMarkdown(text) ? syncMarkdownParser() : null;
    if (!parser || text.length > SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS || (open && text.length >= this.slowAt)) {
      return null;
    }
    const startedAt = performance.now();
    const root = parser(text);
    const duration = performance.now() - startedAt;
    noteStreamSyncParse(duration, text.length);
    if (open && duration > SYNC_MARKDOWN_PARSE_BUDGET_MS) this.slowAt = text.length;
    return root;
  }

  private showTail(root: MarkdownAstRoot, parsedText: string, sourceLength: number): void {
    this.tailUnits = unitsOf(root, this.tailStart, this.tailStart, this.tailStart + sourceLength);
    this.tailShown = true;
    this.tailShownText = parsedText;
    this.tailShownLength = sourceLength;
  }

  /** Parsed blocks at the head of the waiting ones enter the frozen pages. */
  private admit(): void {
    let ready = 0;
    while (ready < this.waiting.length && this.waiting[ready].parsed) ready += 1;
    if (ready === 0) return;
    const units = this.waiting.slice(0, ready).flatMap((block) => block.units);
    this.waiting = this.waiting.slice(ready);
    this.frozen = writeUnits(this.frozen, this.count, units);
    this.count += units.length;
    if (units.length > 0) this.last = units[units.length - 1];
  }

  private held(unit: MarkdownUnit): MarkdownUnit {
    if (unit.held) return unit;
    let copy = this.heldCopies.get(unit);
    if (!copy) {
      copy = { ...unit, held: true };
      this.heldCopies.set(unit, copy);
    }
    return copy;
  }

  private tailRows(): readonly MarkdownUnit[] {
    if (!this.tailText) return [];
    if (this.tailShown) return this.tailUnits;
    return this.tailParse || containsFencedCodeMarkdown(this.tailText)
      ? [waitingUnit(this.tailStart, this.tailText, this.tailParse)]
      : [];
  }

  private publish(): MarkdownPage {
    const tail = this.tailRows();
    const shown = this.waiting.flatMap((block) => block.units);
    let at = this.count;
    if (tail.length > 0) {
      if (shown.length > 0) shown[shown.length - 1] = this.held(shown[shown.length - 1]);
      else if (this.last) {
        at -= 1;
        shown.push(this.held(this.last));
      }
      for (const unit of tail) shown.push(this.held(unit));
    }
    return writeUnits(this.frozen, at, shown);
  }
}
