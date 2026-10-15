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
import { acquireTitleBarDim } from './titlebar-dim';
import { bumpTurnChangesEpoch } from './turn-changes-model';

const MENU_ITEM = "[role='menuitem']:not(:disabled)";
const runningTurnNotice = () =>
  new Error(t("Change history can't be deleted while a response is running. Try again after it finishes."));

/** The island's "Files N +a −b" segment as a menu trigger: View changes
 *  (what the segment used to do on click) and, after a separator, Delete
 *  history behind a confirmation. The menu is an island tab like Goal and
 *  the jobs: the island expands upward in place into its panel. Roving focus
 *  and Escape/Tab dismissal follow RowOverflowMenu and SidebarUsageMenu. */
export function TurnReviewFilesMenu({
  sessionId,
  historyTurns,
  busy = false,
  label,
  title,
  onViewChanges,
  children,
}: {
  sessionId: string | undefined;
  /** Retained turn records the deletion removes (the dialog's count). */
  historyTurns: number;
  /** A running turn or command: the runtime refuses deletion, so Delete history explains instead. */
  busy?: boolean;
  label: string;
  title: string;
  onViewChanges(): void;
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
      setOpen(false);
    };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      refocus.current = true;
      setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keydown);
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
    // The segment hides once the history is gone, so typing continues in this
    // pane's composer instead of focus falling to the document.
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
    // Every turn card and session diff of the session re-reads: the island
    // segment hides and the Changes list empties.
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
            <button
              type="button"
              role="menuitem"
              className="mx-menu-item"
              onClick={() => {
                close(false);
                onViewChanges();
              }}
            >
              {t('Island: View changes')}
            </button>
            <div className="usage-menu-separator" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="mx-menu-item danger"
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
            {error !== null && <ErrorNotice error={error} />}
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
