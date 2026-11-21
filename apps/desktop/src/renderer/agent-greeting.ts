import { agentGreetingKickoff } from '../shared/agent-greeting';
import type { DesktopPromptContent, DesktopSubmitOptions } from '../shared/contract';
import { resolveUiLanguage } from './i18n';

export { agentGreetingKickoff };

export interface AgentGreetingApi {
  openAgentHome?(agentId: string): Promise<{ sessionId: string }>;
  submitToSession(sessionId: string, prompt: DesktopPromptContent, options?: DesktopSubmitOptions): Promise<boolean>;
}

/** Opens the new agent's home thread and starts its greeting turn; returns
 *  the thread's session id ('' when the host has no home threads). */
export async function greetNewAgent(
  api: AgentGreetingApi,
  agent: {
    id: string;
    name: string;
    description: string;
    mixy?: boolean;
    facts?: readonly string[];
    /** False for an agent without a model: its thread opens without the kickoff. */
    greet?: boolean;
  }
): Promise<string> {
  const sessionId = (await api.openAgentHome?.(agent.id))?.sessionId ?? '';
  if (!sessionId || agent.greet === false) return sessionId;
  await api.submitToSession(
    sessionId,
    agentGreetingKickoff({
      name: agent.name,
      description: agent.description,
      language: resolveUiLanguage(),
      mixy: agent.mixy === true,
      facts: agent.facts,
    }),
    { kickoff: true }
  );
  return sessionId;
}
