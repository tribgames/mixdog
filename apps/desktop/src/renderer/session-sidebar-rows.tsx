import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronUp,
  CornerDownRight,
  GitFork,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DesktopSessionSummary } from '../shared/contract';
import type { SessionAttention } from '../shared/session-attention';
import { sessionDisplayTitle } from './session-display-title';
import { agentAvatar } from '../../../../src/runtime/shared/agent-avatar.mjs';
import { RoomMemberFace } from './agent-room-parts';
import { useArchivedBotIdentities } from './archived-bot-identity';
import { SessionRowStatusIcon, SessionRowUnreadDot } from './session-status-mark';
import { t } from './i18n';
import { useSessionOpenIntent } from './session-open-intent';
import { NotificationMuteMark } from './notification-controls';
import { beginPaneDrag, finishPaneDrag, type PaneDragSession } from './pane-drag-session';
import { elementMenuPoint, isContextMenuKey, pointerMenuPoint } from './ScmContextMenu';
import type { usePersistedListOrder } from './use-persisted-list-order';

export function sessionLabel(session: DesktopSessionSummary) {
  return sessionDisplayTitle(session, t('Untitled session'));
}

/** The question before a deleted bot's archived chat is deleted for good. */
export function permanentBotDeleteMessage(name: string): string {
  return t(
    "Delete {{name}} for good? Its conversation history and the bot's remaining data are deleted and cannot be restored.",
    { name }
  );
}

/** The face a deleted bot left (archived-bot-identity.ts), else its id's default. */
function DeletedBotFace({ agentId }: { agentId: string }) {
  const identity = useArchivedBotIdentities().get(agentId);
  return (
    <RoomMemberFace
      member={{ id: agentId, name: identity?.name ?? agentId, avatar: identity?.avatar ?? agentAvatar(agentId, null) }}
      className="session-row-bot-face"
    />
  );
}

/** Display-only title of the n-th fork; the stored title is unchanged. */
function forkDisplayTitle(title: string, n: number) {
  return t('{{title}} (fork {{n}})', { title, n });
}

/** Drag-reorder props for one row (see usePersistedListOrder.getReorderProps). */
export type SessionRowReorder = ReturnType<ReturnType<typeof usePersistedListOrder>['getReorderProps']>;

export const SessionSidebarRow = React.memo(function SessionSidebarRow({
  session,
  reorder,
  active,
  working,
  attention,
  rowKey,
  editingRowKey,
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
  onRequestDelete,
  onArchiveSession,
  onFavoriteSession,
  onDeleteSession,
  onOpenMenu,
  forkKind,
  forkExpanded,
  forkNumber,
  onToggleFork,
}: {
  session: DesktopSessionSummary;
  reorder?: Partial<SessionRowReorder>;
  active: boolean;
  working?: boolean;
  /** The strongest status (needs you > failed > running > unread). */
  attention: SessionAttention | '';
  /** Fork grouping: the original (`root`, with its expansion) or a numbered fork. */
  forkKind?: 'root' | 'child';
  forkExpanded?: boolean;
  forkNumber?: number;
  onToggleFork?(sessionId: string): void;
  /** Right-click / Menu key: the sidebar owns the menu and its items. */
  onOpenMenu?(session: DesktopSessionSummary, point: { x: number; y: number }, rowKey: string): void;
  /** This row's list-scoped key; the inline editor opens on one row only. */
  rowKey: string;
  editingRowKey: string;
  sessionTitleDraft: string;
  sessionTitleInvalid: boolean;
  confirmingSessionId: string;
  deletingSessionId: string;
  onTitleDraftChange(value: string): void;
  onStartRename(session: DesktopSessionSummary, rowKey: string): void;
  onCancelRename(): void;
  onCommitRename(session: DesktopSessionSummary, fromBlur?: boolean): void;
  onPrefetchSession(sessionId: string): void;
  onResumeSession(sessionId: string): void;
  onCloseEditor(): void;
  onSetConfirming: React.Dispatch<React.SetStateAction<string>>;
  onSetDeleting: React.Dispatch<React.SetStateAction<string>>;
  onRequestDelete(sessionId: string): void;
  onArchiveSession(sessionId: string, archived: boolean): Promise<void>;
  onFavoriteSession(sessionId: string, favorite: boolean): Promise<void>;
  onDeleteSession(sessionId: string): Promise<void>;
}) {
  return (
    <SessionRow
      session={session}
      reorder={reorder}
      active={active}
      working={working}
      attention={attention}
      editing={editingRowKey === rowKey}
      titleDraft={sessionTitleDraft}
      titleInvalid={sessionTitleInvalid}
      onArchiveSession={onArchiveSession}
      onFavoriteSession={onFavoriteSession}
      onOpenMenu={onOpenMenu && ((target, point) => onOpenMenu(target, point, rowKey))}
      forkKind={forkKind}
      forkExpanded={forkExpanded}
      forkNumber={forkNumber}
      onToggleFork={onToggleFork}
      onTitleDraftChange={onTitleDraftChange}
      onStartRename={(target) => onStartRename(target, rowKey)}
      onCancelRename={onCancelRename}
      onCommitRename={onCommitRename}
      onPrefetchSession={onPrefetchSession}
      onResumeSession={onResumeSession}
      confirmingDelete={confirmingSessionId === session.id}
      deleting={deletingSessionId === session.id}
      onStartDelete={(target) => {
        onCloseEditor();
        onRequestDelete(target.id);
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
  reorder,
  active,
  working,
  attention,
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
  onOpenMenu,
  forkKind,
  forkExpanded,
  forkNumber,
  onToggleFork,
}: {
  session: DesktopSessionSummary;
  reorder?: Partial<SessionRowReorder>;
  active: boolean;
  working?: boolean;
  attention: SessionAttention | '';
  forkKind?: 'root' | 'child';
  forkExpanded?: boolean;
  forkNumber?: number;
  onToggleFork?(sessionId: string): void;
  onOpenMenu?(session: DesktopSessionSummary, point: { x: number; y: number }): void;
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
  const label = forkNumber ? forkDisplayTitle(sessionLabel(session), forkNumber) : sessionLabel(session);
  // A deleted bot's archived chat: the bot's face before its name.
  const deletedBot = session.agentDeleted === true ? session.agentHome || '' : '';
  const titleRef = useRef<HTMLElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  // Only a title that does not fit fades at the row edge.
  // biome-ignore lint/correctness/useExhaustiveDependencies: label is not read, but a new title changes the text width and must re-measure.
  useLayoutEffect(() => {
    const title = titleRef.current;
    if (!title) return undefined;
    const measure = () => setOverflowing(title.scrollWidth > title.clientWidth);
    measure();
    // Test DOMs have no observer; they only need the first measurement.
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(title);
    return () => observer.disconnect();
  }, [label]);
  const dragSelection = useMemo(
    () => ({ kind: 'session' as const, id: session.id, title: label }),
    [label, session.id]
  );
  useLayoutEffect(() => {
    if (!editing) return;
    titleInput.current?.focus({ preventScroll: true });
    titleInput.current?.select();
  }, [editing]);
  // Pressing a row (mouse, touch, pen) or focusing it is the commitment to
  // open it: request the lane then, so it is usually held by the click's
  // commit. The sidebar dedupes per session and the read joins the open's.
  const openIntent = useSessionOpenIntent(session.id, onPrefetchSession);
  const { handlers: openHandlers, finalize: finalizeOpen } = openIntent;
  const activateFromClick = useCallback(() => {
    try {
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      if (editing || confirmingDelete || deleting) return;
      resume();
    } finally {
      // Opening confirmed the intent synchronously if it navigated.
      finalizeOpen();
    }
  }, [confirmingDelete, deleting, editing, resume, finalizeOpen]);
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
      data-reordering={reorder?.['data-reordering']}
      data-drop-position={reorder?.['data-drop-position']}
      onDragOver={reorder?.onDragOver}
      onDrop={reorder?.onDrop}
      aria-current={active ? 'page' : undefined}
      aria-grabbed={dragging ? 'true' : undefined}
      draggable={!editing && !confirmingDelete && !deleting}
      {...openHandlers}
      onDragStart={(event) => {
        if ((event.target as Element | null)?.closest?.('.session-row-actions, .session-title-input')) {
          event.preventDefault();
          return;
        }
        reorder?.onDragStart?.(event);
        const drag: PaneDragSession = {
          kind: 'session',
          key: `session:${session.id}`,
          title: label,
          selection: dragSelection,
        };
        beginPaneDrag(event.nativeEvent, drag, event.currentTarget, clearNativeDrag);
        nativeDrag.current = drag;
        setDragging(true);
        document.body.dataset.tabDragging = '1';
      }}
      onDragEnd={() => {
        finalizeOpen();
        reorder?.onDragEnd?.();
        finishPaneDrag();
      }}
      onClick={activateFromClick}
      onContextMenu={(event) => {
        finalizeOpen();
        if (!onOpenMenu || editing || deleting) return;
        event.preventDefault();
        onOpenMenu(session, pointerMenuPoint(event));
      }}
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
        onClick={(event) => {
          finalizeOpen();
          event.stopPropagation();
        }}
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
        aria-haspopup={onOpenMenu ? 'menu' : undefined}
        onKeyDown={(event) => {
          if (event.key === 'F2' && !confirmingDelete && !deleting) {
            event.preventDefault();
            onStartRename(session);
            return;
          }
          if (!onOpenMenu || !isContextMenuKey(event)) return;
          event.preventDefault();
          onOpenMenu(session, elementMenuPoint(event.currentTarget));
        }}
      >
        {forkKind === 'root' && (
          <GitFork className="session-row-fork-icon" data-fork="root" size={16} aria-hidden="true" />
        )}
        {forkKind === 'child' && (
          <CornerDownRight className="session-row-fork-icon" data-fork="child" size={16} aria-hidden="true" />
        )}
        {deletedBot && <DeletedBotFace agentId={deletedBot} />}
        <span className="session-row-copy">
          <b ref={titleRef} data-overflow={overflowing || undefined}>
            {label}
          </b>
        </span>
        {forkKind === 'root' && (
          // A span, not a button: it sits inside the row's button and the
          // click must not open the session.
          // biome-ignore lint/a11y/useSemanticElements: a nested <button> inside the row's button is invalid HTML.
          <span
            role="button"
            tabIndex={0}
            className="session-row-fork-toggle"
            aria-expanded={forkExpanded === true}
            aria-label={
              forkExpanded
                ? t('Collapse forks of {{name}}', { name: label })
                : t('Expand forks of {{name}}', { name: label })
            }
            onClick={(event) => {
              finalizeOpen();
              event.preventDefault();
              event.stopPropagation();
              onToggleFork?.(session.id);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              finalizeOpen();
              event.preventDefault();
              event.stopPropagation();
              onToggleFork?.(session.id);
            }}
          >
            {forkExpanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          </span>
        )}
        <NotificationMuteMark target={{ kind: 'session', id: session.id }} />
        <span className="session-row-status" data-working={working || undefined}>
          <SessionRowStatusIcon status={attention} name={label} />
        </span>
        {attention === 'unread' && <SessionRowUnreadDot name={label} />}
      </button>
      <div
        className="session-row-actions"
        onClickCapture={finalizeOpen}
        inert={editing ? true : undefined}
        aria-hidden={editing ? true : undefined}
      >
        {/* Archived rows always carry restore/delete; any other row shows the
            same cancel/confirm pair while a menu-started delete awaits
            confirmation. */}
        {(session.archived === true || confirmingDelete) && (
          <>
            {/* A deleted bot's chat restores the bot with it (session-sidebar.tsx). */}
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
        {session.archived !== true && !confirmingDelete && (
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
        {session.archived !== true && !confirmingDelete && (
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
