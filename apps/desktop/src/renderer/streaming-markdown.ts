import { isPendingLocalPathMention } from './markdown-plugins';
// @ts-expect-error Shared runtime ESM intentionally has no separate declaration file.
import { healStreamingMarkdownTail as healMarkdownTail } from '../../../../src/ui/streaming-markdown-heal.mjs';

export function healStreamingMarkdownTail(text: string): string {
  return healMarkdownTail(text, isPendingLocalPathMention);
}

interface StreamingMarkdownCache {
  stableText: string;
  stableChunks: string[];
  stableChunkKeys: string[];
  sourceText: string;
  scanOffset: number;
  fenceMarker: string;
  fenceLength: number;
  boundaries: number[];
  scannedCharacters: number;
}

interface StreamingMarkdownParts {
  stableChunks: readonly string[];
  stableChunkKeys: readonly string[];
  unstableText: string;
  unstableKey: string;
  parseUnstable: boolean;
}

/* Safety valve, not a rendering mode. The streaming projection normally has
 * no size cap: every projection
 * re-lexes the whole response, freezes all but the last token, and heals that
 * last token so it is always parsed. Our 8 KiB cap fired on ordinary output —
 * one long list or an open fence has no stable boundary, so the whole tail
 * crossed it mid-stream and the reader watched raw `**`/`##` markers appear
 * (user: 스크립트 완성되기 전에 원문이 나온다). 64 KiB only guards against a
 * pathological unbounded tail; below it the tail always parses, and above it
 * the renderer now holds the last completed parse instead of dropping to
 * source (StreamingMarkdownBody). */
export const MAX_STREAMING_UNSTABLE_MARKDOWN_CHARS = 64 * 1024;
const STREAM_APPEND_PROBE_CHARS = 128;
const nonPlainTextMarkdownSyntax = /[\\`*_[\]<>|&$]/;
const gfmAutolink = /\b(?:https?:\/\/|www\.)/i;
const gfmStrikethrough = /~~/;
const blockMarkdownSyntax = /(^|\n)\s{0,3}(?:#{1,6}\s|>\s?|[-+]\s|\d+[.)]\s|---+\s*$)/;

export function createStreamingMarkdownCache(): StreamingMarkdownCache {
  return {
    stableText: '',
    stableChunks: [],
    stableChunkKeys: [],
    sourceText: '',
    scanOffset: 0,
    fenceMarker: '',
    fenceLength: 0,
    boundaries: [],
    scannedCharacters: 0,
  };
}

function resetCache(cache: StreamingMarkdownCache): void {
  Object.assign(cache, createStreamingMarkdownCache());
}

function markdownChunkKey(offset: number): string {
  return `chunk-${Math.max(0, Math.round(offset))}`;
}

/** One literal line needs no GFM parser. */
export function isPlainTextMarkdown(text: string): boolean {
  const value = String(text ?? '');
  return (
    Boolean(value) &&
    !value.includes('\n') &&
    !nonPlainTextMarkdownSyntax.test(value) &&
    !gfmAutolink.test(value) &&
    !gfmStrikethrough.test(value) &&
    !blockMarkdownSyntax.test(value)
  );
}

// Engine streaming tails are append-only in normal operation. Bounded probes
// still detect truncation/replacement without comparing an ever-growing
// response from byte zero on every token flush.
function continuesStreamingText(previous: string, next: string): boolean {
  if (!previous || previous === next) return true;
  if (next.length < previous.length) return false;
  const headLength = Math.min(STREAM_APPEND_PROBE_CHARS, previous.length);
  if (next.slice(0, headLength) !== previous.slice(0, headLength)) return false;
  const tailStart = Math.max(headLength, previous.length - STREAM_APPEND_PROBE_CHARS);
  return next.slice(tailStart, previous.length) === previous.slice(tailStart);
}

// Incrementally track fence state and complete-line scan cost. Open fences use
// this cheap path so a multi-thousand-line code stream is never reparsed from
// byte zero on every renderer frame.
function scanStreamingMarkdownLines(text: string, cache: StreamingMarkdownCache): void {
  let lineStart = cache.scanOffset;
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart);
    if (newline < 0) break;
    const rawLine = text.slice(lineStart, newline).replace(/\r$/, '');
    const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(rawLine);
    if (fence) {
      const marker = fence[1][0];
      if (!cache.fenceMarker) {
        cache.fenceMarker = marker;
        cache.fenceLength = fence[1].length;
      } else if (marker === cache.fenceMarker && fence[1].length >= cache.fenceLength && !fence[2].trim()) {
        cache.fenceMarker = '';
        cache.fenceLength = 0;
      }
    } else if (!cache.fenceMarker && !rawLine.trim()) {
      cache.boundaries.push(newline + 1);
      if (cache.boundaries.length > 2) cache.boundaries.shift();
    }
    cache.scannedCharacters += newline + 1 - lineStart;
    lineStart = newline + 1;
  }
  cache.scanOffset = lineStart;
}

// Projection model: every complete top-level block except the final block
// becomes immutable. The remaining block is the sole mutable tail.
function stableMarkdownBoundaries(text: string, cache: StreamingMarkdownCache): number[] {
  scanStreamingMarkdownLines(text, cache);
  const base = cache.stableText.length;
  if (cache.fenceMarker) {
    let beforeFence: number | undefined;
    for (let index = cache.boundaries.length - 1; index >= 0; index -= 1) {
      const position = cache.boundaries[index];
      if (position > base) {
        beforeFence = position;
        break;
      }
    }
    return beforeFence === undefined ? [] : [beforeFence];
  }
  return markdownBlockStarts(text.slice(base))
    .slice(1)
    .map((offset) => base + offset);
}

/* Top-level block starts of a CommonMark document, exactly where remark-parse
 * (micromark) places `root.children[i].position.start.offset`. The streaming
 * projection used to run the full main-thread parser over the live tail on
 * every token flush only to read those offsets (~160 ms per stream on a
 * throttled phone). This is the spec's line-oriented block phase (container
 * continuation, block starts, lazy continuation) without inline parsing, and
 * with micromark's deviations: indented code interrupts like a paragraph for
 * list items, an interrupting ordered item must be literally `1`, complete
 * HTML tags (condition 7) start on lazy lines, and link reference
 * definitions split the paragraph they open. */
type ScanBlockKind = 'document' | 'quote' | 'list' | 'item' | 'paragraph' | 'heading' | 'break' | 'code' | 'html';

interface ScanBlock {
  kind: ScanBlockKind;
  parent: ScanBlock | null;
  lastChild: ScanBlock | null;
  open: boolean;
  start: number;
  // list and item
  ordered: boolean;
  marker: string;
  itemIndent: number;
  // code: an empty fence character marks indented code
  fenceChar: string;
  fenceLength: number;
  fenceOffset: number;
  // html: conditions 1-5 end on a marker, 6-7 (null) at a blank line
  htmlEnd: RegExp | null;
  // paragraph opening with `[`: its lines may be link reference definitions
  definitionLines: string[] | null;
  definitionLineStarts: number[];
}

const CODE_INDENT = 4;
const reAtxHeading = /#{1,6}(?:[ \t]+|$)/y;
const reCodeFence = /`{3,}(?!.*`)|~{3,}/y;
const reClosingCodeFence = /(?:`{3,}|~{3,})(?=[ \t]*$)/y;
const reSetextUnderline = /(?:=+|-+)[ \t]*$/y;
const reThematicBreak = /(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/y;
const reOrderedMarker = /(\d{1,9})([.)])/y;
const reNonSpace = /[^ \t]/;
const reLineEnding = /\r\n|\r|\n/g;
const htmlRawNames = new Set(['pre', 'script', 'style', 'textarea']);
const htmlBlockNames = new Set(
  (
    'address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt ' +
    'fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li ' +
    'link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th ' +
    'thead title tr track ul'
  ).split(' ')
);
const htmlRawEnd = /<\/(?:pre|script|style|textarea)>/i;
const htmlCommentEnd = /-->/;
const htmlInstructionEnd = /\?>/;
const htmlDeclarationEnd = />/;
const htmlCdataEnd = /\]\]>/;

function matchAt(pattern: RegExp, line: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index;
  return pattern.exec(line);
}

function isSpaceOrTab(char: string | undefined): boolean {
  return char === ' ' || char === '\t';
}

function isAsciiAlpha(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z]$/.test(char);
}

function isAsciiAlphanumeric(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z0-9]$/.test(char);
}

// micromark's condition 7: one complete open or closing tag, then only
// whitespace to the end of the line.
function isCompleteHtmlTag(line: string, index: number, closing: boolean): boolean {
  let i = index;
  if (closing) {
    while (isSpaceOrTab(line[i])) i += 1;
  } else {
    // `afterName`: after an attribute name or unquoted value, where `=` may follow.
    let afterName = false;
    for (;;) {
      const c = line[i];
      if (afterName) {
        afterName = false;
        if (isSpaceOrTab(c)) {
          i += 1;
          afterName = true;
        } else if (c === '=') {
          i += 1;
          while (isSpaceOrTab(line[i])) i += 1;
          const value = line[i];
          if (value === undefined || value === '<' || value === '=' || value === '>' || value === '`') return false;
          if (value === '"' || value === "'") {
            const close = line.indexOf(value, i + 1);
            if (close < 0) return false;
            i = close + 1;
            const after = line[i];
            if (!(after === '/' || after === '>' || isSpaceOrTab(after))) return false;
          } else {
            while (line[i] !== undefined && !isSpaceOrTab(line[i]) && !'"\'/<=>`'.includes(line[i])) i += 1;
            afterName = true;
          }
        }
        continue;
      }
      if (c === '/') {
        i += 1;
        break;
      }
      if (c === ':' || c === '_' || isAsciiAlpha(c)) {
        i += 1;
        while (line[i] !== undefined && (isAsciiAlphanumeric(line[i]) || '-.:_'.includes(line[i]))) i += 1;
        afterName = true;
      } else if (isSpaceOrTab(c)) {
        i += 1;
      } else {
        break;
      }
    }
  }
  if (line[i] !== '>') return false;
  i += 1;
  while (isSpaceOrTab(line[i])) i += 1;
  return i >= line.length;
}

// Returns the end marker of an HTML (flow) block opening at `line[index]`
// (`basic`/`complete` = conditions 6/7, ending at a blank line), or undefined
// when none opens here.
function htmlBlockStart(line: string, index: number, interrupt: boolean): RegExp | 'basic' | 'complete' | undefined {
  let i = index + 1;
  const c = line[i];
  if (c === '!') {
    if (line.startsWith('--', i + 1)) return htmlCommentEnd;
    if (line.startsWith('[CDATA[', i + 1)) return htmlCdataEnd;
    return isAsciiAlpha(line[i + 1]) ? htmlDeclarationEnd : undefined;
  }
  if (c === '?') return htmlInstructionEnd;
  const closing = c === '/';
  if (closing) i += 1;
  if (!isAsciiAlpha(line[i])) return undefined;
  const nameStart = i;
  while (line[i] === '-' || isAsciiAlphanumeric(line[i])) i += 1;
  const end = line[i];
  if (!(end === undefined || end === '/' || end === '>' || isSpaceOrTab(end))) return undefined;
  const name = line.slice(nameStart, i).toLowerCase();
  if (end !== '/' && !closing && htmlRawNames.has(name)) return htmlRawEnd;
  if (htmlBlockNames.has(name)) return end !== '/' || line[i + 1] === '>' ? 'basic' : undefined;
  if (interrupt) return undefined;
  return isCompleteHtmlTag(line, i, closing) ? 'complete' : undefined;
}

function isAsciiControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code < 32 && code !== 0) || code === 127;
}

function skipWhitespace(text: string, index: number, lineEndings: boolean): number {
  let i = index;
  while (isSpaceOrTab(text[i]) || (lineEndings && text[i] === '\n')) i += 1;
  return i;
}

// micromark's definition construct over paragraph content (lines joined by
// `\n`, each without its leading whitespace). Returns the index after the
// definition's line ending, or -1.
function parseDefinition(content: string, start: number): number {
  let i = start + 1;
  let size = 0;
  let seen = false;
  let inside = false;
  for (;;) {
    const c = content[i];
    if (!inside) {
      if (size > 999 || c === undefined || c === '[' || (c === ']' && !seen)) return -1;
      if (c === ']') {
        i += 1;
        break;
      }
      if (c === '\n') i += 1;
      else inside = true;
      continue;
    }
    if (c === undefined || c === '[' || c === ']' || c === '\n' || size++ > 999) {
      inside = false;
      continue;
    }
    i += 1;
    if (!seen) seen = !isSpaceOrTab(c);
    if (c === '\\' && (content[i] === '[' || content[i] === '\\' || content[i] === ']')) {
      i += 1;
      size += 1;
    }
  }
  if (content[i] !== ':') return -1;
  i = skipWhitespace(content, i + 1, true);
  if (content[i] === '<') {
    i += 1;
    for (;;) {
      const c = content[i];
      if (c === '>') break;
      if (c === undefined || c === '<' || c === '\n') return -1;
      i += 1;
      if (c === '\\' && (content[i] === '<' || content[i] === '>' || content[i] === '\\')) i += 1;
    }
    i += 1;
  } else {
    const first = content[i];
    if (first === undefined || first === ' ' || first === ')' || isAsciiControl(first)) return -1;
    let balance = 0;
    for (;;) {
      const c = content[i];
      if (!balance && (c === undefined || c === ')' || c === ' ' || c === '\t' || c === '\n')) break;
      if (c === '(') balance += 1;
      else if (c === ')') balance -= 1;
      else if (c === undefined || c === ' ' || isAsciiControl(c)) return -1;
      i += 1;
      if (c === '\\' && (content[i] === '(' || content[i] === ')' || content[i] === '\\')) i += 1;
    }
  }
  const lineEnd = (index: number) => {
    const after = skipWhitespace(content, index, false);
    if (after >= content.length) return content.length;
    return content[after] === '\n' ? after + 1 : -1;
  };
  const titleStart = skipWhitespace(content, i, true);
  const marker = content[titleStart];
  if (titleStart > i && (marker === '"' || marker === "'" || marker === '(')) {
    const close = marker === '(' ? ')' : marker;
    let j = titleStart + 1;
    while (j < content.length && content[j] !== close) {
      j += content[j] === '\\' && (content[j + 1] === close || content[j + 1] === '\\') ? 2 : 1;
    }
    if (j < content.length) {
      const end = lineEnd(j + 1);
      if (end >= 0) return end;
    }
  }
  return lineEnd(i);
}

function createScanBlock(kind: ScanBlockKind, parent: ScanBlock | null, start: number): ScanBlock {
  return {
    kind,
    parent,
    lastChild: null,
    open: true,
    start,
    ordered: false,
    marker: '',
    itemIndent: 0,
    fenceChar: '',
    fenceLength: 0,
    fenceOffset: 0,
    htmlEnd: null,
    definitionLines: null,
    definitionLineStarts: [],
  };
}

class MarkdownBlockScanner {
  private readonly document = createScanBlock('document', null, 0);
  private readonly topLevel: ScanBlock[] = [];
  private tip = this.document;
  private oldTip = this.document;
  private lastMatchedContainer = this.document;
  private allClosed = true;
  private line = '';
  private lineStart = 0;
  private lineEnded = false;
  // Not every open container continued and no new container opened.
  private lazyLine = false;
  private closeAtLineEnd: ScanBlock | null = null;
  private offset = 0;
  private column = 0;
  private nextNonspace = 0;
  private nextNonspaceColumn = 0;
  private indent = 0;
  private indented = false;
  private blank = false;
  private partiallyConsumedTab = false;

  scan(text: string): number[] {
    let lineStart = 0;
    reLineEnding.lastIndex = 0;
    this.lineEnded = true;
    for (let ending = reLineEnding.exec(text); ending; ending = reLineEnding.exec(text)) {
      this.processLine(text.slice(lineStart, ending.index), lineStart);
      lineStart = ending.index + ending[0].length;
    }
    this.lineEnded = false;
    this.processLine(text.slice(lineStart), lineStart);
    return this.starts();
  }

  private starts(): number[] {
    const starts: number[] = [];
    for (const block of this.topLevel) {
      const lines = block.definitionLines;
      if (!lines) {
        starts.push(block.start);
        continue;
      }
      const content = lines.join('\n');
      let position = 0;
      let line = 0;
      const advanceTo = (index: number) => {
        while (position < index) {
          const newline = content.indexOf('\n', position);
          if (newline < 0 || newline >= index) break;
          position = newline + 1;
          line += 1;
        }
        position = index;
      };
      while (content[position] === '[') {
        const end = parseDefinition(content, position);
        if (end < 0) break;
        starts.push(block.definitionLineStarts[line]);
        advanceTo(end);
      }
      // A setext heading keeps the start of its whole content, definitions
      // included; a paragraph starts at its first non-definition line.
      if (block.kind === 'heading') starts.push(block.start);
      else if (position < content.length) starts.push(block.definitionLineStarts[line]);
    }
    return starts;
  }

  private findNextNonspace(): void {
    let i = this.offset;
    let columns = this.column;
    let c = this.line[i];
    while (c === ' ' || c === '\t') {
      columns += c === ' ' ? 1 : 4 - (columns % 4);
      i += 1;
      c = this.line[i];
    }
    this.blank = c === undefined;
    this.nextNonspace = i;
    this.nextNonspaceColumn = columns;
    this.indent = columns - this.column;
    this.indented = this.indent >= CODE_INDENT;
  }

  private advanceNextNonspace(): void {
    this.offset = this.nextNonspace;
    this.column = this.nextNonspaceColumn;
    this.partiallyConsumedTab = false;
  }

  private advanceOffset(count: number, columns: boolean): void {
    let remaining = count;
    let c = this.line[this.offset];
    while (remaining > 0 && c !== undefined) {
      if (c === '\t') {
        const toTab = 4 - (this.column % 4);
        if (columns) {
          this.partiallyConsumedTab = toTab > remaining;
          const advance = toTab > remaining ? remaining : toTab;
          this.column += advance;
          this.offset += this.partiallyConsumedTab ? 0 : 1;
          remaining -= advance;
        } else {
          this.partiallyConsumedTab = false;
          this.column += toTab;
          this.offset += 1;
          remaining -= 1;
        }
      } else {
        this.partiallyConsumedTab = false;
        this.offset += 1;
        this.column += 1;
        remaining -= 1;
      }
      c = this.line[this.offset];
    }
  }

  private finalize(block: ScanBlock): void {
    block.open = false;
    this.tip = block.parent ?? this.document;
  }

  private closeUnmatchedBlocks(): void {
    if (this.allClosed) return;
    while (this.oldTip !== this.lastMatchedContainer) {
      const parent = this.oldTip.parent ?? this.document;
      this.finalize(this.oldTip);
      this.oldTip = parent;
    }
    this.allClosed = true;
  }

  private addChild(kind: ScanBlockKind, lineOffset: number): ScanBlock {
    for (;;) {
      const parent = this.tip.kind;
      const fits =
        parent === 'list' ? kind === 'item' : (parent === 'document' || parent === 'quote' || parent === 'item') && kind !== 'item';
      if (fits) break;
      this.finalize(this.tip);
    }
    const block = createScanBlock(kind, this.tip, this.lineStart + lineOffset);
    this.tip.lastChild = block;
    if (this.tip === this.document) this.topLevel.push(block);
    this.tip = block;
    return block;
  }

  private addParagraphLine(paragraph: ScanBlock): void {
    const lines = paragraph.definitionLines;
    if (!lines) return;
    let i = this.offset;
    while (isSpaceOrTab(this.line[i])) i += 1;
    lines.push(this.line.slice(i));
    paragraph.definitionLineStarts.push(this.lineStart + i);
  }

  // 0 = matched, 1 = not matched, 2 = the line is fully consumed.
  private continueBlock(block: ScanBlock): 0 | 1 | 2 {
    const line = this.line;
    switch (block.kind) {
      case 'quote':
        if (this.indented || line[this.nextNonspace] !== '>') return 1;
        this.advanceNextNonspace();
        this.advanceOffset(1, false);
        if (isSpaceOrTab(line[this.offset])) this.advanceOffset(1, true);
        return 0;
      case 'item':
        if (this.blank) {
          if (!block.lastChild) return 1;
          this.advanceNextNonspace();
        } else if (this.indent >= block.itemIndent) {
          this.advanceOffset(block.itemIndent, true);
        } else {
          return 1;
        }
        return 0;
      case 'code':
        if (block.fenceChar) {
          const closing =
            this.indent <= 3 && line[this.nextNonspace] === block.fenceChar
              ? matchAt(reClosingCodeFence, line, this.nextNonspace)
              : null;
          if (closing && closing[0].length >= block.fenceLength) {
            this.finalize(block);
            return 2;
          }
          for (let i = block.fenceOffset; i > 0 && isSpaceOrTab(line[this.offset]); i -= 1) {
            this.advanceOffset(1, true);
          }
          return 0;
        }
        if (this.indent >= CODE_INDENT) this.advanceOffset(CODE_INDENT, true);
        else if (this.blank) this.advanceNextNonspace();
        else return 1;
        return 0;
      case 'html':
        return this.blank && block.htmlEnd === null ? 1 : 0;
      case 'paragraph':
        return this.blank ? 1 : 0;
      case 'heading':
      case 'break':
        return 1;
      default:
        return 0;
    }
  }

  private parseListMarker(interrupt: boolean): { ordered: boolean; marker: string; itemIndent: number } | null {
    const line = this.line;
    const start = this.nextNonspace;
    if (this.indent >= CODE_INDENT) return null;
    let ordered = false;
    let marker = line[start];
    let markerLength = 1;
    if (marker !== '*' && marker !== '+' && marker !== '-') {
      const match = matchAt(reOrderedMarker, line, start);
      if (!match || (interrupt && match[1] !== '1')) return null;
      ordered = true;
      marker = match[2];
      markerLength = match[0].length;
    }
    const next = line[start + markerLength];
    if (next !== undefined && !isSpaceOrTab(next)) return null;
    if (interrupt && !reNonSpace.test(line.slice(start + markerLength))) return null;
    const markerOffset = this.indent;
    this.advanceNextNonspace();
    this.advanceOffset(markerLength, true);
    const spacesStartColumn = this.column;
    const spacesStartOffset = this.offset;
    do {
      this.advanceOffset(1, true);
    } while (this.column - spacesStartColumn < 5 && isSpaceOrTab(line[this.offset]));
    const blankItem = line[this.offset] === undefined;
    const spacesAfterMarker = this.column - spacesStartColumn;
    let padding = markerLength + spacesAfterMarker;
    if (spacesAfterMarker >= 5 || spacesAfterMarker < 1 || blankItem) {
      padding = markerLength + 1;
      this.column = spacesStartColumn;
      this.offset = spacesStartOffset;
      if (isSpaceOrTab(line[this.offset])) this.advanceOffset(1, true);
    }
    return { ordered, marker, itemIndent: markerOffset + padding };
  }

  // 0 = no start, 1 = a container opened, 2 = a leaf opened.
  private blockStart(container: ScanBlock, interrupt: boolean): 0 | 1 | 2 {
    const line = this.line;
    const start = this.nextNonspace;
    const c = line[start];
    if (!this.indented) {
      if (c === '>') {
        this.advanceNextNonspace();
        this.advanceOffset(1, false);
        if (isSpaceOrTab(line[this.offset])) this.advanceOffset(1, true);
        this.closeUnmatchedBlocks();
        this.addChild('quote', start);
        this.lazyLine = false;
        return 1;
      }
      if (c === '#' && matchAt(reAtxHeading, line, start)) {
        this.closeUnmatchedBlocks();
        this.addChild('heading', start);
        this.offset = line.length;
        return 2;
      }
      const fence = c === '`' || c === '~' ? matchAt(reCodeFence, line, start) : null;
      if (fence) {
        this.closeUnmatchedBlocks();
        const code = this.addChild('code', start);
        code.fenceChar = c;
        code.fenceLength = fence[0].length;
        code.fenceOffset = this.indent;
        this.advanceNextNonspace();
        this.advanceOffset(fence[0].length, false);
        return 2;
      }
      if (c === '<') {
        const end = htmlBlockStart(line, start, container.kind === 'paragraph');
        if (end !== undefined) {
          // micromark quirk: a complete tag on a lazy line that is followed by
          // a line ending stays inside the containers the paragraph was in.
          if (end === 'complete' && this.lineEnded && !this.allClosed && this.tip.kind === 'paragraph') {
            this.lastMatchedContainer = this.tip.parent ?? this.document;
          }
          this.closeUnmatchedBlocks();
          this.addChild('html', this.offset).htmlEnd = typeof end === 'string' ? null : end;
          return 2;
        }
      }
      if (container.kind === 'paragraph' && (c === '=' || c === '-') && matchAt(reSetextUnderline, line, start)) {
        this.closeUnmatchedBlocks();
        if (this.paragraphHasText(container)) {
          container.kind = 'heading';
          this.offset = line.length;
          return 2;
        }
        // micromark ends definitions-only content before the underline, which
        // then opens new content unless it is a thematic break.
        this.finalize(container);
        if (!matchAt(reThematicBreak, line, start)) {
          this.addChild('paragraph', start);
          return 2;
        }
      }
      if ((c === '*' || c === '_' || c === '-') && matchAt(reThematicBreak, line, start)) {
        this.closeUnmatchedBlocks();
        this.addChild('break', start);
        this.offset = line.length;
        return 2;
      }
    }
    if (!this.indented || container.kind === 'list') {
      const item = this.parseListMarker(interrupt);
      if (item) {
        this.closeUnmatchedBlocks();
        const tip = this.tip;
        if (tip.kind !== 'list' || tip.ordered !== item.ordered || tip.marker !== item.marker) {
          const list = this.addChild('list', start);
          list.ordered = item.ordered;
          list.marker = item.marker;
        }
        this.addChild('item', start).itemIndent = item.itemIndent;
        this.lazyLine = false;
        return 1;
      }
    }
    if (this.indented && this.tip.kind !== 'paragraph' && !this.blank) {
      const lineOffset = this.offset;
      this.advanceOffset(CODE_INDENT, true);
      this.closeUnmatchedBlocks();
      const code = this.addChild('code', lineOffset);
      // micromark ends indented code after a lazy line, so one opened on a
      // lazy line is a single line long.
      if (this.lazyLine) this.closeAtLineEnd = code;
      return 2;
    }
    return 0;
  }

  private paragraphHasText(paragraph: ScanBlock): boolean {
    const lines = paragraph.definitionLines;
    if (!lines) return true;
    const content = lines.join('\n');
    let position = 0;
    while (content[position] === '[') {
      const end = parseDefinition(content, position);
      if (end < 0) break;
      position = end;
    }
    return position < content.length;
  }

  private processLine(line: string, lineStart: number): void {
    this.line = line;
    this.lineStart = lineStart;
    this.offset = 0;
    this.column = 0;
    this.blank = false;
    this.partiallyConsumedTab = false;
    this.oldTip = this.tip;
    let container = this.document;
    let containersMatched = true;
    for (let child = container.lastChild; child?.open; child = container.lastChild) {
      container = child;
      this.findNextNonspace();
      const result = this.continueBlock(container);
      if (result === 2) return;
      // An item closed by a blank line after its empty start leaves the list
      // open, but micromark's list container no longer continues.
      if (container.kind === 'list' && !container.lastChild?.open) containersMatched = false;
      if (result === 1) {
        if (container.kind === 'quote' || container.kind === 'item') containersMatched = false;
        container = container.parent ?? this.document;
        break;
      }
    }
    this.allClosed = container === this.oldTip;
    this.lastMatchedContainer = container;
    this.lazyLine = !containersMatched;
    // micromark lets an open paragraph or indented code block resist list
    // items (non-`1` ordered, empty) only while every container continued.
    const flowOpen = this.oldTip.kind === 'paragraph' || (this.oldTip.kind === 'code' && !this.oldTip.fenceChar);
    const interrupt = containersMatched && flowOpen;
    let matchedLeaf = container.kind === 'code' || container.kind === 'html';
    while (!matchedLeaf) {
      this.findNextNonspace();
      const result = this.blockStart(container, interrupt);
      if (result === 0) {
        this.advanceNextNonspace();
        break;
      }
      container = this.tip;
      matchedLeaf = result === 2;
    }
    if (this.closeAtLineEnd) {
      this.finalize(this.closeAtLineEnd);
      this.closeAtLineEnd = null;
      return;
    }
    if (!this.allClosed && !this.blank && this.tip.kind === 'paragraph') {
      this.addParagraphLine(this.tip);
      return;
    }
    this.closeUnmatchedBlocks();
    if (container.kind === 'paragraph') {
      this.addParagraphLine(container);
    } else if (container.kind === 'html') {
      if (container.htmlEnd?.test(line.slice(this.offset))) this.finalize(container);
    } else if (container.kind !== 'code' && this.offset < line.length && !this.blank) {
      const paragraph = this.addChild('paragraph', this.nextNonspace);
      if (line[this.nextNonspace] === '[') paragraph.definitionLines = [];
      this.advanceNextNonspace();
      this.addParagraphLine(paragraph);
    }
  }
}

export function markdownBlockStarts(text: string): number[] {
  return new MarkdownBlockScanner().scan(String(text ?? ''));
}

export function resolveStreamingMarkdownChunks(
  text: string,
  streaming: boolean,
  cache: StreamingMarkdownCache
): StreamingMarkdownParts {
  const value = String(text ?? '');
  if (!continuesStreamingText(cache.sourceText, value)) resetCache(cache);
  if (!streaming) {
    // Keep already-parsed blocks mounted when the stream settles. Resetting
    // here used to make the final token reparse the complete response in one
    // renderer task, even though most blocks had already been frozen.
    if (cache.stableText && value.startsWith(cache.stableText)) {
      cache.sourceText = value;
      return {
        stableChunks: cache.stableChunks,
        stableChunkKeys: cache.stableChunkKeys,
        unstableText: value.slice(cache.stableText.length),
        unstableKey: markdownChunkKey(cache.stableText.length),
        parseUnstable: true,
      };
    }
    resetCache(cache);
    cache.sourceText = value;
    return {
      stableChunks: [],
      stableChunkKeys: [],
      unstableText: value,
      unstableKey: markdownChunkKey(0),
      parseUnstable: true,
    };
  }

  const stableBoundaries = stableMarkdownBoundaries(value, cache);
  for (const boundary of stableBoundaries) {
    if (boundary <= cache.stableText.length || boundary > value.length) continue;
    const chunk = value.slice(cache.stableText.length, boundary);
    if (!chunk) continue;
    const chunkKey = markdownChunkKey(cache.stableText.length);
    cache.stableText += chunk;
    cache.stableChunks = [...cache.stableChunks, chunk];
    cache.stableChunkKeys = [...cache.stableChunkKeys, chunkKey];
  }
  cache.boundaries = cache.boundaries.filter((position) => position > cache.stableText.length);

  cache.sourceText = value;
  const unstableText = value.slice(cache.stableText.length);
  return {
    stableChunks: cache.stableChunks,
    stableChunkKeys: cache.stableChunkKeys,
    unstableText,
    unstableKey: markdownChunkKey(cache.stableText.length),
    // An open fence, table, list, or very long paragraph may have no safe
    // boundary for many kilobytes. Re-running the full GFM parser for that
    // growing tail every 80ms blocks Chromium's renderer thread. Preserve the
    // live text as plain DOM until settlement instead; completed older blocks
    // remain parsed and memoized above.
    parseUnstable: unstableText.length <= MAX_STREAMING_UNSTABLE_MARKDOWN_CHARS,
  };
}
