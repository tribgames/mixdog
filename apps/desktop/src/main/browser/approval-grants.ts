import type { DesktopAgentPermission, DesktopCapabilityReadRequest } from '../../shared/contract-capabilities';
import type { DesktopService } from '../desktop-service-contract';
import { MIXY_AGENT_ID } from '../../shared/agent-contacts';
import { agentHomeName } from './approval-requester';

/** Standing "always allow" grants for Browser Use steps, kept where every
 *  other per-bot action permission lives (the host's human-gate store: agent +
 *  action kind, shown and revoked in the bot's profile). Nothing is stored here. */
export function createBrowserApprovalGrants(service: Pick<DesktopService, 'readCapabilities' | 'invokeCapability'>) {
  const read = async (capability: DesktopCapabilityReadRequest['capability'], args: unknown[]): Promise<unknown> => {
    const [result] = await service.readCapabilities([{ capability, args }]);
    if (!result?.ok) throw new Error(result?.error || `${capability} failed`);
    return result.value;
  };
  return {
    listAgents: () => read('listAgents', []),
    /** A home chat's display name: the bot's catalog name, or Mixy's identity name. */
    async agentName(agentId: string): Promise<string> {
      if (agentId !== MIXY_AGENT_ID) return agentHomeName(await read('listAgents', []), agentId);
      const lead = (await read('getLeadStatus', [])) as { name?: unknown } | null;
      return agentHomeName([], agentId, String(lead?.name || ''));
    },
    /** Whether `agentId`'s own mode is `allow` for every one of `actions`. */
    async isAllowed(agentId: string, actions: string[]): Promise<boolean> {
      const rows = (await read('getAgentPermissions', [agentId])) as DesktopAgentPermission[];
      return actions.every((action) => rows.some((row) => row.action === action && row.mode === 'allow'));
    },
    /** Whether `agentId`'s own mode is `block` for any one of `actions`. */
    async isBlocked(agentId: string, actions: string[]): Promise<boolean> {
      const rows = (await read('getAgentPermissions', [agentId])) as DesktopAgentPermission[];
      return actions.some((action) => rows.some((row) => row.action === action && row.mode === 'block'));
    },
    async remember(agentId: string, actions: string[]): Promise<void> {
      for (const action of actions) await service.invokeCapability('setAgentPermission', [agentId, action, 'allow']);
    },
    /** One audit line per action in the host's human-gate log: bot, kind and
     *  decision only (`approve`, `deny`, `granted`, `remembered`). A failed
     *  audit never blocks the approval it describes. */
    async audit(agentId: string, actions: string[], decision: string): Promise<void> {
      for (const action of actions) {
        await service.invokeCapability('recordAgentApprovalAudit', [agentId, action, decision]).catch(() => undefined);
      }
    },
  };
}
