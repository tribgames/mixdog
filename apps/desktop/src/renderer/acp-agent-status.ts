// The core's ACP agents as its settings value reports them (`toolModules.acpAgents`), and what a session's route on
// one of them is: read by the Settings row, the model picker, the context controls and the slash commands.
import { useCallback, useMemo, useSyncExternalStore } from 'react';

import type { DesktopModelOption } from '../shared/contract';
import { cachedModelCatalogRevision, cachedModelRow, subscribeCachedModelCatalog } from './model-catalog-cache';
import { modelDisplayName } from './provider-display';
import { record } from './record-utils';
import { windowSectionStore } from './section-store';

export const ACP_AGENT_STATES = [
  'off',
  'checking',
  'installing',
  'updating',
  'notInstalled',
  'versionUnknown',
  'versionTooOld',
  'signedOut',
  'failed',
  'ready',
] as const;

/** A state the core reports; `unknown` is one this app does not know. */
export type AcpAgentState = (typeof ACP_AGENT_STATES)[number] | 'unknown';

export interface AcpAgentStatus {
  id: string;
  label: string;
  /** The provider id a session's route on the agent names. */
  provider: string;
  command: string;
  minimumVersion: string;
  state: AcpAgentState;
  /** The state as the core wrote it. */
  reportedState: string;
  version: string;
  message: string;
  models: Array<{ id: string; name: string }>;
  /** The install or update that failed last; the agent may still work. */
  lastError: { action: 'install' | 'update'; message: string } | null;
  canInstall: boolean;
  canSignIn: boolean;
  /** The plan the agent reports for the signed-in account: the agent names no one. */
  plan: string;
  /** The agent can be signed out from here. */
  canSignOut: boolean;
}

const KNOWN_STATES: ReadonlySet<string> = new Set(ACP_AGENT_STATES);

/** The agents of the settings value's `acpAgents`. */
export function acpAgentsOf(value: unknown): AcpAgentStatus[] {
  const agents = record(value).agents;
  return (Array.isArray(agents) ? agents : []).map(record).flatMap((agent) => {
    const id = String(agent.id || '');
    if (!id) return [];
    const reportedState = String(agent.state ?? '');
    const fault = record(agent.lastError);
    const models = (Array.isArray(agent.models) ? agent.models : []).map(record).flatMap((model) => {
      const modelId = String(model.id || '');
      return modelId ? [{ id: modelId, name: String(model.name || modelId) }] : [];
    });
    return [
      {
        id,
        label: String(agent.label || id),
        provider: String(agent.provider || ''),
        command: String(agent.command || ''),
        minimumVersion: String(agent.minimumVersion || ''),
        state: KNOWN_STATES.has(reportedState) ? (reportedState as AcpAgentState) : 'unknown',
        reportedState,
        version: String(agent.version || ''),
        message: String(agent.message || ''),
        models,
        lastError:
          fault.action === 'install' || fault.action === 'update'
            ? { action: fault.action, message: String(fault.message || '') }
            : null,
        canInstall: agent.canInstall === true,
        canSignIn: agent.canSignIn === true,
        plan: String(agent.plan || ''),
        canSignOut: agent.canSignOut === true,
      },
    ];
  });
}

/** Whether `provider` is an agent's route provider, by the window's settings value as it is now. */
export function agentProvider(provider: string): boolean {
  const acpAgents = record(windowSectionStore()?.get('toolModules')?.value).acpAgents;
  return acpAgentsOf(acpAgents).some((agent) => agent.provider === provider);
}

/** Every control an agent's route has no use for when no model row names them: the agent runs its own reasoning and
 *  model options. Compact applies: the summary becomes the session's context and the agent starts a session on it. */
const AGENT_NOT_APPLICABLE = ['effort', 'autoEffort', 'fast', 'contextWindow', 'fallbacks'];

export interface AgentRoute {
  label: string;
  /** The route's name on the model pill. */
  display: string;
  notApplicable: ReadonlySet<string>;
}

/** The agent a route runs on, decided from the route's provider; null for a provider's model. The model row, when
 *  the catalog still lists it, names the route and its controls; without it the agent's own report does. */
export function agentRouteOf(
  acpAgents: unknown,
  provider: string,
  model: string,
  row?: DesktopModelOption
): AgentRoute | null {
  const agent = provider ? acpAgentsOf(acpAgents).find((entry) => entry.provider === provider) : undefined;
  if (!agent) return null;
  const named = agent.models.find((entry) => entry.id === model)?.name;
  return {
    label: agent.label,
    // A route naming no model runs the agent's default one.
    display: modelDisplayName(model || 'default', provider, row?.display || named),
    notApplicable: new Set(row?.notApplicable ?? AGENT_NOT_APPLICABLE),
  };
}

/** `agentRouteOf` over the window's settings value, following its changes. */
export function useAgentRoute(provider: string, model: string, row?: DesktopModelOption): AgentRoute | null {
  // A route with no provider is no agent's: the settings value is not read for it.
  const store = provider ? windowSectionStore() : undefined;
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe('toolModules', listener) ?? (() => undefined),
    [store]
  );
  const read = () => record(store?.get('toolModules')?.value).acpAgents;
  // A page rendered outside a window (a static render) reads the same held value.
  const acpAgents = useSyncExternalStore(subscribe, read, read);
  // A caller with no row of its own reads the cached catalog's, which also reads a route under an agent's tier id
  // as its model.
  const catalog = useSyncExternalStore(
    subscribeCachedModelCatalog,
    cachedModelCatalogRevision,
    cachedModelCatalogRevision
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `catalog` counts the cached catalog's writes, which is what the cached row follows.
  return useMemo(
    () => agentRouteOf(acpAgents, provider, model, row ?? cachedModelRow(provider, model)),
    [acpAgents, provider, model, row, catalog]
  );
}
