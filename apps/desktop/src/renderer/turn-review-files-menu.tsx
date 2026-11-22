import { X } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { useComposerIslandTab } from './composer-island-state';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { scrimDismiss } from './scrim-dismiss';
import { trappedTabIndex } from './list-navigation';
import { usePaneKey } from './pane-key-context';
import { IslandPanelHead } from './IslandPanelFoot';
import { useMobileBack } from './mobile-back';
import { acquireModalLayer } from './modal-layer';
import { RowOverflowMenu } from './RowOverflowMenu';
import { useRowWindow, windowedRows } from './source-control-support';
import { useSurfaceActive } from './surface-activity';
import {
  SESSION_CHANGES_SOURCES,
  prefetchSessionChanges,
  sessionChangesSourceLabel,
  setSessionChangesSource,
  useSessionChangesSource,
} from './session-changes-store';
import { acquireTitleBarDim } from './titlebar-dim';
import { bumpTurnChangesEpoch } from './turn-changes-model';
import type { TurnReviewFileEntry } from './turn-review-model';

const MENU_ITEM = "[role='menuitem']:not(:disabled)";
/** `.turn-review-files-row`'s desktop height (15-composer.css); the open list
 *  learns the real one (the touch row on a phone) from its first row. */
const FILE_ROW_PX = 26;
/** Delete history and View changes, after the file rows in the menu's order. */
const FOOT_ITEMS = 2;
export const runningTurnNotice = () =>
  new Error(t("Change history can't be deleted while a response is running. Try again after it finishes."));

/** Delete history: the session's retained turn records (and Undo/Reapply)
 *  go, working-tree files stay; every turn card and session diff of the
 *  session re-reads. A running turn's refusal reads as runningTurnNotice. */
export async function clearSessionChangeHistory(sessionId: string | undefined): Promise<void> {
  try {
    await window.mixdogDesktop?.invokeCapability?.({
      capability: 'clearSessionChangeHistory',
      args: [],
      sessionId,
    });
  } catch (reason) {
    throw /running a turn/.test(String(reason)) ? runningTurnNotice() : reason;
  }
  if (sessionId) bumpTurnChangesEpoch(sessionId);
}
/** The source picker's menu is a body portal: presses and keys there belong to it. */
const inSourceMenu = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest('.row-overflow-menu'));

/** Reads the row box (the 44px touch row on a phone) from a drawn row after
 *  every commit and whenever that row resizes. */
function useLearnedRowHeight(
  list: RefObject<HTMLDivElement | null>,
  open: boolean,
  setRowHeight: (update: (current: number) => number) => void
) {
  const sizedRow = useRef<{ row: Element; observer: ResizeObserver | null } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const row = list.current?.querySelector('.turn-review-files-row') ?? null;
    if (!row) return;
    const learn = () => {
      const height = row.getBoundingClientRect().height;
      if (height > 0) setRowHeight((current) => (Math.abs(height - current) > 0.5 ? height : current));
    };
    learn();
    if (sizedRow.current?.row === row) return;
    sizedRow.current?.observer?.disconnect();
    const Observer = typeof window.ResizeObserver === 'function' ? window.ResizeObserver : null;
    const observer = Observer ? new Observer(learn) : null;
    observer?.observe(row);
    sizedRow.current = { row, observer };
  });
  useEffect(() => () => sizedRow.current?.observer?.disconnect(), []);
}

/** The index a menu key moves to over `total` items, or null for a key that does not navigate. */
function menuNavigationTarget(key: string, current: number, total: number): number | null {
  if (key === 'ArrowDown') return (current + 1) % total;
  if (key === 'ArrowUp') return (current - 1 + total) % total;
  if (key === 'Home') return 0;
  if (key === 'End') return total - 1;
  return null;
}

function FileRowButton({
  index,
  path,
  entry,
  menuSize,
  onFocus,
  onPointerDown,
  onOpen,
}: {
  index: number;
  path: string;
  entry: TurnReviewFileEntry;
  menuSize: number;
  onFocus(): void;
  onPointerDown(): void;
  onOpen(): void;
}) {
  const clean = path.replace(/\\/g, '/');
  const slash = clean.lastIndexOf('/');
  return (
    <button
      type="button"
      role="menuitem"
      className="turn-review-files-row"
      data-index={index}
      aria-posinset={index + 1}
      aria-setsize={menuSize}
      title={clean}
      onFocus={onFocus}
      onPointerDown={onPointerDown}
      onClick={onOpen}
    >
      {/* The folder gives way first; the file name keeps its room. */}
      <span className="turn-review-files-path">
        {slash >= 0 && <span className="turn-review-files-dir">{clean.slice(0, slash + 1)}</span>}
        <span className="turn-review-files-name">{clean.slice(slash + 1)}</span>
      </span>
      {entry.lineStats && (
        <span className="diff-stats">
          {entry.additions > 0 && <i>+{entry.additions}</i>}
          {entry.additions > 0 && entry.deletions > 0 && ' '}
          {entry.deletions > 0 && <em>−{entry.deletions}</em>}
        </span>
      )}
    </button>
  );
}

/** The panel header's Changes source picker (shared with the Changes pane). */
function ChangesSourceMenu() {
  const source = useSessionChangesSource();
  return (
    <RowOverflowMenu
      label={t('Changes source')}
      tooltip={t('Changes source')}
      items={SESSION_CHANGES_SOURCES.map((value) => ({
        id: value,
        label: sessionChangesSourceLabel(value),
        checked: value === source,
        // The conversation's own sources stand apart from Git's.
        separatorBefore: value === 'branch',
        onSelect: () => setSessionChangesSource(value),
      }))}
    />
  );
}

/** The island's "Files N +a −b" segment as a menu trigger: every changed file
 *  in one scrolling list, with Delete history (behind a confirmation) and View
 *  changes fixed below it. */
export function TurnReviewFilesMenu({
  sessionId,
  historyTurns,
  busy = false,
  label,
  title,
  files,
  sourcePicker = false,
  emptyText = '',
  ready = true,
  onViewChanges,
  onOpenFile,
  children,
}: {
  sessionId: string | undefined;
  /** Retained turn records the deletion removes (the dialog's count). */
  historyTurns: number;
  /** A running turn or command: the runtime refuses deletion, so Delete history explains instead. */
  busy?: boolean;
  label: string;
  title: string;
  /** Every changed file with its line counts. */
  files: ReadonlyMap<string, TurnReviewFileEntry>;
  /** A Git root: the header names the source (`label`) and offers its picker. */
  sourcePicker?: boolean;
  /** Shown while the open menu's source has no files. */
  emptyText?: string;
  /** The source has answered once; before that an empty list says nothing. */
  ready?: boolean;
  onViewChanges(): void;
  /** Opens one file's diff. */
  onOpenFile(path: string): void;
  children: ReactNode;
}) {
  // The island owns the open tab (one at a time); alone, it is local state.
  const [open, setOpen] = useComposerIslandTab('files-menu');
  // The pane whose dock View changes opens.
  const paneKey = usePaneKey();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  // Set when a close should hand focus back to the segment; the segment is
  // hidden while its tab is open, so focus moves once the tab has closed.
  const refocus = useRef(false);
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;
  const close = (restoreFocus: boolean) => {
    refocus.current = restoreFocus;
    setOpen(false);
  };
  useMobileBack(open, () => setOpen(false));
  // Off screen (retained or parked conversation) the open menu takes no press
  // or key: they belong to the shown conversation.
  const surfaceActive = useSurfaceActive();
  // A segment that leaves (its files went away) takes its open tab with it.
  useEffect(() => () => setOpenRef.current(false), []);
  // The list mounts only the rows in or near its viewport (any file count);
  // spacers keep the whole list's scroll height.
  // Once per file list (a data change): its rows and where each path is.
  const { entries, indexOf } = useMemo(() => {
    const listed = [...files.entries()];
    return { entries: listed, indexOf: new Map(listed.map(([path], index) => [path, index])) };
  }, [files]);
  const list = useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = useState(FILE_ROW_PX);
  const rowWindow = useRowWindow(list, rowHeight, entries.length, open, '');
  // The row holding focus, and the one a key press moves focus to, stay
  // mounted wherever the list is scrolled; held by path, so new files
  // arriving above never move the pin to another file.
  const [focusedPath, setFocusedPath] = useState('');
  const [focusRequest, setFocusRequest] = useState('');
  useLayoutEffect(() => {
    if (!open && focusedPath) setFocusedPath('');
  });
  useLearnedRowHeight(list, open, setRowHeight);
  // The requested row is in this commit (the request pins it): focus it.
  useLayoutEffect(() => {
    if (!focusRequest) return;
    setFocusRequest('');
    const index = indexOf.get(focusRequest);
    list.current?.querySelector<HTMLButtonElement>(`[data-index="${index}"]`)?.focus({ preventScroll: true });
  }, [focusRequest, indexOf]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setOpen is rebuilt each render; the listeners only rebind when the tab opens or closes
  useEffect(() => {
    if (!open) {
      setError(null);
      if (refocus.current) trigger.current?.focus();
      refocus.current = false;
      return undefined;
    }
    if (!surfaceActive) return undefined;
    // Opening the menu is the first sign the user may open Changes.
    prefetchSessionChanges(sessionId, { paneKey });
    queueMicrotask(() => panel.current?.querySelector<HTMLButtonElement>(MENU_ITEM)?.focus());
    // Same dismissal as the island's other tabs: a press outside the island,
    // or Escape.
    const dismiss = (event: PointerEvent) => {
      const island = panel.current?.closest('.composer-island') ?? panel.current;
      if (island && event.target instanceof Node && island.contains(event.target)) return;
      if (inSourceMenu(event.target)) return;
      setOpen(false);
    };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape while the source picker is open closes only the picker. This
      // capture listener runs before the picker's own (registered later), so
      // the picker is still open here.
      if (inSourceMenu(event.target) || panel.current?.querySelector('.row-overflow-trigger[aria-expanded="true"]')) {
        return;
      }
      refocus.current = true;
      setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keydown, true);
    };
  }, [open, sessionId, paneKey, surfaceActive]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      close(false);
      return;
    }
    // The menu's order: every file row (mounted or not), then the foot.
    const foot = [
      ...(panel.current?.querySelectorAll<HTMLButtonElement>(`.turn-review-files-foot ${MENU_ITEM}`) ?? []),
    ];
    const total = entries.length + foot.length;
    if (!total) return;
    const active = document.activeElement as HTMLElement | null;
    const row = active?.closest<HTMLElement>('.turn-review-files-row[data-index]');
    const footIndex = foot.indexOf(active as HTMLButtonElement);
    let current = 0;
    if (row) current = Number(row.dataset.index);
    else if (footIndex >= 0) current = entries.length + footIndex;
    const next = menuNavigationTarget(event.key, current, total);
    if (next === null) return;
    event.preventDefault();
    if (next >= entries.length) {
      foot[next - entries.length]?.focus();
      return;
    }
    // Scroll the row into the list's view; the request mounts it (wherever the
    // window is) and focuses it in the same commit.
    const scroller = list.current;
    if (scroller) {
      const top = next * rowHeight;
      if (top < scroller.scrollTop) scroller.scrollTop = top;
      else if (top + rowHeight > scroller.scrollTop + scroller.clientHeight)
        scroller.scrollTop = top + rowHeight - scroller.clientHeight;
    }
    setFocusRequest(entries[next]?.[0] ?? '');
  };
  const menuSize = entries.length + FOOT_ITEMS;
  const fileRow = (index: number) => {
    const [path, entry] = entries[index] as [string, TurnReviewFileEntry];
    return (
      <FileRowButton
        key={path}
        index={index}
        path={path}
        entry={entry}
        menuSize={menuSize}
        onFocus={() => setFocusedPath(path)}
        onPointerDown={() => prefetchSessionChanges(sessionId, { paneKey, focusPath: path })}
        onOpen={() => {
          close(false);
          onOpenFile(path);
        }}
      />
    );
  };
  // The window plus the pinned rows, resolved from their paths to where they are now.
  const pinned = [focusedPath, focusRequest].map((path) => (path ? (indexOf.get(path) ?? -1) : -1));
  const listNodes = windowedRows(rowWindow, entries.length, pinned, fileRow);
  const deleteHistory = async () => {
    let scope = trigger.current?.parentElement ?? null;
    while (scope && !scope.querySelector('.composer textarea')) scope = scope.parentElement;
    const composer = scope?.querySelector<HTMLTextAreaElement>('.composer textarea') ?? null;
    try {
      await clearSessionChangeHistory(sessionId);
    } catch (reason) {
      // The refusal (a running turn, a failed write) shows where it was asked.
      setOpen(true);
      setError(reason);
      return;
    }
    composer?.focus({ preventScroll: true });
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="composer-island-seg turn-review-segment"
        aria-label={label}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {children}
      </button>
      {open && (
        <section ref={panel} className="composer-island-panel turn-review-files-panel" aria-label={label}>
          <IslandPanelHead
            chip={children}
            meta={sourcePicker ? label : undefined}
            metaClassName="turn-review-files-source"
            extra={sourcePicker ? <ChangesSourceMenu /> : undefined}
            onClose={() => close(true)}
          />
          <div
            className="composer-island-pbody turn-review-files-menu"
            role="menu"
            aria-label={t('Files menu')}
            onKeyDown={onKeyDown}
          >
            {/* A source picked here with no files keeps the menu, saying so. */}
            {files.size === 0 && <p className="turn-review-files-empty mx-empty-state">{ready ? emptyText : ''}</p>}
            {/* Every changed file in one scrolling list; a row opens its diff. */}
            <div ref={list} className="turn-review-files-list">
              {listNodes}
            </div>
            {error !== null && <ErrorNotice error={error} />}
            <div className="turn-review-files-foot" role="none" hidden={files.size === 0}>
              <button
                type="button"
                role="menuitem"
                className="composer-island-button danger"
                aria-posinset={entries.length + 1}
                aria-setsize={menuSize}
                onClick={() => {
                  // The runtime refuses deletion mid-turn: say so here instead of confirming.
                  if (busy) {
                    setError(runningTurnNotice());
                    return;
                  }
                  close(false);
                  setConfirming(true);
                }}
              >
                {t('Delete history')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="composer-island-button"
                aria-posinset={entries.length + 2}
                aria-setsize={menuSize}
                onPointerDown={() => prefetchSessionChanges(sessionId, { paneKey })}
                onFocus={() => prefetchSessionChanges(sessionId, { paneKey })}
                onClick={() => {
                  close(false);
                  onViewChanges();
                }}
              >
                {t('Island: View changes')}
              </button>
            </div>
          </div>
        </section>
      )}
      {confirming && (
        <DeleteHistoryDialog
          turns={historyTurns}
          returnFocus={trigger}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void deleteHistory();
          }}
        />
      )}
    </>
  );
}

/** Delete history's confirmation: the settings-confirm skin as a real modal
 *  (DesktopUpdateDialog's pattern) — the app shell goes inert, Tab stays in
 *  the dialog, Escape and the scrim cancel, and Cancel is the default. */
export function DeleteHistoryDialog({
  turns,
  returnFocus,
  onCancel,
  onConfirm,
}: {
  turns: number;
  /** Focused once the dialog has closed and the shell is interactive again. */
  returnFocus: RefObject<HTMLElement | null>;
  onCancel(): void;
  onConfirm(): void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useMobileBack(true, () => onCancelRef.current());
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('.app-shell');
    const layer = acquireModalLayer(shell ? [shell] : []);
    layer.attachSurface(surfaceRef.current);
    cancelRef.current?.focus({ preventScroll: true });
    // The scrim cannot reach the native caption band; this claim dims it.
    const captionDim = acquireTitleBarDim();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!layer.isTop()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') || []);
      const next = trappedTabIndex(
        controls.indexOf(document.activeElement as HTMLElement),
        controls.length,
        event.shiftKey
      );
      event.preventDefault();
      controls[next]?.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      layer.release();
      captionDim();
      returnFocus.current?.focus({ preventScroll: true });
    };
  }, [returnFocus]);
  return createPortal(
    // Backdrop click-to-dismiss; keyboard dismissal is handled by the Escape listener above.
    <div ref={surfaceRef} className="settings-confirm-layer" {...scrimDismiss(onCancel)}>
      <section
        ref={dialogRef}
        className="settings-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-history-title"
        aria-describedby="delete-history-description"
        tabIndex={-1}
      >
        <header>
          <h3 id="delete-history-title">{t("Delete this session's change history?")}</h3>
          <button type="button" aria-label={t('Close confirmation')} onClick={onCancel}>
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <p id="delete-history-description">
          {t(
            'Retained changes and Undo/Reapply for {{count}} turns will be permanently removed. Current files, conversation and Git history stay unchanged.',
            { count: turns }
          )}
        </p>
        <footer>
          <button ref={cancelRef} type="button" onClick={onCancel}>
            {t('Cancel')}
          </button>
          <button type="button" className="danger" onClick={onConfirm}>
            {t('Delete history')}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}
