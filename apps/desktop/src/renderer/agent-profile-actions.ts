// The agent actions the profile tab and a contact row's menu share:
// 켜기/끄기 and 삭제, and the chat's 대화 초기화. Deleting and resetting ask first.
import { MIXY_AGENT_ID, agentHomeSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import type { DesktopApi } from '../shared/contract';
import type { AgentContact } from './agent-contacts-model';
import { forgetArchivedBotIdentity } from './archived-bot-identity';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { showDesktopToast } from './notifications';
import type { ScmContextMenuItem } from './ScmContextMenu';
import { invalidateSidebarReferenceForMutation } from './sidebar-reference-cache';

export type AgentActionsApi = Partial<Pick<DesktopApi, 'invokeCapability' | 'resetAgentHome'>>;

export interface AgentActionDeps {
  api?: AgentActionsApi;
  /** Defaults to the window's confirmation dialog (tests stub it). */
  confirm?(message: string): boolean;
}

const ask = (deps: AgentActionDeps, message: string) => (deps.confirm ?? ((text) => window.confirm(text)))(message);

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
  if (!ask(deps, message)) return false;
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
  if (!ask(deps, question)) return false;
  try {
    await api.invokeCapability({ capability: 'deleteAgentDefinition', args: [agentId] });
    invalidateSidebarReferenceForMutation('deleteAgentDefinition');
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

/** A group room row's menu (봇 page and the Sessions 봇 section): the room
 *  panel's own ⋯ actions — 대화 초기화, 방 나가기 (archives it), 방 삭제. */
export function agentRoomMenuItems(
  room: { id: string; running?: unknown },
  deps: AgentActionDeps = {}
): ScmContextMenuItem[] {
  const act = (action: 'leave' | 'remove') =>
    Promise.resolve(window.mixdogDesktop?.agentRoomAction?.(action, [room.id])).catch((reason) =>
      showDesktopToast(errorMessageText(reason), 'error', { scope: `room:${action}:${room.id}` })
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
        if (ask(deps, t('Delete this room and its conversation?'))) void act('remove');
      },
    },
  ];
}

/** A contact row's menu (봇 page and the Sessions 봇 section): 프로필 보기,
 *  끄기, 삭제 (agent mode opens no tabs, so there is no 탭에서 열기). Mixy (the
 *  Lead) is never switched off or deleted. Listed contacts are on
 *  (contactAgentRows), so the toggle reads 끄기. */
export function agentContactMenuItems(
  contact: Pick<AgentContact, 'agentId' | 'name' | 'mixy'>,
  handlers: { onOpen(contact: AgentContact): void; onProfile(contact: AgentContact): void },
  deps: AgentActionDeps = {}
): ScmContextMenuItem[] {
  const row = contact as AgentContact;
  return [
    { id: 'agent-profile', label: t('View profile'), onSelect: () => handlers.onProfile(row) },
    ...(contact.mixy
      ? []
      : [
          {
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
