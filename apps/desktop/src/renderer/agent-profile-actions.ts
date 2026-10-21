// The agent actions the profile tab and a contact row's menu share:
// 켜기/끄기 and 삭제, and the chat's 대화 초기화. Deleting and resetting ask first.
import { MIXY_AGENT_ID, agentHomeSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { roomSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import type { DesktopApi } from '../shared/contract';
import { confirmAction } from './app-confirm';
import type { AgentContact } from './agent-contacts-model';
import { forgetArchivedBotIdentity } from './archived-bot-identity';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { showDesktopToast } from './notifications';
import type { ScmContextMenuItem } from './ScmContextMenu';
import { setBotHiddenInSidebar, sidebarHiddenBots } from './sidebar-hidden-bots-store';
import { invalidateSidebarReferenceForMutation } from './sidebar-reference-cache';

export type AgentActionsApi = Partial<Pick<DesktopApi, 'invokeCapability' | 'resetAgentHome'>>;

export interface AgentActionDeps {
  api?: AgentActionsApi;
  /** Defaults to the app's themed confirm dialog (tests stub it). */
  confirm?(message: string): boolean | Promise<boolean>;
}

const ask = (deps: AgentActionDeps, message: string, confirmLabel: string, key: string): boolean | Promise<boolean> =>
  deps.confirm ? deps.confirm(message) : confirmAction(message, { danger: true, confirmLabel, key });

/** Switch a (non-Mixy) agent on or off; its model stays stored either way. */
export async function setAgentOn(deps: AgentActionDeps, agentId: string, on: boolean): Promise<boolean> {
  const api = deps.api ?? window.mixdogDesktop;
  if (agentId === MIXY_AGENT_ID || !api?.invokeCapability) return false;
  try {
    await api.invokeCapability({ capability: 'setAgentRoute', args: [agentId, { disabled: !on }] });
    invalidateSidebarReferenceForMutation('setAgentRoute');
    return true;
  } catch (reason) {
    showDesktopToast(errorMessageText(reason), 'error', { scope: `agent:toggle:${agentId}` });
    return false;
  }
}

/** "대화 초기화" of an agent chat (a home or a room): asks first, and is
 *  refused while the chat is replying. `reset` starts it over on the host
 *  (resetAgentHome / the room's `reset`), whose old conversation stays in the
 *  archived sessions. */
export async function resetConversation(
  deps: AgentActionDeps,
  { scope, running, reset }: { scope: string; running: boolean; reset(): Promise<unknown> }
): Promise<boolean> {
  if (running) {
    showDesktopToast(t('Wait for the reply to finish, then reset the conversation.'), 'info', { scope });
    return false;
  }
  const message = t(
    "Reset the conversation? The earlier messages leave this conversation; the bot's memory, routines and settings stay as they are."
  );
  if (!(await ask(deps, message, t('Reset'), `agent-reset:${scope}`))) return false;
  try {
    const result = (await reset()) as { archivedSessionId?: unknown } | null | undefined;
    showDesktopToast(
      result?.archivedSessionId
        ? t('Conversation reset. The earlier one is kept in Archived sessions.')
        : t('Conversation reset.'),
      'success',
      { scope }
    );
    return true;
  } catch (reason) {
    showDesktopToast(errorMessageText(reason), 'error', { scope });
    return false;
  }
}

/** Fired on this window when the user deleted a bot here: its chat's tabs close. */
export const BOT_DELETED_EVENT = 'mixdog:bot-deleted';

/** Delete a (non-Mixy) agent: the host archives its chat under its name and
 *  switches off its routines (agent-home-sessions.ts); its open tabs close. */
export async function deleteAgent(deps: AgentActionDeps, agentId: string, name: string): Promise<boolean> {
  const api = deps.api ?? window.mixdogDesktop;
  if (agentId === MIXY_AGENT_ID || !api?.invokeCapability) return false;
  const question = t(
    'Delete {{name}}? The bot is archived with its chat, and all its routines stop. Delete it again from Archived to remove it for good.',
    { name }
  );
  if (!(await ask(deps, question, t('Delete'), `agent-delete:${agentId}`))) return false;
  try {
    await api.invokeCapability({ capability: 'deleteAgentDefinition', args: [agentId] });
    invalidateSidebarReferenceForMutation('deleteAgentDefinition');
    setBotHiddenInSidebar(agentId, false); // a deleted bot leaves no stale hidden flag
    window.dispatchEvent(new CustomEvent(BOT_DELETED_EVENT, { detail: { sessionId: agentHomeSessionId(agentId) } }));
    showDesktopToast(t('Deleted bot "{{id}}".', { id: name }), 'success');
    return true;
  } catch (reason) {
    showDesktopToast(errorMessageText(reason), 'error', { scope: `agent:delete:${agentId}` });
    return false;
  }
}

/** 복원 of a deleted bot's archived chat: the bot comes back as it was under
 *  its own id and its chat leaves 보관됨; its routines stay off. */
export async function restoreAgent(deps: AgentActionDeps, agentId: string, name: string): Promise<boolean> {
  const api = deps.api ?? window.mixdogDesktop;
  if (agentId === MIXY_AGENT_ID || !api?.invokeCapability) return false;
  try {
    await api.invokeCapability({ capability: 'restoreAgentDefinition', args: [agentId] });
    invalidateSidebarReferenceForMutation('restoreAgentDefinition');
    forgetArchivedBotIdentity(agentId);
    showDesktopToast(t('Restored bot "{{name}}". Its routines stay off until you turn them on.', { name }), 'success');
    return true;
  } catch (reason) {
    showDesktopToast(errorMessageText(reason), 'error', { scope: `agent:restore:${agentId}` });
    return false;
  }
}

/** Close every open tab of a room's conversation (it was left or deleted). */
export function closeRoomTabs(roomId: string): void {
  window.dispatchEvent(new CustomEvent(BOT_DELETED_EVENT, { detail: { sessionId: roomSessionId(roomId) } }));
}

/** A group room row's menu (봇 page and the Sessions 봇 section): the room
 *  panel's own ⋯ actions — 대화 초기화, 방 나가기 (archives it), 방 삭제. */
export function agentRoomMenuItems(
  room: { id: string; running?: unknown },
  deps: AgentActionDeps = {}
): ScmContextMenuItem[] {
  // A room that was left or deleted no longer has a conversation: its open
  // tabs close, so no pane is left on a session that is gone.
  const act = (action: 'leave' | 'remove') =>
    Promise.resolve(window.mixdogDesktop?.agentRoomAction?.(action, [room.id])).then(
      () => closeRoomTabs(room.id),
      (reason) => showDesktopToast(errorMessageText(reason), 'error', { scope: `room:${action}:${room.id}` })
    );
  return [
    {
      id: 'room-reset',
      label: t('Reset conversation'),
      onSelect: () =>
        void resetConversation(deps, {
          scope: `room:reset:${room.id}`,
          running: Boolean(room.running),
          reset: async () => window.mixdogDesktop?.agentRoomAction?.('reset', [room.id]),
        }),
    },
    { id: 'room-leave', label: t('Leave room'), onSelect: () => void act('leave') },
    {
      id: 'room-delete',
      label: t('Delete room'),
      danger: true,
      separatorBefore: true,
      onSelect: () => {
        void Promise.resolve(
          ask(deps, t('Delete this room and its conversation?'), t('Delete'), `room-delete:${room.id}`)
        ).then((approved) => {
          if (approved) return act('remove');
        });
      },
    },
  ];
}

/** A contact row's menu (agent mode opens no tabs, so there is no 탭에서 열기).
 *  The Sessions 봇 section (`surface: 'sidebar'`): 프로필 보기, 목록에서 숨기기 —
 *  the bot only leaves that list. The 봇 page: 프로필 보기, 사이드바에 표시 (only
 *  while the bot is hidden there), 끄기, 삭제. Mixy (the Lead) is never switched
 *  off or deleted. The toggle reads 끄기, or 켜기 on a switched-off bot. */
export function agentContactMenuItems(
  contact: Pick<AgentContact, 'agentId' | 'name' | 'mixy'> & { disabled?: boolean },
  handlers: { onOpen(contact: AgentContact): void; onProfile(contact: AgentContact): void },
  deps: AgentActionDeps = {},
  surface: 'page' | 'sidebar' = 'page'
): ScmContextMenuItem[] {
  const row = contact as AgentContact;
  const profile = { id: 'agent-profile', label: t('View profile'), onSelect: () => handlers.onProfile(row) };
  if (surface === 'sidebar') {
    return [
      profile,
      {
        id: 'agent-hide-from-list',
        label: t('Hide from list'),
        onSelect: () => setBotHiddenInSidebar(contact.agentId, true),
      },
    ];
  }
  return [
    profile,
    ...(sidebarHiddenBots().has(contact.agentId)
      ? [
          {
            id: 'agent-show-in-sidebar',
            label: t('Show in sidebar'),
            onSelect: () => setBotHiddenInSidebar(contact.agentId, false),
          },
        ]
      : []),
    ...(contact.mixy
      ? []
      : [
          contact.disabled
            ? {
                id: 'agent-turn-on',
                label: t('Turn on'),
                onSelect: () => void setAgentOn(deps, contact.agentId, true),
              }
            : {
                id: 'agent-turn-off',
                label: t('Turn off'),
                onSelect: () => void setAgentOn(deps, contact.agentId, false),
              },
          {
            id: 'agent-delete',
            label: t('Delete'),
            danger: true,
            onSelect: () => void deleteAgent(deps, contact.agentId, contact.name),
          },
        ]),
  ];
}
