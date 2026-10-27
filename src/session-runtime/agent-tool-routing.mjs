/**
 * src/session-runtime/agent-tool-routing.mjs - routes the lead's agent tool
 * through an injected agent-control executor and reads worker/job
 * status for the facade.
 */

import { clean } from '../runtime/shared/clean.mjs';
import { resolveRequestedModel } from './services/agent-tool/model-select.mjs';

// `listProviderModels` is this runtime's provider catalog. The agent control
// behind `executeAgentControl` (the daemon's canonical agent) has none, so a
// pinned model is resolved here, by the same rule the in-process agent tool
// applies (exact id, display name, then every query word; ambiguous or
// unknown names fail with candidates), and forwarded as the exact route.
export function createRoutedAgentTool({ rt, agentTool, executeAgentControl = null, listProviderModels = null }) {
  const routedAgentTool = {
    ...agentTool,
    async execute(args, context = {}) {
      if (typeof executeAgentControl !== 'function') return agentTool.execute(args, context);
      const routedArgs =
        typeof listProviderModels === 'function' && clean(args?.model) && (clean(args.type) || 'spawn') === 'spawn'
          ? await resolveRequestedModel(args, listProviderModels)
          : args;
      return executeAgentControl(routedArgs, context);
    },
    closeAll(reason, scope = {}) {
      if (typeof executeAgentControl !== 'function') {
        return agentTool.closeAll(reason, scope);
      }
      // The promise is returned so teardown can wait for closing to finish
      // producing its final index writes before it drains them.
      return Promise.resolve(
        executeAgentControl(
          {
            type: '__close_all',
            reason: String(reason || 'agent owner closed'),
            ...(scope?.processExit === true ? { processExit: true } : {}),
          },
          {
            callerCwd: rt.currentCwd,
            invocationSource: 'runtime-lifecycle',
            callerSessionId: scope?.callerSessionId || rt.session?.id || null,
            clientHostPid: rt.session?.clientHostPid || process.pid,
          }
        )
      ).then(
        () => undefined,
        () => undefined
      );
    },
  };
  const agentStatusState = () => {
    try {
      const status =
        agentTool.getStatus?.({
          callerSessionId: rt.session?.id || null,
          clientHostPid: rt.session?.clientHostPid || process.pid,
        }) || {};
      return {
        agentWorkers: Array.isArray(status.workers) ? status.workers : [],
        agentJobs: Array.isArray(status.jobs) ? status.jobs : [],
        agentScope: status.scope || null,
      };
    } catch {
      return { agentWorkers: [], agentJobs: [], agentScope: null };
    }
  };
  return { routedAgentTool, agentStatusState };
}
