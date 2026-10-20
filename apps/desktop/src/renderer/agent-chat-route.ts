// The agent chat's model chip writes where the agent profile pane does, so
// the two never disagree: Mixy's model is the Main route (the pane's own
// setModelRoute), another agent's is its stored agent route (setAgentRoute,
// which owns model, effort, fast, Auto, model parameters and the context
// window). The chip's session write lands first; this mirrors it onto the
// agent and tells an open profile pane to re-read.
import { MIXY_AGENT_ID, agentIdOfHomeSession } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { roomMemberOfSession } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import type { DesktopApi, DesktopModelSelection } from '../shared/contract';
import { record } from './record-utils';
import { invalidateSidebarReferenceForMutation } from './sidebar-reference-cache';

type RouteApi = Partial<Pick<DesktopApi, 'invokeCapability' | 'setModelRoute'>>;

const listeners = new Set<(agentId: string) => void>();

/** The agent a chat session acts as; '' for a group room's own thread. */
export function agentOfChatSession(sessionId: string): string {
  return agentIdOfHomeSession(sessionId) || roomMemberOfSession(sessionId)?.agentId || '';
}

/** An open profile pane re-reads when the chip changed its agent's route. */
export function subscribeAgentRouteChange(listener: (agentId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function persistAgentChatRoute(
  sessionId: string,
  selection: DesktopModelSelection,
  api: RouteApi | undefined = window.mixdogDesktop
): Promise<boolean> {
  const agentId = agentOfChatSession(sessionId);
  if (!agentId || !selection.provider || !selection.model || !api) return false;
  if (agentId === MIXY_AGENT_ID) {
    await api.setModelRoute?.(selection);
  } else {
    // Picking a model is also the agent's "on" switch: an agent that is off stays off.
    const stored = await api.invokeCapability?.<Record<string, unknown>>({
      capability: 'getAgentDefinition',
      args: [agentId],
    });
    const off = record(stored?.value).disabled === true;
    await api.invokeCapability?.({
      capability: 'setAgentRoute',
      args: [agentId, { ...selection, ...(off ? { disabled: true } : {}) }],
    });
    invalidateSidebarReferenceForMutation('setAgentRoute');
  }
  for (const listener of [...listeners]) listener(agentId);
  return true;
}
