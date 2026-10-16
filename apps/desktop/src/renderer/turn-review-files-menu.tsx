import { X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useComposerIslandTab } from './composer-island-state';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { trappedTabIndex } from './list-navigation';
import { MxIcon } from './MxIcon';
import { useMobileBack } from './mobile-back';
import { acquireModalLayer } from './modal-layer';
import { RowOverflowMenu } from './RowOverflowMenu';
import {
  SESSION_CHANGES_SOURCES,
  sessionChangesSourceLabel,
  setSessionChangesSource,
  useSessionChangesSource,
} from './session-changes-store';
import { acquireTitleBarDim } from './titlebar-dim';
import { bumpTurnChangesEpoch } from './turn-changes-model';
import type { TurnReviewFileEntry } from './turn-review-model';

const MENU_ITEM = "[role='menuitem']:not(:disabled)";
const runningTurnNotice = () =>
  new Error(t("Change history can't be deleted while a response is running. Try again after it finishes."));
/** The source picker's menu is a body portal: presses and keys there belong to it. */
const inSourceMenu = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest('.row-overflow-menu'));

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
 *  in one scrolling list (a row opens that file's diff), with Delete history
 *  (behind a confirmation) and View changes fixed below it. The menu is an island tab like Goal and
 *  the jobs: the island expands upward in place into its panel. Roving focus
 *  and Escape/Tab dismissal follow RowOverflowMenu and SidebarUsageMenu. */
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
  // A segment that leaves (its files went away) takes its open tab with it.
  useEffect(() => () => setOpenRef.current(false), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setOpen is rebuilt each render; the listeners only rebind when the tab opens or closes
  useEffect(() => {
    if (!open) {
      setError(null);
      if (refocus.current) trigger.current?.focus();
      refocus.current = false;
      return undefined;
    }
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
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      close(false);
      return;
    }
    const entries = [...(panel.current?.querySelectorAll<HTMLButtonElement>(MENU_ITEM) ?? [])];
    if (!entries.length) return;
    const current = Math.max(0, entries.indexOf(document.activeElement as HTMLButtonElement));
    let next: number;
    if (event.key === 'ArrowDown') next = (current + 1) % entries.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + entries.length) % entries.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = entries.length - 1;
    else return;
    event.preventDefault();
    entries[next]?.focus();
  };
  const deleteHistory = async () => {
    // The segment counts the selected Changes source. A Git root's sources
    // (uncommitted, branch, staged…) read the working tree, which deleting
    // history leaves untouched, so the segment stays; the Last turn source
    // and a non-Git root's session diff empty, and the segment hides. Either
    // way typing continues in this pane's composer instead of focus falling
    // to the document.
    let scope = trigger.current?.parentElement ?? null;
    while (scope && !scope.querySelector('.composer textarea')) scope = scope.parentElement;
    const composer = scope?.querySelector<HTMLTextAreaElement>('.composer textarea') ?? null;
    try {
      await window.mixdogDesktop?.invokeCapability?.({
        capability: 'clearSessionChangeHistory',
        args: [],
        sessionId,
      });
    } catch (reason) {
      // The refusal (a running turn, a failed write) shows where it was asked.
      setOpen(true);
      setError(/running a turn/.test(String(reason)) ? runningTurnNotice() : reason);
      return;
    }
    // Every turn card and session diff of the session re-reads: retained
    // turn records (and Undo/Reapply) are gone; working-tree files are not.
    if (sessionId) bumpTurnChangesEpoch(sessionId);
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
          <div className="composer-island-phead">
            <span className="composer-island-tab turn-review-files-tab" data-active="true">
              {children}
            </span>
            {sourcePicker && (
              <>
                <span className="composer-island-phead-meta turn-review-files-source">{label}</span>
                <ChangesSourceMenu />
              </>
            )}
            <button
              type="button"
              className="composer-island-close"
              aria-label={t('Close')}
              title={t('Close')}
              onClick={() => close(true)}
            >
              <MxIcon name="close-small" size={16} />
            </button>
          </div>
          <div
            className="composer-island-pbody turn-review-files-menu"
            role="menu"
            aria-label={t('Files menu')}
            onKeyDown={onKeyDown}
          >
            {/* A source picked here with no files keeps the menu, saying so. */}
            {files.size === 0 && <p className="turn-review-files-empty">{ready ? emptyText : ''}</p>}
            {/* Every changed file in one scrolling list; a row opens its diff. */}
            <div className="turn-review-files-list">
              {[...files.entries()].map(([path, entry]) => {
                const clean = path.replace(/\\/g, '/');
                const slash = clean.lastIndexOf('/');
                return (
                  <button
                    key={path}
                    type="button"
                    role="menuitem"
                    className="turn-review-files-row"
                    title={clean}
                    onClick={() => {
                      close(false);
                      onOpenFile(path);
                    }}
                  >
                    <span className="turn-review-files-path">
                      {slash >= 0 && <span className="turn-review-files-dir">{clean.slice(0, slash + 1)}</span>}
                      {clean.slice(slash + 1)}
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
              })}
            </div>
            {error !== null && <ErrorNotice error={error} />}
            <div className="turn-review-files-foot" role="none" hidden={files.size === 0}>
              <button
                type="button"
                role="menuitem"
                className="composer-island-button danger"
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
function DeleteHistoryDialog({
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
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss; keyboard dismissal is handled by the Escape listener above.
    <div
      ref={surfaceRef}
      className="settings-confirm-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
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
