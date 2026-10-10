import { Archive, ArchiveRestore, Star, Trash2, X } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DesktopSessionSummary } from '../shared/contract';
import { sessionSummaryTitle } from '../shared/session-title.mjs';
import { ProgressSpinner } from './ProgressSpinner';
import { t } from './i18n';
import { beginPaneDrag, finishPaneDrag, type PaneDragSession } from './pane-drag-session';

const SESSION_PREFETCH_INTENT_DELAY_MS = 40;

export function sessionLabel(session: DesktopSessionSummary) {
  return sessionSummaryTitle(session, t('Untitled session'));
}

export const SessionSidebarRow = React.memo(function SessionSidebarRow({
  session,
  active,
  working,
  unread,
  editingSessionId,
  sessionTitleDraft,
  sessionTitleInvalid,
  confirmingSessionId,
  deletingSessionId,
  onTitleDraftChange,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onPrefetchSession,
  onResumeSession,
  onCloseEditor,
  onSetConfirming,
  onSetDeleting,
  onArchiveSession,
  onFavoriteSession,
  onDeleteSession,
}: {
  session: DesktopSessionSummary;
  active: boolean;
  working?: boolean;
  unread?: boolean;
  editingSessionId: string;
  sessionTitleDraft: string;
  sessionTitleInvalid: boolean;
  confirmingSessionId: string;
  deletingSessionId: string;
  onTitleDraftChange(value: string): void;
  onStartRename(session: DesktopSessionSummary): void;
  onCancelRename(): void;
  onCommitRename(session: DesktopSessionSummary, fromBlur?: boolean): void;
  onPrefetchSession(sessionId: string): void;
  onResumeSession(sessionId: string): void;
  onCloseEditor(): void;
  onSetConfirming: React.Dispatch<React.SetStateAction<string>>;
  onSetDeleting: React.Dispatch<React.SetStateAction<string>>;
  onArchiveSession(sessionId: string, archived: boolean): Promise<void>;
  onFavoriteSession(sessionId: string, favorite: boolean): Promise<void>;
  onDeleteSession(sessionId: string): Promise<void>;
}) {
  return (
    <SessionRow
      session={session}
      active={active}
      working={working}
      unread={unread}
      editing={editingSessionId === session.id}
      titleDraft={sessionTitleDraft}
      titleInvalid={sessionTitleInvalid}
      onArchiveSession={onArchiveSession}
      onFavoriteSession={onFavoriteSession}
      onTitleDraftChange={onTitleDraftChange}
      onStartRename={onStartRename}
      onCancelRename={onCancelRename}
      onCommitRename={onCommitRename}
      onPrefetchSession={onPrefetchSession}
      onResumeSession={onResumeSession}
      confirmingDelete={confirmingSessionId === session.id}
      deleting={deletingSessionId === session.id}
      onStartDelete={(target) => {
        onCloseEditor();
        onSetConfirming(target.id);
      }}
      onCancelDelete={() => onSetConfirming('')}
      onConfirmDelete={(target) => {
        onSetDeleting(target.id);
        void onDeleteSession(target.id)
          .then(() => onSetConfirming(''))
          .catch(() => {})
          .finally(() => onSetDeleting(''));
      }}
    />
  );
});

const SessionRow = React.memo(function SessionRow({
  session,
  active,
  working,
  unread,
  editing,
  titleDraft,
  titleInvalid,
  onTitleDraftChange,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onPrefetchSession,
  onResumeSession,
  confirmingDelete,
  deleting,
  onStartDelete,
  onCancelDelete,
  onConfirmDelete,
  onArchiveSession,
  onFavoriteSession,
}: {
  session: DesktopSessionSummary;
  active: boolean;
  working?: boolean;
  unread?: boolean;
  editing: boolean;
  titleDraft: string;
  titleInvalid: boolean;
  onTitleDraftChange(value: string): void;
  onStartRename(session: DesktopSessionSummary): void;
  onCancelRename(): void;
  onCommitRename(session: DesktopSessionSummary, fromBlur?: boolean): void;
  onPrefetchSession(sessionId: string): void;
  onResumeSession(sessionId: string): void;
  confirmingDelete: boolean;
  deleting: boolean;
  onStartDelete(session: DesktopSessionSummary): void;
  onCancelDelete(): void;
  onConfirmDelete(session: DesktopSessionSummary): void;
  onArchiveSession(sessionId: string, archived: boolean): Promise<void>;
  onFavoriteSession(sessionId: string, favorite: boolean): Promise<void>;
}) {
  const resume = useCallback(() => onResumeSession(session.id), [onResumeSession, session.id]);
  const titleInput = useRef<HTMLInputElement>(null);
  const nativeDrag = useRef<PaneDragSession | null>(null);
  const dragSourceMounted = useRef(true);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const label = sessionLabel(session);
  const dragSelection = useMemo(
    () => ({ kind: 'session' as const, id: session.id, title: label }),
    [label, session.id]
  );
  useLayoutEffect(() => {
    if (!editing) return;
    titleInput.current?.focus({ preventScroll: true });
    titleInput.current?.select();
  }, [editing]);
  const prefetchTimer = useRef<number | null>(null);
  const cancelPrefetch = useCallback(() => {
    if (prefetchTimer.current === null) return;
    window.clearTimeout(prefetchTimer.current);
    prefetchTimer.current = null;
  }, []);
  const schedulePrefetch = useCallback(() => {
    cancelPrefetch();
    prefetchTimer.current = window.setTimeout(() => {
      prefetchTimer.current = null;
      onPrefetchSession(session.id);
    }, SESSION_PREFETCH_INTENT_DELAY_MS);
  }, [cancelPrefetch, onPrefetchSession, session.id]);
  useEffect(() => cancelPrefetch, [cancelPrefetch]);
  const activateFromClick = useCallback(() => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (editing || confirmingDelete || deleting) return;
    cancelPrefetch();
    resume();
  }, [cancelPrefetch, confirmingDelete, deleting, editing, resume]);
  const clearNativeDrag = useCallback(() => {
    const drag = nativeDrag.current;
    nativeDrag.current = null;
    delete document.body.dataset.tabDragging;
    if (!dragSourceMounted.current) return;
    setDragging(false);
    if (!drag) return;
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  }, []);
  useEffect(() => {
    dragSourceMounted.current = true;
    return () => {
      dragSourceMounted.current = false;
      if (nativeDrag.current) finishPaneDrag();
      nativeDrag.current = null;
      delete document.body.dataset.tabDragging;
    };
  }, []);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: draggable row container; its keyboard-operable controls are the nested buttons
    // biome-ignore lint/a11y/useKeyWithClickEvents: the row click is a pointer shortcut; the title button inside is the keyboard path
    <div
      className={`session-row ${active ? 'selected' : ''} ${working ? 'working' : ''} ${editing ? 'editing' : ''} ${confirmingDelete ? 'confirming-delete' : ''}`}
      data-session-id={session.id}
      data-dragging={dragging ? 'true' : undefined}
      aria-current={active ? 'page' : undefined}
      aria-grabbed={dragging ? 'true' : undefined}
      draggable={!editing && !confirmingDelete && !deleting}
      onPointerEnter={schedulePrefetch}
      onPointerLeave={cancelPrefetch}
      onFocusCapture={schedulePrefetch}
      onBlurCapture={cancelPrefetch}
      onDragStart={(event) => {
        if ((event.target as Element | null)?.closest?.('.session-row-actions, .session-title-input')) {
          event.preventDefault();
          return;
        }
        const drag: PaneDragSession = {
          kind: 'session',
          key: `session:${session.id}`,
          title: label,
          selection: dragSelection,
        };
        beginPaneDrag(event.nativeEvent, drag, event.currentTarget, clearNativeDrag);
        nativeDrag.current = drag;
        cancelPrefetch();
        setDragging(true);
        document.body.dataset.tabDragging = '1';
      }}
      onDragEnd={() => {
        finishPaneDrag();
      }}
      onClick={activateFromClick}
      onDoubleClick={(event) => {
        if (
          editing ||
          confirmingDelete ||
          deleting ||
          (event.target as Element | null)?.closest?.('.session-row-actions, .session-title-input')
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        onStartRename(session);
      }}
    >
      <input
        ref={titleInput}
        className="session-title-input"
        value={titleDraft}
        maxLength={160}
        disabled={!editing}
        tabIndex={editing ? undefined : -1}
        aria-hidden={editing ? undefined : true}
        aria-label={t('Rename {{name}}', { name: label })}
        aria-invalid={titleInvalid || undefined}
        onInput={(event) => onTitleDraftChange(event.currentTarget.value)}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onCommitRename(session);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancelRename();
          }
        }}
        onBlur={() => {
          if (editing) onCommitRename(session, true);
        }}
      />
      <button
        type="button"
        className="session-row-main"
        inert={editing ? true : undefined}
        aria-hidden={editing ? true : undefined}
      >
        <span className="session-row-copy">
          <b>{label}</b>
        </span>
        <span className="session-row-status" data-working={working || undefined}>
          {working && (
            <ProgressSpinner
              size={12}
              className="session-row-spinner"
              role="status"
              aria-label={t('{{name}} is working', { name: label })}
            />
          )}
        </span>
        {unread && !working && (
          <span
            className="session-row-unread-dot"
            role="status"
            aria-label={t('{{name}} has new activity', { name: label })}
          />
        )}
      </button>
      <div className="session-row-actions" inert={editing ? true : undefined} aria-hidden={editing ? true : undefined}>
        {session.archived === true && (
          <>
            <button
              type="button"
              className={`session-row-action ${confirmingDelete ? 'session-row-delete-cancel' : 'session-row-restore'}`}
              aria-label={
                confirmingDelete
                  ? t('Cancel deleting {{name}}', { name: label })
                  : t('Restore {{name}}', { name: label })
              }
              data-tooltip={confirmingDelete ? t('Cancel') : t('Restore')}
              disabled={confirmingDelete && deleting}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (confirmingDelete) onCancelDelete();
                else void onArchiveSession(session.id, false).catch(() => {});
              }}
            >
              {confirmingDelete ? <X size={14} /> : <ArchiveRestore size={14} />}
            </button>
            <button
              type="button"
              className={`session-row-action ${
                confirmingDelete ? 'session-row-delete-confirm' : 'session-row-delete danger'
              }`}
              aria-label={
                confirmingDelete
                  ? t('Confirm deleting {{name}}', { name: label })
                  : t('Delete {{name}}', { name: label })
              }
              data-tooltip={confirmingDelete ? t('Delete') : undefined}
              disabled={confirmingDelete && deleting}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (confirmingDelete) onConfirmDelete(session);
                else onStartDelete(session);
              }}
            >
              <Trash2 size={confirmingDelete ? 12 : 13} />
            </button>
          </>
        )}
        {session.archived !== true && (
          <button
            type="button"
            className={`session-row-action session-row-favorite ${session.favorite === true ? 'active' : ''}`}
            aria-label={session.favorite === true ? t('Remove from favorites') : t('Add to favorites')}
            aria-pressed={session.favorite === true}
            data-tooltip={session.favorite === true ? t('Remove from favorites') : t('Add to favorites')}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void onFavoriteSession(session.id, session.favorite !== true).catch(() => {});
            }}
          >
            <Star size={14} fill={session.favorite === true ? 'currentColor' : 'none'} />
          </button>
        )}
        {session.archived !== true && (
          <button
            type="button"
            className="session-row-action session-row-archive"
            aria-label={t('Archive {{name}}', { name: label })}
            data-tooltip={t('Archive')}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void onArchiveSession(session.id, true).catch(() => {});
            }}
          >
            <Archive size={14} />
          </button>
        )}
      </div>
    </div>
  );
});
