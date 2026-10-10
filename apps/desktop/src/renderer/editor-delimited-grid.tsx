import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { DataGrid, type Column, type DataGridHandle } from 'react-data-grid';
import 'react-data-grid/lib/styles.css';
import {
  type DelimitedDiagnostic,
  type DelimitedFormat,
  type DelimitedModel,
  applyDelimitedToModel,
  deleteColumn,
  deleteRow,
  delimitedWidth,
  detectDelimitedFormat,
  insertColumn,
  insertRow,
  numericColumns,
  parseClipboardBlock,
  parseDelimited,
  pasteGrid,
  serializeClipboardBlock,
  serializeDelimited,
  setCell,
} from './editor-delimited';
import { t } from './i18n';

type Row = string[];
interface Loaded {
  rows: string[][];
  truncated: boolean;
  columnsTruncated: boolean;
  diagnostics: DelimitedDiagnostic[];
  format: DelimitedFormat;
}
interface MenuState {
  x: number;
  y: number;
  row: number;
  column: number;
}

const ROW_NUMBER_KEY = '#';
/** Sentinel last row: the "add row" ghost row. Never part of the file's rows. */
const GHOST_ROW: Row = [];

function load(text: string, delimiter: string): Loaded {
  return { ...parseDelimited(text, delimiter), format: detectDelimitedFormat(text) };
}

function columnIndex(key: string | undefined): number {
  return key === undefined || key === ROW_NUMBER_KEY ? -1 : Number(key);
}

function isPrintable(event: ReactKeyboardEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/** Multiline-capable field editor. Enter / Tab / Escape are handled by the
 *  caller; Shift+Enter and Alt+Enter insert a newline. Grows with its content. */
function fitHeight(node: HTMLTextAreaElement) {
  node.style.blockSize = 'auto';
  node.style.blockSize = `${node.scrollHeight}px`;
}

function insertNewline(node: HTMLTextAreaElement, onChange: (value: string) => void) {
  const { selectionStart, selectionEnd, value } = node;
  const next = `${value.slice(0, selectionStart)}\n${value.slice(selectionEnd)}`;
  onChange(next);
  setTimeout(() => node.setSelectionRange(selectionStart + 1, selectionStart + 1), 0);
}

function isNewlineKey(event: ReactKeyboardEvent): boolean {
  return event.key === 'Enter' && (event.shiftKey || event.altKey);
}

function CellEditor({ value, onChange, onBlur }: { value: string; onChange(value: string): void; onBlur(): void }) {
  return (
    <textarea
      className="editor-table-editor"
      rows={1}
      ref={(node) => {
        if (!node) return;
        fitHeight(node);
        if (document.activeElement !== node) {
          node.focus();
          node.select();
        }
      }}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
      onKeyDown={(event) => {
        if (isNewlineKey(event)) {
          event.preventDefault();
          event.stopPropagation();
          insertNewline(event.currentTarget, onChange);
        }
      }}
    />
  );
}

function HeaderEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit(value: string, direction: 'down' | 'right' | 'none'): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <textarea
      className="editor-table-editor"
      aria-label={t('Edit header')}
      rows={1}
      ref={(node) => {
        if (!node) return;
        fitHeight(node);
        if (document.activeElement !== node) {
          node.focus();
          node.setSelectionRange(node.value.length, node.value.length);
        }
      }}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => onCommit(value, 'none')}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (isNewlineKey(event)) {
          event.preventDefault();
          insertNewline(event.currentTarget, setValue);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          onCommit(value, 'down');
        } else if (event.key === 'Tab') {
          event.preventDefault();
          onCommit(value, 'right');
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

interface HeaderEdit {
  column: number;
  initial: string;
}

/** The row-number lead column plus one editable column per field. Row 0 of the
 *  file renders in the header; `latest` carries the values that must not
 *  invalidate the column set. */
function buildGridColumns({
  width,
  numeric,
  readOnly,
  activeColumn,
  headerEdit,
  latest,
  commitHeader,
  setHeaderEdit,
  openMenu,
  addRow,
}: {
  width: number;
  numeric: boolean[];
  readOnly: boolean;
  activeColumn: number;
  headerEdit: HeaderEdit | null;
  latest: { current: { rows: string[][]; readOnly: boolean } };
  commitHeader(column: number, value: string, direction: 'down' | 'right' | 'none'): void;
  setHeaderEdit(edit: HeaderEdit | null): void;
  openMenu(event: ReactMouseEvent, row: number, column: number): void;
  addRow(): void;
}): Column<Row>[] {
  const data = Array.from({ length: width }, (_, index): Column<Row> => {
    const align = numeric[index] ? 'is-numeric' : '';
    return {
      key: String(index),
      name: '',
      minWidth: 60,
      resizable: true,
      editable: (row) => row !== GHOST_ROW,
      cellClass: (row) => (row === GHOST_ROW ? 'editor-table-ghost-cell' : align),
      headerCellClass: `${align}${activeColumn === index ? ' is-active-column' : ''}`.trim(),
      renderHeaderCell: () =>
        headerEdit?.column === index ? (
          <HeaderEditor
            initial={headerEdit.initial}
            onCommit={(value, direction) => commitHeader(index, value, direction)}
            onCancel={() => setHeaderEdit(null)}
          />
        ) : (
          // biome-ignore lint/a11y/noStaticElementInteractions: pointer shortcuts only; the keyboard equivalents (Enter/F2 to edit, grid keys) are handled by the DataGrid's onCellKeyDown.
          <span
            className="editor-table-header-text"
            onDoubleClick={() => {
              if (!latest.current.readOnly)
                setHeaderEdit({ column: index, initial: latest.current.rows[0]?.[index] ?? '' });
            }}
            onContextMenu={(event) => openMenu(event, 0, index)}
          >
            {latest.current.rows[0]?.[index] ?? ''}
          </span>
        ),
      renderCell: ({ row }) => {
        if (row !== GHOST_ROW) return row[index] ?? '';
        if (index !== 0) return null;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the keyboard path is Enter on the ghost row (onCellKeyDown), which adds the row; this span is only the pointer target.
          <span className="editor-table-add-row" onClick={() => addRow()}>
            + {t('Add row')}
          </span>
        );
      },
      renderEditCell: readOnly
        ? undefined
        : ({ row, onRowChange, onClose }) => (
            <CellEditor
              value={row[index] ?? ''}
              onChange={(value) => {
                const next = row.slice();
                while (next.length <= index) next.push('');
                next[index] = value;
                onRowChange(next);
              }}
              onBlur={() => onClose(true, false)}
            />
          ),
    };
  });
  const lead: Column<Row> = {
    key: ROW_NUMBER_KEY,
    name: '',
    width: 44,
    minWidth: 44,
    frozen: true,
    resizable: false,
    cellClass: 'editor-table-rownum',
    headerCellClass: 'editor-table-rownum',
    renderCell: ({ row, rowIdx }) => (row === GHOST_ROW ? '' : rowIdx + 1),
  };
  return [lead, ...data];
}

/** Status paragraphs above the grid; each explains why it is read-only or why
 *  a paste did nothing. */
function GridNotices({
  rowCount,
  truncated,
  columnsTruncated,
  columnCount,
  malformedLine,
  pasteRefused,
}: {
  rowCount: number;
  truncated: boolean;
  columnsTruncated: boolean;
  columnCount: number;
  malformedLine: number | undefined;
  pasteRefused: boolean;
}) {
  return (
    <>
      {truncated && (
        <p className="editor-table-notice" role="status">
          {t('Showing the first {{count}} rows of this file.', { count: rowCount })}
        </p>
      )}
      {malformedLine !== undefined && (
        <p className="editor-table-notice" role="status">
          {t(
            'This file has CSV formatting problems, so it cannot be edited in the table (line {{line}}). Fix it in the source.',
            {
              line: malformedLine,
            }
          )}
        </p>
      )}
      {pasteRefused && (
        <p className="editor-table-notice" role="status">
          {t('The pasted data is too large or malformed, so nothing was pasted.')}
        </p>
      )}
      {columnsTruncated && (
        <p className="editor-table-notice" role="status">
          {t('Showing the first {{count}} columns of this file.', { count: columnCount })}
        </p>
      )}
    </>
  );
}

/** Row/column context menu at the pointer; pointerdown elsewhere, Escape or a
 *  window blur dismisses it. */
function GridContextMenu({
  menu,
  items,
  onClose,
}: {
  menu: MenuState;
  items: Array<{ label: string; run(): void; column?: boolean }>;
  onClose(): void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', onClose);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onClose);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  return (
    <div
      className="editor-table-menu"
      role="menu"
      style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 180) }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.column && menu.column < 0}
          onClick={() => {
            onClose();
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** Editable spreadsheet of a CSV/TSV file; row 0 of the file is the sticky
 *  header. Every committed edit serializes the whole grid back into the Monaco
 *  model as one undoable edit. A truncated parse is shown read-only: a partial
 *  grid is never written back. */
export function EditorDelimitedGrid({
  text,
  delimiter,
  modelRef,
  readOnly: fileReadOnly = false,
  onTextChange,
  onSave,
}: {
  text: string;
  delimiter: string;
  modelRef?: { current: DelimitedModel | null };
  /** Ctrl/Cmd+S inside the grid: the Monaco save command does not fire here. */
  onSave?(): void;
  /** The owner's `text` is a snapshot: it must follow every grid edit, or the
   *  next render re-parses the old snapshot and drops the edit. */
  onTextChange?(text: string): void;
  /** The file itself is read-only: model edits bypass Monaco's readOnly option,
   *  so the grid must refuse edits on its own. */
  readOnly?: boolean;
}) {
  const [state, setState] = useState(() => load(text, delimiter));
  const [seen, setSeen] = useState({ text, delimiter });
  if (seen.text !== text || seen.delimiter !== delimiter) {
    setSeen({ text, delimiter });
    setState(load(text, delimiter));
  }
  const { rows, truncated, columnsTruncated, diagnostics, format } = state;
  const malformed = diagnostics.length > 0;
  const readOnly = fileReadOnly || truncated || columnsTruncated || malformed;
  const width = Math.max(delimitedWidth(rows), 1);
  const numeric = useMemo(() => numericColumns(rows), [rows]);
  const [headerEdit, setHeaderEdit] = useState<HeaderEdit | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pasteRefused, setPasteRefused] = useState(false);
  const [activeColumn, setActiveColumn] = useState(-1);
  const gridRef = useRef<DataGridHandle | null>(null);
  const active = useRef({ rowIdx: -2, column: -1 });
  const latest = useRef({ rows, readOnly, format, delimiter, modelRef, onTextChange, text: seen.text });
  latest.current = { rows, readOnly, format, delimiter, modelRef, onTextChange, text: seen.text };

  const commit = useCallback((next: string[][]) => {
    const current = latest.current;
    if (current.readOnly || next === current.rows) return;
    const live = current.modelRef?.current;
    if (live && live.getValue() !== current.text) {
      // The shared model changed under this snapshot: never write from it.
      const fresh = live.getValue();
      setSeen({ text: fresh, delimiter: current.delimiter });
      setState(load(fresh, current.delimiter));
      current.onTextChange?.(fresh);
      return;
    }
    const out = serializeDelimited(next, current.delimiter, current.format);
    setSeen({ text: out, delimiter: current.delimiter });
    setState((previous) => ({ ...previous, rows: next }));
    const model = current.modelRef?.current;
    if (model) applyDelimitedToModel(model, out);
    current.onTextChange?.(out);
  }, []);

  /** Undo/redo one model history step and re-read the grid from the model. */
  const stepHistory = (redo: boolean): boolean => {
    const current = latest.current;
    const model = current.modelRef?.current;
    if (current.readOnly || !model) return false;
    void (redo ? model.redo() : model.undo());
    const fresh = model.getValue();
    if (fresh !== current.text) {
      setSeen({ text: fresh, delimiter: current.delimiter });
      setState(load(fresh, current.delimiter));
      current.onTextChange?.(fresh);
    }
    return true;
  };

  const commitHeader = useCallback(
    (column: number, value: string, direction: 'down' | 'right' | 'none') => {
      setHeaderEdit((edit) => {
        if (!edit || edit.column !== column) return edit;
        commit(setCell(latest.current.rows, 0, column, value));
        if (direction !== 'none') {
          const idx = direction === 'right' ? Math.min(column + 1, width - 1) + 1 : column + 1;
          setTimeout(() => gridRef.current?.setActivePosition({ idx, rowIdx: direction === 'down' ? 0 : -1 }), 0);
        }
        return null;
      });
    },
    [commit, width]
  );

  function addRow() {
    const length = latest.current.rows.length;
    commit(insertRow(latest.current.rows, length));
    setTimeout(() => gridRef.current?.scrollToCell({ rowIdx: length - 1 }), 0);
  }

  function openMenu(event: ReactMouseEvent, row: number, column: number) {
    if (latest.current.readOnly) return;
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, row, column });
  }

  const closeMenu = useCallback(() => setMenu(null), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: addRow/openMenu are re-created every render but only touch refs and stable setters, so the first closures stay correct; rows[0] (the header text) is what the memo must follow, not the whole row list.
  const columns = useMemo(
    () =>
      buildGridColumns({
        width,
        numeric,
        readOnly,
        activeColumn,
        headerEdit,
        latest,
        commitHeader,
        setHeaderEdit,
        openMenu,
        addRow,
      }),
    [width, numeric, readOnly, headerEdit, commitHeader, activeColumn, rows[0]]
  );

  const bodyRows = useMemo(() => (readOnly ? rows.slice(1) : [...rows.slice(1), GHOST_ROW]), [rows, readOnly]);

  const target = () => ({ row: active.current.rowIdx + 1, column: active.current.column });
  const editingField = (event: ClipboardEvent) => ['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement).tagName);

  const onCopy = (event: ClipboardEvent) => {
    const { row, column } = target();
    if (editingField(event) || column < 0 || active.current.rowIdx < -1) return;
    event.clipboardData.setData('text/plain', serializeClipboardBlock([[rows[row]?.[column] ?? '']]));
    event.preventDefault();
  };
  const onPaste = (event: ClipboardEvent) => {
    const { row, column } = target();
    if (readOnly || editingField(event) || column < 0 || active.current.rowIdx < -1) return;
    const block = parseClipboardBlock(event.clipboardData.getData('text/plain'), delimiter);
    if (block.rows.length === 0) return;
    event.preventDefault();
    const next = block.refused ? rows : pasteGrid(rows, row, column, block.rows);
    if (next === rows || next.length === 0) {
      setPasteRefused(true);
      return;
    }
    setPasteRefused(false);
    commit(next);
  };

  const menuItems = menu
    ? [
        { label: t('Insert row above'), run: () => commit(insertRow(rows, menu.row)) },
        { label: t('Insert row below'), run: () => commit(insertRow(rows, menu.row + 1)) },
        { label: t('Delete row'), run: () => commit(deleteRow(rows, menu.row)) },
        { label: t('Insert column left'), run: () => commit(insertColumn(rows, menu.column)), column: true },
        { label: t('Insert column right'), run: () => commit(insertColumn(rows, menu.column + 1)), column: true },
        { label: t('Delete column'), run: () => commit(deleteColumn(rows, menu.column)), column: true },
      ]
    : [];

  return (
    <div
      className="editor-text-view editor-table-view"
      data-readonly={readOnly ? 'true' : undefined}
      onCopy={onCopy}
      onPaste={onPaste}
      onKeyDownCapture={(event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        const key = event.key.toLowerCase();
        const target = event.target as HTMLElement;
        const editingCell = ['INPUT', 'TEXTAREA'].includes(target.tagName);
        if (key === 's' && onSave) {
          event.preventDefault();
          event.stopPropagation();
          // Blur commits a cell editor's pending value before the save reads the model.
          if (editingCell) target.blur();
          setTimeout(onSave, 0);
          return;
        }
        // A cell editor keeps its own text undo; outside it the grid steps the
        // model's history, where every committed grid edit is one entry.
        if ((key === 'z' || key === 'y') && !editingCell && stepHistory(key === 'y' || event.shiftKey)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <GridNotices
        rowCount={rows.length}
        truncated={truncated}
        columnsTruncated={columnsTruncated}
        columnCount={width}
        malformedLine={malformed ? diagnostics[0].line : undefined}
        pasteRefused={pasteRefused}
      />
      <DataGrid<Row>
        ref={gridRef}
        className="editor-table-grid"
        aria-label={t('Table')}
        columns={columns}
        rows={bodyRows}
        rowHeight={24}
        headerRowHeight={24}
        onRowsChange={
          readOnly ? undefined : (next) => commit([rows[0] ?? [], ...next.filter((row) => row !== GHOST_ROW)])
        }
        onActivePositionChange={({ rowIdx, column }) => {
          active.current = { rowIdx, column: columnIndex(column?.key) };
          setActiveColumn(active.current.column);
        }}
        onCellContextMenu={({ rowIdx, column }, event) => {
          event.preventGridDefault();
          if (columnIndex(column.key) >= 0) openMenu(event, rowIdx + 1, columnIndex(column.key));
          else openMenu(event, rowIdx + 1, -1);
        }}
        onCellKeyDown={(args, event) => {
          if (readOnly) return;
          if (args.mode === 'EDIT') {
            if (event.key === 'Enter') {
              event.preventGridDefault();
              args.onClose(true);
              const idx = args.column.idx;
              const rowIdx = args.rowIdx + 1;
              if (rowIdx < rows.length - 1) setTimeout(() => gridRef.current?.setActivePosition({ idx, rowIdx }), 0);
            }
            return;
          }
          const column = columnIndex(args.column?.key);
          if (column < 0) return;
          const row = args.rowIdx + 1;
          if (row >= rows.length) {
            if (event.key === 'Enter') {
              event.preventGridDefault();
              addRow();
            }
          } else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventGridDefault();
            event.preventDefault();
            commit(setCell(rows, row, column, ''));
          } else if (args.rowIdx === -1 && (event.key === 'Enter' || event.key === 'F2' || isPrintable(event))) {
            event.preventGridDefault();
            event.preventDefault();
            setHeaderEdit({ column, initial: isPrintable(event) ? event.key : (rows[0]?.[column] ?? '') });
          }
        }}
      />
      {menu && <GridContextMenu menu={menu} items={menuItems} onClose={closeMenu} />}
    </div>
  );
}
