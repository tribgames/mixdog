import { ArrowUpRight, ChevronDown, ChevronRight, ChevronsUpDown } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import type { DiffStyle } from './desktop-types';
import { t } from './i18n';
import { parseUnifiedDiff } from './renderer-logic.mjs';
import { GitFileDiff } from './ReviewPane';
import { fileBaseName } from './text-format';

export type DiffLineKind = 'ctx' | 'add' | 'del';
export type DiffLine = { kind: DiffLineKind; oldNo: number; newNo: number; text: string };
export type DiffItem =
  | { type: 'line'; key: string; line: DiffLine }
  | { type: 'fold'; key: string; lines: DiffLine[] }
  /** Unmodified lines that are not part of the patch (between hunks). */
  | { type: 'gap'; key: string; count: number };

/** Context lines kept on each side of a change before a run folds. */
export const DIFF_FOLD_KEEP = 2;
/** A run folds only when it hides at least this many lines. */
const DIFF_FOLD_MIN_HIDDEN = 2;

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

type ParsedHunk = { lines: DiffLine[]; newStart: number; newCount: number };

export function parseHunk(hunk: string): ParsedHunk {
  const rows = hunk.split('\n');
  const header = HUNK_HEADER.exec(rows[0] || '');
  let oldNo = header ? Number(header[1]) : 1;
  let newNo = header ? Number(header[2]) : 1;
  const newStart = newNo;
  const body = rows.slice(header ? 1 : 0);
  if (body.at(-1) === '') body.pop();
  const lines: DiffLine[] = [];
  for (const row of body) {
    const mark = row[0];
    const text = row.slice(1);
    if (mark === '+') lines.push({ kind: 'add', oldNo: 0, newNo: newNo++, text });
    else if (mark === '-') lines.push({ kind: 'del', oldNo: oldNo++, newNo: 0, text });
    else if (mark === '\\') continue;
    else lines.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text });
  }
  return { lines, newStart, newCount: lines.filter((line) => line.kind !== 'del').length };
}

/** The hunks (`@@ … @@` blocks) of every file section in a unified patch. */
export function patchHunks(patch: string): string[] {
  try {
    return parseUnifiedDiff(patch).flatMap((part: { hunks: string[] }) => part.hunks);
  } catch {
    return [];
  }
}

/** Hunks → display items: one number column (new-file numbers; old numbers
 *  for deleted lines), long unchanged runs folded, gaps between hunks named. */
export function buildDiffItems(hunks: readonly string[]): DiffItem[] {
  const items: DiffItem[] = [];
  let nextNew = 1;
  hunks.forEach((hunk, hunkIndex) => {
    const parsed = parseHunk(hunk);
    const gap = parsed.newStart - nextNew;
    if (gap > 0) items.push({ type: 'gap', key: `${hunkIndex}:gap`, count: gap });
    nextNew = parsed.newStart + parsed.newCount;
    const { lines } = parsed;
    let index = 0;
    while (index < lines.length) {
      if (lines[index].kind !== 'ctx') {
        items.push({ type: 'line', key: `${hunkIndex}:${index}`, line: lines[index] });
        index += 1;
        continue;
      }
      let end = index;
      while (end < lines.length && lines[end].kind === 'ctx') end += 1;
      const head = index === 0 ? 0 : DIFF_FOLD_KEEP;
      const tail = end === lines.length ? 0 : DIFF_FOLD_KEEP;
      const hidden = end - index - head - tail;
      if (hidden >= DIFF_FOLD_MIN_HIDDEN) {
        for (let i = index; i < index + head; i += 1) {
          items.push({ type: 'line', key: `${hunkIndex}:${i}`, line: lines[i] });
        }
        items.push({
          type: 'fold',
          key: `${hunkIndex}:${index + head}`,
          lines: lines.slice(index + head, end - tail),
        });
        for (let i = end - tail; i < end; i += 1) {
          items.push({ type: 'line', key: `${hunkIndex}:${i}`, line: lines[i] });
        }
      } else {
        for (let i = index; i < end; i += 1) {
          items.push({ type: 'line', key: `${hunkIndex}:${i}`, line: lines[i] });
        }
      }
      index = end;
    }
  });
  return items;
}

export function hunkStats(hunks: readonly string[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of parseHunk(hunk).lines) {
      if (line.kind === 'add') additions += 1;
      else if (line.kind === 'del') deletions += 1;
    }
  }
  return { additions, deletions };
}

export function unmodifiedLabel(count: number): string {
  return count === 1 ? t('1 unmodified line') : t('{{count}} unmodified lines', { count });
}

function DiffRow({ line }: { line: DiffLine }) {
  const number = line.kind === 'del' ? line.oldNo : line.newNo;
  let marker = '';
  if (line.kind === 'add') marker = '+';
  else if (line.kind === 'del') marker = '\u2212';
  return (
    <div className="inline-diff-row" data-kind={line.kind}>
      <span className="inline-diff-ln">{number}</span>
      <span className="inline-diff-mk">{marker}</span>
      <span className="inline-diff-code">{line.text}</span>
    </div>
  );
}

/** Unified diff of one file's hunks, in one line-number column. */
export function InlineDiff({ hunks }: { hunks: readonly string[] }) {
  const items = useMemo(() => buildDiffItems(hunks), [hunks]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <div className="inline-diff" data-mode="unified">
      {items.map((item) => {
        if (item.type === 'line') return <DiffRow key={item.key} line={item.line} />;
        if (item.type === 'gap') {
          return (
            <div key={item.key} className="inline-diff-fold" data-static="true">
              {unmodifiedLabel(item.count)}
            </div>
          );
        }
        if (expanded.has(item.key)) {
          return item.lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines of one unchanged fold are fixed in order; the position is the identity.
            <DiffRow key={`${item.key}:${index}`} line={line} />
          ));
        }
        return (
          <button
            key={item.key}
            type="button"
            className="inline-diff-fold"
            onClick={() => setExpanded((current) => new Set(current).add(item.key))}
          >
            <ChevronsUpDown size={13} aria-hidden="true" />
            {unmodifiedLabel(item.lines.length)}
          </button>
        );
      })}
    </div>
  );
}

/** A file's diff in the chosen mode: unified is the inline renderer, split
 *  stays on the side-by-side view. */
export function FileDiffBody({
  patch,
  mode,
  hideHunkHeader,
}: {
  patch: string;
  mode: DiffStyle;
  hideHunkHeader?: boolean;
}) {
  const hunks = useMemo(() => patchHunks(patch), [patch]);
  if (mode === 'split') return <GitFileDiff patch={patch} mode="split" hideHunkHeader={hideHunkHeader} />;
  if (hunks.length === 0) return <p className="inline-diff-empty">{t('No textual differences.')}</p>;
  return <InlineDiff hunks={hunks} />;
}

/** One changed file: chevron, bold name, dim directory, +N −M. Expanding it
 *  shows `children` (its diff) below the row. */
export function ChangeFileRow({
  path,
  additions,
  deletions,
  open,
  onToggle,
  onOpenFile,
  children,
}: {
  path: string;
  additions: number;
  deletions: number;
  open: boolean;
  onToggle(): void;
  onOpenFile?(): void;
  children?: ReactNode;
}) {
  const slash = path.lastIndexOf('/');
  const directory = slash >= 0 ? path.slice(0, slash) : '';
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className="changes-file" data-open={open || undefined}>
      <div className="changes-file-row">
        <button type="button" className="changes-file-main" title={path} aria-expanded={open} onClick={onToggle}>
          <Chevron size={13} aria-hidden="true" />
          <b>{fileBaseName(path)}</b>
          {directory && <span className="changes-file-dir">{directory}</span>}
          <span className="changes-file-stats">
            <i>+{additions}</i>
            <em>
              {'\u2212'}
              {deletions}
            </em>
          </span>
        </button>
        {open && onOpenFile && (
          <button
            type="button"
            className="changes-file-open"
            aria-label={t('Open file {{file}}', { file: path })}
            data-tooltip={t('Open file {{file}}', { file: path })}
            onClick={onOpenFile}
          >
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {open && <div className="changes-file-body">{children}</div>}
    </li>
  );
}
