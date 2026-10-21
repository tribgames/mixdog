// The Agents pane's group rooms: their rows under the contacts (same row look:
// a tiled face, name, last speaker and line, time, unread), the pane's "+"
// menu (new agent / new room) and the new-room dialog.
import { Check, Plus, X } from 'lucide-react';
import { type FormEvent, useId, useMemo, useRef, useState } from 'react';
import { ROOM_MAX_MEMBERS, ROOM_MIN_MEMBERS } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import type { DesktopSessionSummary } from '../shared/contract';
import { agentChatTimeLabel } from './agent-chat-summary';
import { RoomAvatar, RoomMemberFace, type RoomMemberLabel, useRoomContacts } from './agent-room-parts';
import { type AgentRoomRowModel, agentRoomRows, roomRowLabel } from './agent-rooms-model';
import { showDesktopToast } from './desktop-toasts';
import { ErrorNotice, errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';
import { agentRoomMenuItems } from './agent-profile-actions';
import { ScmContextMenu, type ScmContextMenuState, contextMenuRowProps } from './ScmContextMenu';
import { SidebarDialogLayer } from './sidebar-dialog';

type OpenSession = (sessionId: string, title: string, ownerSessionId: string) => void;

function RoomRow({
  row,
  members,
  selected,
  onOpen,
  onOpenMenu,
}: {
  row: AgentRoomRowModel;
  members: RoomMemberLabel[];
  selected: boolean;
  onOpen(): void;
  onOpenMenu(menu: ScmContextMenuState): void;
}) {
  const describedBy = useId();
  const { indicator } = row;
  return (
    <li
      className={`agent-chat-row${selected ? ' selected' : ''}`}
      data-kind="contact"
      data-agent-room={row.room.id}
      {...contextMenuRowProps((point) =>
        onOpenMenu({
          label: t('Actions for {{title}}', { title: row.name }),
          ...point,
          items: agentRoomMenuItems(row.room),
        })
      )}
    >
      <button
        type="button"
        className="agent-chat-row-main"
        aria-current={selected ? 'page' : undefined}
        aria-haspopup="menu"
        aria-label={roomRowLabel(row.name, row.room.members.length)}
        aria-describedby={`${describedBy}-preview`}
        onClick={onOpen}
      >
        <span className="agent-chat-avatar">
          <RoomAvatar members={members} />
        </span>
        <span className="agent-chat-body agent-contact-body">
          <b className="agent-chat-title">
            {row.name}
            {/* The member count beside the name, as a messenger's group row. */}
            <span className="agent-room-member-count">
              <span aria-hidden="true">{row.room.members.length}</span>
            </span>
          </b>
          <span id={`${describedBy}-preview`} className="agent-chat-preview">
            {row.speaker && <span className="agent-room-speaker">{row.speaker} </span>}
            {indicator?.kind === 'running' ? t('Members are speaking') : row.preview}
          </span>
          {(row.at > 0 || indicator) && (
            <span className="agent-contact-aside" data-has-status={indicator ? 'true' : undefined}>
              {row.at > 0 && <time className="agent-chat-time">{agentChatTimeLabel(row.at)}</time>}
              {indicator?.kind === 'running' && (
                <span className="agent-chat-status" data-kind="running">
                  <ProgressSpinner size={14} aria-hidden="true" />
                  <span className="sr-only">{t('Working')}</span>
                </span>
              )}
              {indicator?.kind === 'unread' && (
                <span className="agent-chat-status" data-kind="unread">
                  <span className="sr-only">{t('Unread')} </span>
                  {indicator.count > 99 ? '99+' : indicator.count}
                </span>
              )}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/** The room rows the pane shows (its search applied), and the member labeller.
 *  The pane reads them to know whether the section is empty. */
export function useAgentRoomRows(
  sessions: readonly DesktopSessionSummary[],
  needle = '',
  unreadSessionIds?: ReadonlySet<string>
) {
  const { label } = useRoomContacts();
  const rows = useMemo(
    () =>
      agentRoomRows(sessions, label, unreadSessionIds).filter(
        (row) => !needle || `${row.name}\n${row.preview}`.toLowerCase().includes(needle)
      ),
    [label, needle, sessions, unreadSessionIds]
  );
  return { rows, label };
}

/** The room rows, with a hairline above when the pane says something precedes
 *  them; nothing without rooms. */
export function AgentRoomsSection({
  rows,
  label,
  divider = true,
  selectedSessionId = '',
  onOpenSession,
}: {
  rows: ReturnType<typeof useAgentRoomRows>['rows'];
  label: ReturnType<typeof useAgentRoomRows>['label'];
  /** A hairline above (the pane decides: something visible precedes). */
  divider?: boolean;
  selectedSessionId?: string;
  onOpenSession?: OpenSession;
}) {
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  if (!rows.length) return null;
  return (
    <>
      {divider && <hr className="agent-chat-divider agent-room-section-divider" aria-label={t('Group rooms')} />}
      <ul className="agent-contact-list" aria-label={t('Group rooms')}>
        {rows.map((row) => (
          <RoomRow
            key={row.sessionId}
            row={row}
            members={row.room.members.map(label)}
            selected={row.sessionId === selectedSessionId}
            onOpen={() => onOpenSession?.(row.sessionId, row.name, row.sessionId)}
            onOpenMenu={setMenu}
          />
        ))}
      </ul>
      <ScmContextMenu state={menu} onClose={() => setMenu(null)} />
    </>
  );
}

/** "새 대화방": a name and two to six members from the contacts (Mixy too). */
export function NewRoomDialog({ onClose, onCreated }: { onClose(): void; onCreated?: OpenSession }) {
  const titleId = useId();
  const { contacts, label } = useRoomContacts();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = name.trim().length > 0 && picked.length >= ROOM_MIN_MEMBERS && picked.length <= ROOM_MAX_MEMBERS;
  // A contact's line is its job description; the empty-thread placeholder says nothing here.
  const noMessages = t('No messages yet');
  const toggle = (id: string) =>
    setPicked((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      const created = (await window.mixdogDesktop?.agentRoomAction?.('create', [
        { name: name.trim(), members: picked },
      ])) as { sessionId?: string } | undefined;
      onClose();
      if (created?.sessionId) onCreated?.(created.sessionId, name.trim(), created.sessionId);
    } catch (reason) {
      setError(errorMessageText(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SidebarDialogLayer onClose={onClose}>
      <section
        className="schedules-dialog agent-create-dialog agent-room-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <h2 id={titleId}>{t('New group room')}</h2>
          <div className="schedules-dialog-header-actions">
            <button type="button" aria-label={t('Close')} onClick={onClose}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <div className="agent-create-body">
            <div className="agent-room-dialog-hero">
              {picked.length >= ROOM_MIN_MEMBERS ? (
                <RoomAvatar members={picked.map(label)} />
              ) : (
                <span className="agent-room-tile-empty" aria-hidden="true" />
              )}
              <input
                className="agent-create-name"
                name="room-name"
                value={name}
                placeholder={t('Room name')}
                aria-label={t('Room name')}
                // biome-ignore lint/a11y/noAutofocus: the name is the dialog's first field
                autoFocus
                maxLength={80}
                disabled={busy}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </div>
            <section className="agent-create-section">
              <div className="agent-create-field agent-room-invite">
                <span>
                  {t('Invite bots')} · {t('{{count}} selected', { count: picked.length })}
                </span>
                <div className="agent-room-picks">
                  {contacts.map((contact) => {
                    const on = picked.includes(contact.agentId);
                    return (
                      <button
                        key={contact.agentId}
                        type="button"
                        className="agent-room-pick"
                        aria-pressed={on}
                        disabled={busy || (!on && picked.length >= ROOM_MAX_MEMBERS)}
                        onClick={() => toggle(contact.agentId)}
                      >
                        <span className="agent-room-check" aria-hidden="true">
                          {on && <Check size={12} strokeWidth={3} />}
                        </span>
                        <RoomMemberFace member={label(contact.agentId)} />
                        <span>
                          <b>{contact.name}</b>
                          {contact.preview && contact.preview !== noMessages && <small>{contact.preview}</small>}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <small className="agent-room-dialog-tip">
                  {t('{{min}} to {{max}} members; the room face shows the first four.', {
                    min: ROOM_MIN_MEMBERS,
                    max: ROOM_MAX_MEMBERS,
                  })}
                </small>
              </div>
            </section>
          </div>
          <footer>
            {error && <ErrorNotice error={error} />}
            <button type="button" className="secondary" disabled={busy} onClick={onClose}>
              {t('Cancel')}
            </button>
            <button type="submit" disabled={busy || !ready}>
              {t('Create')}
            </button>
          </footer>
        </form>
      </section>
    </SidebarDialogLayer>
  );
}

/** The pane header's "+": a small menu, new agent or new group room. */
export function AgentPaneAddMenu({ onNewAgent, onOpenSession }: { onNewAgent(): void; onOpenSession?: OpenSession }) {
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const label = t('New bot or group room');
  return (
    <>
      <button
        ref={button}
        type="button"
        className="session-panel-action"
        aria-label={label}
        data-tooltip={label}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={() => {
          const rect = button.current?.getBoundingClientRect();
          setMenu({
            label,
            x: rect?.right ?? 0,
            y: rect?.bottom ?? 0,
            alignEnd: true,
            flipY: rect?.top,
            items: [
              { id: 'new-agent', label: t('New bot'), onSelect: onNewAgent },
              { id: 'new-room', label: t('New group room'), onSelect: () => setCreatingRoom(true) },
            ],
          });
        }}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
      <ScmContextMenu state={menu} onClose={() => setMenu(null)} anchorRef={button} />
      {creatingRoom && (
        <NewRoomDialog
          onClose={() => setCreatingRoom(false)}
          onCreated={(sessionId, title, owner) => {
            showDesktopToast(t('Created the room "{{name}}".', { name: title }), 'success');
            onOpenSession?.(sessionId, title, owner);
          }}
        />
      )}
    </>
  );
}
