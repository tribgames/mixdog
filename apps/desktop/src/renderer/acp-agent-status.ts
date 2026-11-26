// The core's ACP agents as its settings value reports them (`toolModules.acpAgents`), and what a session's route on
// one of them is: read by the Settings row, the model picker, the context controls and the slash commands.
import { useCallback, useMemo, useSyncExternalStore } from 'react';

import type { DesktopModelOption } from '../shared/contract';
import { cachedModelCatalogRevision, cachedModelRow, subscribeCachedModelCatalog } from './model-catalog-cache';
import { agentServiceProvider, modelDisplayName } from './provider-display';
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
  'unsupported',
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
  /** The core's sign-in opens the browser on its own machine. */
  loginOpensBrowser: boolean;
  /** A browser on another machine pastes the address the sign-in page ended on, not a code the page showed. */
  loginTakesRedirect: boolean;
  /** The agent's sign-in is the one its CLI uses outside Mixdog. */
  sharesExternalSignIn: boolean;
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
        loginOpensBrowser: agent.loginOpensBrowser === true,
        loginTakesRedirect: agent.loginTakesRedirect === true,
        // A core that does not say is one whose only agent was the CLI.
        sharesExternalSignIn: agent.sharesExternalSignIn !== false,
      },
    ];
  });
}

/** One agent as the user sees it: the presets the core runs for one service (its official server and its CLI). */
export interface AcpAgentGroup {
  /** The members as one agent: the state they combine to, told in the words of the member it comes from. */
  agent: AcpAgentStatus;
  /** In the core's order. */
  members: AcpAgentStatus[];
  /** The members that run here and are ready, each with the account it is signed in with: a sibling in another state
   *  hides none of them. */
  ready: AcpAgentStatus[];
  /** Beside a ready member, every other member that runs here, each with its own state and next step. */
  pending: AcpAgentStatus[];
}

/** Which member's state the group shows: the work under way, then what stops it, then what keeps it short of
 *  ready; it is ready when every member is. */
const GROUP_STATE_ORDER: readonly AcpAgentState[] = [
  'installing',
  'updating',
  'checking',
  'unknown',
  'failed',
  'notInstalled',
  'versionUnknown',
  'versionTooOld',
  'signedOut',
  'off',
  'ready',
];

function groupAgent(members: AcpAgentStatus[]): AcpAgentStatus {
  // A member that cannot run on this computer leaves the agent to the others.
  const usable = members.filter((member) => member.state !== 'unsupported');
  const telling = GROUP_STATE_ORDER.flatMap((state) => usable.filter((member) => member.state === state))[0];
  const [first] = members;
  // The row offers what the members in its own state can do: a sibling in another state lends it no action.
  const shown = telling ? usable.filter((member) => member.state === telling.state) : [];
  return {
    ...(telling ?? first),
    id: first.id,
    label: first.label,
    provider: first.provider,
    models: members.flatMap((member) => member.models),
    lastError: shown.find((member) => member.lastError)?.lastError ?? null,
    canInstall: shown.some((member) => member.canInstall),
    canSignIn: shown.some((member) => member.canSignIn),
    plan: usable.find((member) => member.plan)?.plan ?? '',
    canSignOut: usable.some((member) => member.canSignOut),
  };
}

/** The agents of the settings value's `acpAgents` as the user sees them: the presets of one service are one agent. */
export function acpAgentGroups(value: unknown): AcpAgentGroup[] {
  const groups = new Map<string, AcpAgentStatus[]>();
  for (const agent of acpAgentsOf(value)) {
    const key = agentServiceProvider(agent.provider) ?? agent.id;
    groups.set(key, [...(groups.get(key) ?? []), agent]);
  }
  return [...groups.values()].map((members) => {
    const usable = members.filter((member) => member.state !== 'unsupported');
    const ready = usable.filter((member) => member.state === 'ready');
    const pending = ready.length ? usable.filter((member) => member.state !== 'ready') : [];
    return { agent: groupAgent(members), members, ready, pending };
  });
}

/** Whether `provider` is an agent's route provider, by the window's settings value as it is now. */
export function agentProvider(provider: string): boolean {
  const acpAgents = record(windowSectionStore()?.get('toolModules')?.value).acpAgents;
  return acpAgentsOf(acpAgents).some((agent) => agent.provider === provider);
}

/** Every control an agent's route has no use for when no model row names them: the agent runs its own reasoning and
 *  model options. The context window applies, below the size the agent reports, and so does Compact: the summary
 *  becomes the session's context and the agent starts a session on it. */
const AGENT_NOT_APPLICABLE = ['effort', 'autoEffort', 'fast', 'fallbacks'];

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
