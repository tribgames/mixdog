// Thumbnail art drawn from a file's own content, shared by the transcript's
// document cards and the attachment cards (design/link-surfaces.html): the
// drawn document sheet used before (or instead of) a rendered first page, the
// code and prose minimaps, and the table thumbnail of a CSV/TSV. Colours come
// from CSS (`.file-*` in desktop/13-tool-cards.css), so both themes apply.
import type { CSSProperties } from 'react';
import { parseDelimited } from './editor-delimited';

/** Colour family of a file type: its sheet band and its small type word. */
export type FileTone = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'code' | 'txt' | 'file';

const TONE_EXTENSIONS: [FileTone, RegExp][] = [
  ['pdf', /^pdf$/],
  ['docx', /^(?:docx?|docm|dotx|odt|rtf)$/],
  ['xlsx', /^(?:xlsx?|xlsm|ods|csv|tsv)$/],
  ['pptx', /^(?:pptx?|pptm|odp)$/],
  ['txt', /^(?:md|markdown|mdx|txt|text|rst|log|adoc)$/],
];

/** Lower-case extension of a file name, or ''. */
export function fileExtension(name: string): string {
  return /\.([a-z0-9]{1,8})$/i.exec(name.trim())?.[1]?.toLowerCase() || '';
}

/** Tone of a file name; text-like names that are not prose read as code. */
export function fileTone(name: string, textual = false): FileTone {
  const extension = fileExtension(name);
  for (const [tone, pattern] of TONE_EXTENSIONS) if (pattern.test(extension)) return tone;
  return textual ? 'code' : 'file';
}

/** The small coloured type word ("PDF", "XLSX"). */
export function FileTypeWord({ tone, label }: { tone: FileTone; label: string }) {
  return <span className={`file-type-word file-tone-${tone}`}>{label}</span>;
}

/** Drawn document sheet: folded corner, body lines and a 3px type-coloured
 *  band at the bottom. Decorative; the card around it names the file. */
export function DocSheet({ tone, className = '' }: { tone: FileTone; className?: string }) {
  return (
    <svg
      className={`file-sheet file-tone-${tone}${className ? ` ${className}` : ''}`}
      viewBox="0 0 44 56"
      width="44"
      height="56"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="file-sheet-paper"
        d="M9 4.5h18.5L36 13v36.5a2.5 2.5 0 0 1-2.5 2.5h-24A2.5 2.5 0 0 1 7 49.5V7a2.5 2.5 0 0 1 2-2.5Z"
      />
      <path className="file-sheet-fold" d="M27.5 4.5V11a2 2 0 0 0 2 2H36" />
      <rect className="file-sheet-line lead" x="12" y="19" width="16" height="2" rx="1" />
      <rect className="file-sheet-line" x="12" y="24" width="20" height="2" rx="1" />
      <rect className="file-sheet-line" x="12" y="29" width="18" height="2" rx="1" />
      <rect className="file-sheet-line" x="12" y="34" width="13" height="2" rx="1" />
      <rect className="file-sheet-band" x="7.6" y="46" width="27.8" height="3" />
    </svg>
  );
}

// ── Code minimap ────────────────────────────────────────────────────────────

export type CodeStrokeKind = 'space' | 'string' | 'number' | 'comment' | 'keyword' | 'ident' | 'punct';
export interface CodeStroke {
  kind: CodeStrokeKind;
  /** Width in characters. */
  width: number;
}

const MINIMAP_LINES = 14;
const MINIMAP_COLUMNS = 80;
const KEYWORDS = new Set(
  (
    'import from export async function const let var await if else return for of in while do default class new ' +
    'extends implements interface type enum def fn pub use mod struct impl trait match func package go defer ' +
    'try catch finally throw raise switch case break continue static public private protected yield lambda ' +
    'with as elif except pass and or not is None True False null true false undefined this self'
  ).split(' ')
);
const TOKEN = /(\s+)|('[^']*'|`[^`]*`|"[^"]*")|(\d[\d_.]*)|(\/\/.*|#(?![\w[]).*|--\s.*)|([A-Za-z_$][\w$]*)|([^\s\w])/g;

function codeTokens(line: string): CodeStroke[] {
  const out: CodeStroke[] = [];
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(line); match; match = TOKEN.exec(line)) {
    if (match[1]) out.push({ kind: 'space', width: match[1].length });
    else if (match[2]) out.push({ kind: 'string', width: match[2].length });
    else if (match[3]) out.push({ kind: 'number', width: match[3].length });
    else if (match[4]) out.push({ kind: 'comment', width: match[4].length });
    else if (match[5]) out.push({ kind: KEYWORDS.has(match[5]) ? 'keyword' : 'ident', width: match[5].length });
    else out.push({ kind: 'punct', width: 1 });
  }
  return out;
}

/** Strokes of one code line: punctuation joins its neighbour and adjacent
 *  same-kind runs merge into one bar, so a line reads as a few clean strokes
 *  instead of a row of dots. Indentation stays as a leading gap. */
export function codeStrokes(line: string): CodeStroke[] {
  const merged: CodeStroke[] = [];
  for (const token of codeTokens(line.replace(/\s+$/, ''))) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.kind !== 'space' &&
      token.kind !== 'space' &&
      (token.kind === 'punct' || previous.kind === token.kind)
    ) {
      previous.width += token.width;
      continue;
    }
    merged.push({ ...token });
  }
  return merged;
}

/** First lines of a text, tabs as four columns, each cut to the minimap width. */
function firstLines(text: string, count = MINIMAP_LINES): string[] {
  return text
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .split(/\r?\n/, count)
    .map((line) => line.replace(/\t/g, '    ').slice(0, MINIMAP_COLUMNS));
}

/** Code minimap rows: the first 14 lines as token-coloured strokes. */
export function codeMinimapLines(text: string): CodeStroke[][] {
  return firstLines(text).map(codeStrokes);
}

// ── Prose minimap ───────────────────────────────────────────────────────────

export interface TextRow {
  kind: 'heading' | 'line' | 'gap';
  /** Width in minimap units (2px each on the desktop card). */
  width: number;
}

const PROSE_WRAP = 40;
const PROSE_UNITS = 34;

/** Prose minimap rows: headings, paragraph lines wrapped to the page width,
 *  and blank-line gaps, capped at the minimap height. */
export function textMinimapLines(text: string): TextRow[] {
  const rows: TextRow[] = [];
  for (const raw of text.replace(/^(?:[ \t]*\r?\n)+/, '').split(/\r?\n/)) {
    if (rows.length >= MINIMAP_LINES) break;
    const line = raw.trim();
    if (!line) {
      if (rows.length && rows.at(-1)!.kind !== 'gap') rows.push({ kind: 'gap', width: 0 });
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      rows.push({ kind: 'heading', width: Math.min(22, Math.max(6, Math.round(heading[1].length * 0.8))) });
      continue;
    }
    const body = line.replace(/^(?:[-*+]|\d+[.)])\s+/, '').replace(/^>\s?/, '');
    for (let start = 0; start < body.length && rows.length < MINIMAP_LINES; start += PROSE_WRAP) {
      const length = Math.min(PROSE_WRAP, body.length - start);
      rows.push({ kind: 'line', width: Math.max(4, Math.round((length * PROSE_UNITS) / PROSE_WRAP)) });
    }
  }
  while (rows.at(-1)?.kind === 'gap') rows.pop();
  return rows;
}

const CODE_LINE =
  /(?:[;{}]\s*$|^\s*[})\]]|=>|[!=]==?|::|\(\)|^\s*(?:import|export|const|let|var|function|def|class|return|if\s*\(|for\s*\(|while\s*\(|#include|package|public|private|fn|func|SELECT|FROM)\b|^\s*(?:\/\/|\/\*|\*\s))/;

/** Whether a pasted or unnamed text reads as source code rather than prose. */
export function looksLikeCode(text: string): boolean {
  const lines = text
    .split(/\r?\n/, 40)
    .map((line) => line.replace(/\s+$/, ''))
    .filter(Boolean);
  if (!lines.length) return false;
  const code = lines.filter((line) => CODE_LINE.test(line)).length;
  const indented = lines.filter((line) => /^(?: {2,}|\t)\S/.test(line) && !/^\s*[-*+]\s/.test(line)).length;
  return (code + indented / 2) / lines.length >= 0.3;
}

const charWidth = (width: number): CSSProperties => ({
  width: `max(2px, calc(var(--file-mini-char, 1.2px) * ${width}))`,
});
const unitWidth = (width: number): CSSProperties => ({ width: `calc(var(--file-mini-unit, 2px) * ${width})` });

function CodeMinimap({ text }: { text: string }) {
  return (
    <span className="file-minimap" aria-hidden="true">
      {codeMinimapLines(text).map((strokes, row) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder.
        <span key={row} className="file-minimap-line">
          {strokes.map((stroke, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: strokes are positional and never reorder.
            <b key={index} className={stroke.kind} style={charWidth(stroke.width)} />
          ))}
        </span>
      ))}
    </span>
  );
}

function TextMinimap({ text }: { text: string }) {
  return (
    <span className="file-minimap paper" aria-hidden="true">
      {textMinimapLines(text).map((row, index) =>
        row.kind === 'gap' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder.
          <span key={index} className="file-minimap-gap" />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder.
          <span key={index} className={`file-minimap-line${row.kind === 'heading' ? ' heading' : ''}`}>
            <b style={unitWidth(row.width)} />
          </span>
        )
      )}
    </span>
  );
}

/** Minimap of a text: code strokes, or paper lines for prose. */
export function ContentMinimap({ text, prose }: { text: string; prose: boolean }) {
  return prose ? <TextMinimap text={text} /> : <CodeMinimap text={text} />;
}

// ── Table thumbnail ─────────────────────────────────────────────────────────

const TABLE_ROWS = 9;
const TABLE_COLUMNS = 5;

export interface DelimitedSummary {
  /** First records, each cut to the thumbnail's columns. */
  rows: string[][];
  /** Data records below the header. */
  rowCount: number;
  columnCount: number;
}

/** First records and the size of a CSV/TSV, read from its already-read text
 *  with the RFC 4180 parser (quoted fields may hold delimiters and newlines);
 *  blank records are skipped. */
export function delimitedSummary(text: string, delimiter: string): DelimitedSummary {
  const records = parseDelimited(text, delimiter, Infinity, Infinity, Infinity).rows.filter(
    (fields) => fields.length > 1 || fields[0].trim()
  );
  const head = records.slice(0, TABLE_ROWS);
  return {
    rows: head.map((fields) => fields.slice(0, TABLE_COLUMNS)),
    rowCount: Math.max(0, records.length - 1),
    columnCount: head.reduce((most, fields) => Math.max(most, fields.length), 0),
  };
}

/** Spreadsheet-like thumbnail: header row, first column, and a bar per cell
 *  as long as its text. */
export function TableThumbnail({ rows }: { rows: string[][] }) {
  const columns = Math.max(1, ...rows.map((row) => row.length));
  return (
    <span
      className="file-table"
      aria-hidden="true"
      style={{ gridTemplateColumns: `22fr${' 26fr'.repeat(columns - 1)}` }}
    >
      {rows.flatMap((row, rowIndex) =>
        Array.from({ length: columns }, (_, column) => {
          const value = String(row[column] ?? '').trim();
          const kind = rowIndex === 0 ? ' head' : column === 0 ? ' lead' : '';
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional and never reorder.
            <b key={`${rowIndex}-${column}`} className={`file-table-cell${kind}`}>
              {value && <i style={{ width: `${Math.min(80, 12 + value.length * 7)}%` }} />}
            </b>
          );
        })
      )}
    </span>
  );
}
