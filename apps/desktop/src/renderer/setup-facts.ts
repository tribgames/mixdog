// What the user has set up so far, read from the app's own state: the starter
// guide's provider step and the primary agent's welcome greeting (its facts
// block, agent-greeting.ts) share it.
import { contactAgentRows } from '../shared/agent-contacts';
import type { DesktopApi } from '../shared/contract';
import { record, rows } from './record-utils';
import { getCachedConnectionInfo } from './settings/connection-info';

export function providerConnected(setup: unknown): boolean {
  const value = record(setup);
  return [...rows(value.api), ...rows(value.oauth)].some(
    (provider) => provider.usable === true || provider.authenticated === true
  );
}

type FactsApi = Partial<Pick<DesktopApi, 'invokeCapability' | 'listProjects'>> | undefined;

/** One line per setup item; an unreadable item says so instead of guessing. */
export async function mixyGreetingFacts(api: FactsApi): Promise<string[]> {
  const read = async (capability: string) => {
    try {
      return (await api?.invokeCapability?.({ capability: capability as never, args: [] }))?.value;
    } catch {
      return undefined;
    }
  };
  const [setup, onboarding, mcp, plugins, agents, projects] = await Promise.all([
    read('getProviderSetup'),
    read('getOnboardingStatus'),
    read('mcpStatus'),
    read('pluginsStatus'),
    read('listAgents'),
    Promise.resolve(api?.listProjects?.()).catch(() => undefined),
  ]);
  const unknown = 'unknown';
  const guideVisited = record(record(onboarding).starterGuide).visited;
  const visited: unknown[] = Array.isArray(guideVisited) ? guideVisited : [];
  const connected = Number(record(mcp).connectedCount);
  const enabledPlugins = rows(record(plugins).plugins).filter((plugin) => plugin.enabled === true).length;
  const clients = api ? (getCachedConnectionInfo(api as DesktopApi)?.clients?.length ?? 0) : 0;
  return [
    `Model provider: ${setup === undefined ? unknown : providerConnected(setup) ? 'connected' : 'not connected'}`,
    `Projects added: ${Array.isArray(projects) ? projects.length : unknown}`,
    `Workflows and agents tour: ${onboarding === undefined ? unknown : visited.includes('workflow') ? 'done' : 'not done'}`,
    `Remote access (phone): ${clients > 0 ? 'a device is paired' : 'no device paired'}`,
    `Connectors (MCP servers) connected: ${mcp === undefined ? unknown : Number.isFinite(connected) ? connected : 0}`,
    `Plugins enabled: ${plugins === undefined ? unknown : enabledPlugins}`,
    `Other agents: ${agents === undefined ? unknown : contactAgentRows(agents).length}`,
  ];
}
