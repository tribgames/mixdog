import { ArrowUpRight, ChevronDown, Undo2 } from 'lucide-react';
import {
  type FocusEvent,
  type KeyboardEvent,
  memo,
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { DiffViewState } from './diff-header-controls';
import { t } from './i18n';
import { FileDiffBody } from './inline-diff';
import { sessionDiffRowPlainText, sessionDiffRowTooLarge, type SessionDiffRow } from './session-diff-model';
import { rowListIndex } from './session-diff-row-index';
import { SetiFileIcon } from './SetiFileIcon';
import { type RowExtent, rowWindowLayout, useRowWindow, windowedRows } from './source-control-support';
import { fileBaseName } from './text-format';
import { toolActivityCodeLanguage } from './transcript-tool-format';
import { middleTruncatedDirectory } from './turn-changes-model';

/** Added/removed counts; a zero half is left out, as in the turn card. */
export function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="diff-stats">
      {additions > 0 && <i>+{additions}</i>}
      {deletions > 0 && (
        <em>
          {'\u2212'}
          {deletions}
        </em>
      )}
    </span>
  );
}

/** A file's diff under its header: nothing while folded, a note when no diff
 *  was recorded, Codex's "too large" note with Open in editor past the
 *  per-file limits, otherwise the diff itself (plain text past 2,000 changed
 *  lines). A plain render helper (not a component), so the section's element
 *  tree stays as it was. */
function sectionBody(
  row: SessionDiffRow,
  mode: DiffViewState['viewMode'],
  collapsed: boolean,
  whole: boolean,
  onOpenFile: (() => void) | undefined
) {
  if (collapsed) return null;
  if (row.reason) return <p className="inline-diff-empty mx-empty-state">{t('No diff was recorded for this file.')}</p>;
  if (sessionDiffRowTooLarge(row)) {
    return (
      <p className="inline-diff-empty session-diff-too-large mx-empty-state">
        {/* One line: the action reads as an inline link after the note. */}
        <span>
          {t('This file is too large to display here.')}
          {onOpenFile && (
            <>
              {' · '}
              <button
                type="button"
                className="session-diff-open-in-editor"
                disabled={row.status === 'D'}
                onClick={onOpenFile}
              >
                {t('Open in editor')}
              </button>
            </>
          )}
        </span>
      </p>
    );
  }
  if (row.patchPending) return <p className="inline-diff-empty mx-empty-state">{t('Loading diff…')}</p>;
  const failedText = t('Could not load this diff. Refresh to try again.');
  // With nothing readable the failure stands in for the diff.
  if (row.patchFailed && row.parts.length === 0) {
    return <p className="inline-diff-empty mx-empty-state">{failedText}</p>;
  }
  // A newer read that failed keeps the last text readable, with the failure beside it.
  const failed = row.patchFailed ? <p className="inline-diff-empty">{failedText}</p> : null;
  return (
    <>
      {failed}
      <FileDiffBody
        patch={row.parts.map((part) => part.patch).join('\n')}
        mode={mode}
        language={sessionDiffRowPlainText(row) ? '' : toolActivityCodeLanguage(row.path)}
        whole={whole}
      />
    </>
  );
}

/** The file header's and one diff line's height in the dock (27-search-review.css). */
const SECTION_HEAD_PX = 34;
const DIFF_LINE_PX = 19;

/** An unfolded section's height before it first renders: its header plus one
 *  line per patch line (wrapping only adds). */
export function sessionDiffSectionEstimate(row: SessionDiffRow): number {
  let lines = 0;
  for (const part of row.parts) {
    for (let at = part.patch.indexOf('\n'); at !== -1; at = part.patch.indexOf('\n', at + 1)) lines += 1;
    if (part.patch) lines += 1;
  }
  return SECTION_HEAD_PX + Math.max(1, lines) * DIFF_LINE_PX;
}

const openEstimates = new WeakMap<SessionDiffRow, number>();
/** A listed row's unfolded height before it is measured, once per row object:
 *  its patch lines, else (patch not read yet) one line per changed line, and
 *  one line for a note in place of a diff. */
function openSectionEstimate(row: SessionDiffRow): number {
  let estimate = openEstimates.get(row);
  if (estimate === undefined) {
    if (row.parts.length > 0) estimate = sessionDiffSectionEstimate(row);
    else if (row.reason || sessionDiffRowTooLarge(row)) estimate = SECTION_HEAD_PX + DIFF_LINE_PX;
    else estimate = SECTION_HEAD_PX + Math.max(1, row.additions + row.deletions) * DIFF_LINE_PX;
    openEstimates.set(row, estimate);
  }
  return estimate;
}

/** One changed file: a sticky header (icon, muted middle-truncated directory,
 *  name that opens the file, the collapse chevron right after it, counts, open
 *  and undo) over its diff. Memoized on its row: a stack of hundreds of files
 *  redraws only the files whose row (or patch) moved. */
const SessionDiffSection = memo(function SessionDiffSection({
  index,
  setSize,
  row,
  mode,
  collapsed,
  onToggle: toggle,
  canRevert,
  onRevert: revert,
  onOpenFile,
  whole = false,
}: {
  /** Position among every listed file (most are not mounted). */
  index: number;
  setSize: number;
  row: SessionDiffRow;
  mode: DiffViewState['viewMode'];
  collapsed: boolean;
  /** Folds or unfolds the file, by row ID. */
  onToggle(id: string): void;
  canRevert: boolean;
  onRevert(path: string): void;
  onOpenFile?(path: string): void;
  /** Draw every recorded line of the diff (the single-file view). */
  whole?: boolean;
}) {
  const onToggle = () => toggle(row.id);
  const onRevert = () => revert(row.path);
  // Outside the project only the name shows; the full path stays in the tooltip.
  const directory = row.outside ? '' : middleTruncatedDirectory(row.path);
  const deleted = row.status === 'D';
  const openLabel = deleted ? t('Deleted files cannot be opened') : t('Open file in tab');
  const toggleLabel = collapsed
    ? t('Expand {{label}}', { label: fileBaseName(row.path) })
    : t('Collapse {{label}}', { label: fileBaseName(row.path) });
  return (
    <section
      className="session-diff-section"
      role="listitem"
      aria-posinset={index + 1}
      aria-setsize={setSize}
      data-index={index}
      data-session-diff-path={row.path}
      data-status={row.status}
      data-collapsed={collapsed ? 'true' : undefined}
    >
      {/* A file's own tab names the file in its toolbar row instead. */}
      {!whole && (
        <header className="session-diff-section-head">
          {/* The whole row (icon, folder, name, chevron, counts) opens and
            closes the file's diff; only open and undo act on their own. */}
          <button
            type="button"
            className="session-diff-collapse session-diff-section-title"
            title={row.path}
            aria-label={toggleLabel}
            aria-expanded={!collapsed}
            onClick={onToggle}
          >
            <SetiFileIcon name={fileBaseName(row.path)} className="session-diff-row-icon" />
            {directory && <span className="session-diff-row-dir">{directory}/</span>}
            <span className="session-diff-row-name">{fileBaseName(row.path)}</span>
            <ChevronDown size={14} className="session-diff-collapse-chevron" aria-hidden="true" />
            <DiffStats additions={row.additions} deletions={row.deletions} />
          </button>
          <span className="session-diff-section-actions">
            {onOpenFile && (
              <button
                type="button"
                className="browser-pane-nav-button session-diff-open"
                aria-label={openLabel}
                data-tooltip={openLabel}
                disabled={deleted}
                onClick={() => onOpenFile(row.path)}
              >
                <ArrowUpRight size={14} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="browser-pane-nav-button"
              aria-label={t('Revert {{file}}', { file: row.path })}
              data-tooltip={t('Revert {{file}}', { file: row.path })}
              disabled={!canRevert}
              onClick={onRevert}
            >
              <Undo2 size={14} aria-hidden="true" />
            </button>
          </span>
        </header>
      )}
      {sectionBody(row, mode, collapsed, whole, onOpenFile && (() => onOpenFile(row.path)))}
    </section>
  );
});

/** The folded section's height (its header), learned from a drawn one: one
 *  box for every list, like the session sidebar's rows. */
const learnedHead = { height: SECTION_HEAD_PX };

const heightKey = (mode: string, width: number, whole: boolean) => `${mode}\0${Math.round(width)}\0${whole ? 1 : 0}`;

const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

/** Every visible file is one section of a single scroll; the selected file
 *  tab draws its one file whole and never folded. Only the sections in or
 *  near the viewport are mounted (any file count). The layout is the list's
 *  uniform header row, plus the few open sections — the selected file of a
 *  capped set, or the files of a set within the file limit — at their
 *  measured (else estimated) heights; spacers stand in for every unmounted
 *  file, so the scroll extent is the whole list's. Nothing here walks the
 *  list: positions come from the open sections, rows from the list's index.
 *  Sections stay in normal flow, so their sticky headers hold. */
export function SessionDiffStack({
  stackRef,
  rows,
  withPatch,
  focusRow,
  mode,
  isFolded,
  selectedRow,
  onToggle,
  canRevertPath,
  onRevert,
  onOpenFile,
}: {
  stackRef: RefObject<HTMLDivElement | null>;
  rows: readonly SessionDiffRow[];
  /** The row to draw for a listed one (its patch, once read). */
  withPatch(row: SessionDiffRow): SessionDiffRow;
  focusRow: SessionDiffRow | null;
  mode: DiffViewState['viewMode'];
  /** The pane's fold of a file. */
  isFolded(row: SessionDiffRow): boolean;
  /** A capped set: the one file that may unfold (every other one is folded).
   *  Absent: a set within the file limit, any file may unfold. */
  selectedRow?: SessionDiffRow | null;
  /** A file header's toggle, by row ID. */
  onToggle(id: string): void;
  canRevertPath(path: string): boolean;
  onRevert(path: string): void;
  onOpenFile?(path: string): void;
}) {
  const [, setLayoutVersion] = useState(0);
  const index = rowListIndex(rows);
  const folded = (row: SessionDiffRow) =>
    row !== focusRow && (isFolded(row) || (selectedRow !== undefined && row !== selectedRow));
  // The files that may be open: the single-file view's, a capped set's
  // selected one, or (a set within the file limit) every listed file.
  let candidates: readonly SessionDiffRow[] = rows;
  if (focusRow) candidates = [focusRow];
  else if (selectedRow !== undefined) candidates = selectedRow ? [selectedRow] : [];
  const open = candidates.filter((row) => !folded(row));
  // The focused file and the one a key moves focus to stay mounted.
  const [focusedId, setFocusedId] = useState('');
  const [focusRequest, setFocusRequest] = useState('');
  const pinnedIndexes = [focusedId, focusRequest].map((id) => (id ? (index.byId.get(id) ?? -1) : -1));
  const headHeight = learnedHead.height;
  const layoutInputs = useRef({ width: 0 });
  // Keep the last measurement for each row in this pane. Resizing the stack
  // cannot accumulate old widths or displace a second pane's measurements.
  const measuredHeights = useMemo(() => new WeakMap<SessionDiffRow, { key: string; height: number }>(), []);
  const heightOf = (row: SessionDiffRow) => {
    const drawn = withPatch(row);
    const key = heightKey(mode, layoutInputs.current.width, row === focusRow);
    const entry = measuredHeights.get(drawn);
    return entry?.key === key ? entry.height : openSectionEstimate(row);
  };
  const extentsOf = (): RowExtent[] =>
    open
      .map((row) => ({ index: index.byId.get(row.id) ?? -1, extra: heightOf(row) - learnedHead.height }))
      .filter((extent) => extent.index >= 0)
      .sort((left, right) => left.index - right.index);
  const extents = extentsOf();
  const rowWindow = useRowWindow(stackRef, headHeight, rows.length, true, '', extents);
  // The pane rebuilds its callbacks every render; the sections get stable
  // ones that call the latest, so an unchanged section skips its redraw.
  const latest = useRef({ onToggle, onRevert, onOpenFile });
  latest.current = { onToggle, onRevert, onOpenFile };
  const handlers = useMemo(
    () => ({
      toggle: (id: string) => latest.current.onToggle(id),
      revert: (path: string) => latest.current.onRevert(path),
      openFile: (path: string) => latest.current.onOpenFile?.(path),
    }),
    []
  );
  // The file at the viewport's top, and how far into it the viewport starts,
  // read against the layout last committed to the DOM: whatever moves the
  // files above it afterwards (a measurement, a refresh turning a measured
  // height back into an estimate), it stays where it was.
  type Snapshot = { layout: ReturnType<typeof rowWindowLayout>; rows: readonly SessionDiffRow[] };
  const committed = useRef<Snapshot | null>(null);
  const anchor = useRef<{ id: string; within: number } | null>(null);
  /** The view and scroll offset the last commit left. */
  const shown = useRef({ view: '', top: 0 });
  const anchorAt = ({ layout, rows: drawnRows }: Snapshot, top: number) => {
    const position = Math.max(0, layout.rowsStartingBefore(top, true) - 1);
    const id = drawnRows[position]?.id;
    anchor.current = id === undefined ? null : { id, within: top - layout.offsetOf(position) };
  };
  const captureScroll = (stack: HTMLElement) => {
    const previous = committed.current;
    const top = stack.scrollTop;
    if (!previous || Math.abs(top - shown.current.top) <= 0.5) return;
    // A shorter scroll range can move scrollTop without the reader moving.
    // Keep the old anchor rather than applying that displacement twice.
    const maxTop = Math.max(0, stack.scrollHeight - stack.clientHeight);
    if (shown.current.top > maxTop && Math.abs(top - maxTop) <= 0.5 && stack.scrollHeight > 0) return;
    anchorAt(previous, top);
    shown.current.top = top;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the listener reads the committed layout and rows through refs
  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return undefined;
    const onScroll = () => captureScroll(stack);
    stack.addEventListener('scroll', onScroll, { passive: true });
    return () => stack.removeEventListener('scroll', onScroll);
  }, [stackRef]);
  // After every commit: measure the drawn sections. A height that differs
  // from the one the layout used re-renders with it; once the drawn layout
  // holds, the anchored file is put back at the viewport's top.
  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;
    // Offscreen open sections also need new extents when only headers are drawn.
    let changed = layoutInputs.current.width !== rowWindow.width;
    layoutInputs.current.width = rowWindow.width;
    for (const section of stack.querySelectorAll<HTMLElement>(':scope > .session-diff-section')) {
      const row = rows[Number(section.dataset.index)];
      if (!row) continue;
      const height = section.getBoundingClientRect().height;
      // No box (a hidden dock, a test DOM): keep what is known.
      if (height <= 0) continue;
      if (folded(row)) {
        if (Math.abs(height - learnedHead.height) > 0.5) {
          learnedHead.height = height;
          changed = true;
        }
        continue;
      }
      const drawn = withPatch(row);
      const key = heightKey(mode, rowWindow.width, row === focusRow);
      const entry = measuredHeights.get(drawn);
      const known = entry?.key === key ? entry.height : openSectionEstimate(row);
      if (entry?.key !== key || entry.height !== height) measuredHeights.set(drawn, { key, height });
      if (Math.abs(height - known) > 0.5) changed = true;
    }
    if (changed) {
      setLayoutVersion((version) => version + 1);
      return;
    }
    // Another view (a file tab, the list): what it shows starts where the pane put it.
    const view = focusRow ? `file\0${focusRow.id}` : 'list';
    if (shown.current.view !== view) {
      committed.current = null;
      anchor.current = null;
    } else captureScroll(stack);
    // The layout this commit drew (the spacers' heights).
    const layout = rowWindowLayout(rows.length, headHeight, extents);
    const held = anchor.current;
    const position = held ? index.byId.get(held.id) : undefined;
    if (held && position !== undefined && committed.current) {
      const top = layout.offsetOf(position) + held.within;
      if (Math.abs(top - stack.scrollTop) > 0.5) stack.scrollTop = top;
    }
    committed.current = { layout, rows };
    shown.current = { view, top: stack.scrollTop };
    anchorAt(committed.current, stack.scrollTop);
  });
  // A section that changes size after its commit (fonts, highlighting) is
  // measured again; each drawn section is observed once.
  const observer = useRef<{ observer: ResizeObserver; observed: WeakSet<Element> } | null>(null);
  useLayoutEffect(() => {
    const Observer = typeof window.ResizeObserver === 'function' ? window.ResizeObserver : null;
    if (!Observer) return undefined;
    observer.current = {
      observer: new Observer(() => setLayoutVersion((version) => version + 1)),
      observed: new WeakSet(),
    };
    return () => {
      observer.current?.observer.disconnect();
      observer.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    const held = observer.current;
    const stack = stackRef.current;
    if (!held || !stack) return;
    for (const section of stack.querySelectorAll(':scope > .session-diff-section')) {
      if (held.observed.has(section)) continue;
      held.observed.add(section);
      held.observer.observe(section);
    }
  });
  // The requested header is in this commit (the request pins it): focus it.
  useLayoutEffect(() => {
    if (!focusRequest) return;
    setFocusRequest('');
    const position = index.byId.get(focusRequest);
    stackRef.current
      ?.querySelector<HTMLElement>(`:scope > [data-index="${position}"] .session-diff-section-title`)
      ?.focus({ preventScroll: true });
  }, [focusRequest, index, stackRef]);
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const section = (event.target as Element).closest<HTMLElement>('.session-diff-section[data-index]');
    const id = rows[Number(section?.dataset.index ?? -1)]?.id;
    if (id !== undefined && id !== focusedId) setFocusedId(id);
  };
  // Arrow keys, Home and End move between file headers over the whole list.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!NAVIGATION_KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const title = (event.target as Element).closest('.session-diff-section-title');
    const section = title?.closest<HTMLElement>('.session-diff-section[data-index]');
    if (!section || rows.length === 0) return;
    const current = Number(section.dataset.index);
    let next = 0;
    if (event.key === 'ArrowDown') next = (current + 1) % rows.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + rows.length) % rows.length;
    else if (event.key === 'End') next = rows.length - 1;
    event.preventDefault();
    const stack = stackRef.current;
    if (stack) {
      const top = rowWindow.offsetOf(next);
      if (top < stack.scrollTop) stack.scrollTop = top;
      else if (top + learnedHead.height > stack.scrollTop + stack.clientHeight)
        stack.scrollTop = top + learnedHead.height - stack.clientHeight;
      // The key moved the viewport: anchor where it now is.
      if (committed.current) anchorAt(committed.current, stack.scrollTop);
    }
    setFocusRequest(rows[next]?.id ?? '');
  };
  const nodes = windowedRows(rowWindow, rows.length, pinnedIndexes, (position) => {
    const row = rows[position] as SessionDiffRow;
    return (
      <SessionDiffSection
        key={row.id}
        index={position}
        setSize={rows.length}
        row={withPatch(row)}
        mode={mode}
        whole={row === focusRow}
        collapsed={folded(row)}
        onToggle={handlers.toggle}
        canRevert={canRevertPath(row.path)}
        onRevert={handlers.revert}
        onOpenFile={onOpenFile ? handlers.openFile : undefined}
      />
    );
  });
  return (
    // biome-ignore lint/a11y/useSemanticElements: the sections are the list's items; most are not mounted, so each names its position
    <div className="session-diff-stack" ref={stackRef} role="list" onFocus={onFocus} onKeyDown={onKeyDown}>
      {nodes}
    </div>
  );
}
