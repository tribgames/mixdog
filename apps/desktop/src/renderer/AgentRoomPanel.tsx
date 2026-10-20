// A group room's right-hand panel (the phone's member sheet): its members
// (add, remove), this room's limits (round and message caps, tool-output
// sharing); reset/leave/delete ride the dock header's ⋯ menu. Built from the
// connection-settings rows and the settings switch, like the Routines tile.
import { LogOut, Minus, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import {
  ROOM_LIMITS,
  ROOM_MAX_MEMBERS,
  ROOM_MIN_MEMBERS,
} from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import type { DesktopAgentRoomSummary } from '../shared/contract';
import { confirmAction } from './app-confirm';
import { RoomAvatar, RoomMemberFace, useRoomContacts } from './agent-room-parts';
import { useAgentRoom } from './agent-room-store';
import { closeRoomTabs, resetConversation } from './agent-profile-actions';
import { usePublishDockPanelActions } from './dock-panel-actions';
import type { DockAction } from './pane-dock-chrome';
import { showDesktopToast } from './desktop-toasts';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { InitialSurface } from './InitialSurface';
import { CompactSwitch } from './settings/capability-controls';
import './settings/settings.css';
import './routines.css';

type LimitKey = 'maxRounds' | 'maxMessages';

function Stepper({
  label,
  value,
  limit,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  limit: LimitKey;
  disabled: boolean;
  onChange(value: number): void;
}) {
  const { min, max } = ROOM_LIMITS[limit];
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings its own border and padding into the row
    <span className="agent-room-stepper" role="group" aria-label={label}>
      <button
        type="button"
        className="agent-room-icon-button"
        aria-label={t('Decrease')}
        disabled={disabled || value <= min}
        onClick={() => onChange(value - 1)}
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <b aria-live="polite">{value}</b>
      <button
        type="button"
        className="agent-room-icon-button"
        aria-label={t('Increase')}
        disabled={disabled || value >= max}
        onClick={() => onChange(value + 1)}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
    </span>
  );
}

function RoomPanelBody({ room, leafId, active }: { room: DesktopAgentRoomSummary; leafId?: string; active: boolean }) {
  const { contacts, label } = useRoomContacts(true, room.memberNames);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const act = async (action: string, args: unknown[]): Promise<boolean> => {
    setBusy(true);
    try {
      await window.mixdogDesktop?.agentRoomAction?.(action, args);
      return true;
    } catch (error) {
      showDesktopToast(errorMessageText(error), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const update = (patch: Record<string, unknown>) => void act('update', [room.id, patch]);
  const closeRoom = async (action: 'leave' | 'remove') => {
    if (await act(action, [room.id])) closeRoomTabs(room.id);
  };
  const closeRoomRef = useRef(closeRoom);
  closeRoomRef.current = closeRoom;
  const running = Boolean(room.running);
  const headerActions = useMemo<DockAction[]>(
    () => [
      {
        id: 'room-reset',
        label: t('Reset conversation'),
        icon: RotateCcw,
        disabled: busy,
        onSelect: () => {
          setBusy(true);
          void resetConversation(
            {},
            {
              scope: `room:reset:${room.id}`,
              running,
              reset: async () => window.mixdogDesktop?.agentRoomAction?.('reset', [room.id]),
            }
          ).finally(() => setBusy(false));
        },
      },
      {
        id: 'room-leave',
        label: t('Leave room'),
        icon: LogOut,
        disabled: busy,
        onSelect: () => void closeRoomRef.current('leave'),
      },
      {
        id: 'room-delete',
        label: t('Delete room'),
        icon: Trash2,
        danger: true,
        separatorBefore: true,
        disabled: busy,
        onSelect: () => {
          void confirmAction(t('Delete this room and its conversation?'), {
            key: `room-delete:${room.id}`,
            danger: true,
            confirmLabel: t('Delete'),
          }).then((approved) => {
            if (approved) return closeRoomRef.current('remove');
          });
        },
      },
    ],
    [busy, running, room.id]
  );
  usePublishDockPanelActions(leafId, active, headerActions);
  const members = room.members.map(label);
  const invitable = contacts.filter((contact) => !room.members.includes(contact.agentId));
  // A setting row, as on the Routines tab: the text takes the full width and
  // wraps; the control sits on its own line under it, on the same left edge.
  const setting = (title: string, description: string, control: ReactNode) => (
    <div className="conn-row agent-room-setting">
      <div className="conn-row-text">
        <div className="conn-row-title">
          <b>{title}</b>
        </div>
        <div className="conn-row-meta">{description}</div>
      </div>
      <div className="conn-row-actions">{control}</div>
    </div>
  );
  return (
    <div className="agent-profile agent-room-panel-body">
      <div className="agent-profile-hero">
        <span className="agent-profile-face">
          <RoomAvatar members={members} className="agent-profile-avatar" />
        </span>
        <b className="agent-profile-name">{room.name}</b>
        <p className="agent-profile-description">{t('{{count}} members', { count: members.length })}</p>
      </div>
      <section className="conn-group">
        <div className="conn-group-head">
          <h4>
            {t('Members')}
            <span>{members.length}</span>
          </h4>
          <button
            type="button"
            className="conn-btn conn-btn--sm"
            aria-expanded={adding}
            disabled={busy || members.length >= ROOM_MAX_MEMBERS || invitable.length === 0}
            onClick={() => setAdding((open) => !open)}
          >
            {t('Add')}
          </button>
        </div>
        <div className="conn-list">
          {members.map((member) => (
            <div key={member.id} className="agent-room-member">
              <RoomMemberFace member={member} />
              <span>{member.name}</span>
              <button
                type="button"
                className="agent-room-icon-button"
                aria-label={t('Remove {{name}}', { name: member.name })}
                disabled={busy || members.length <= ROOM_MIN_MEMBERS}
                onClick={() => update({ members: room.members.filter((id) => id !== member.id) })}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
        {adding && (
          <div className="conn-list agent-room-picks">
            {invitable.map((contact) => (
              <button
                key={contact.agentId}
                type="button"
                className="agent-room-pick"
                disabled={busy}
                onClick={() => {
                  setAdding(false);
                  update({ members: [...room.members, contact.agentId] });
                }}
              >
                <RoomMemberFace member={label(contact.agentId)} />
                <span>
                  <b>{contact.name}</b>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="conn-group">
        <div className="conn-group-head">
          <h4>{t('Safety limits')}</h4>
        </div>
        <div className="conn-list">
          {setting(
            t('Turns per message'),
            t('After you speak once, the bots go around at most this many times.'),
            <Stepper
              label={t('Turns per message')}
              value={room.maxRounds}
              limit="maxRounds"
              disabled={busy}
              onChange={(value) => update({ maxRounds: value })}
            />
          )}
          {setting(
            t('Replies at a time'),
            t('Past this number, the room stops and asks whether to continue.'),
            <Stepper
              label={t('Replies at a time')}
              value={room.maxMessages}
              limit="maxMessages"
              disabled={busy}
              onChange={(value) => update({ maxMessages: value })}
            />
          )}
          {setting(
            t("See each other's work"),
            t('On: bots also see the tool results the others got.'),
            <CompactSwitch
              label={t("See each other's work")}
              checked={room.shareTools}
              disabled={busy}
              onChange={(value) => update({ shareTools: value })}
            />
          )}
        </div>
      </section>
    </div>
  );
}

export function AgentRoomPanel({
  sessionId,
  active,
  leafId,
}: {
  sessionId: string;
  active: boolean;
  /** The pane whose dock header carries this panel's ⋯ actions. */
  leafId?: string;
}) {
  const room = useAgentRoom(sessionId);
  return (
    <div className="agent-room-panel" hidden={!active || undefined}>
      {room ? <RoomPanelBody room={room} leafId={leafId} active={active} /> : <InitialSurface />}
    </div>
  );
}
