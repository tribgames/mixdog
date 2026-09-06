/**
 * src/session-runtime/agent-tool-routing.mjs - routes the lead's agent tool
 * through an injected or remote agent-control executor and reads worker/job
 * status for the facade. Extracted from runtime-core.mjs.
 */
import {
  executeRemoteAgentControl,
  remoteAgentControlEnabled,
} from '../standalone/session-runtime-agent-control-client.mjs';

export function createRoutedAgentTool({ rt, agentTool, executeAgentControl = null }) {
  const routedAgentTool = {
    ...agentTool,
    execute(args, context = {}) {
      return typeof executeAgentControl === 'function'
        ? executeAgentControl(args, context)
        : remoteAgentControlEnabled()
        ? executeRemoteAgentControl(args, context)
        : agentTool.execute(args, context);
    },
    closeAll(reason, scope = {}) {
      if (typeof executeAgentControl !== 'function' && !remoteAgentControlEnabled()) {
        return agentTool.closeAll(reason, scope);
      }
      const execute = typeof executeAgentControl === 'function'
        ? executeAgentControl
        : executeRemoteAgentControl;
      void execute({
        type: '__close_all',
        reason: String(reason || 'agent owner closed'),
      }, {
        callerCwd: rt.currentCwd,
        invocationSource: 'runtime-lifecycle',
        callerSessionId: scope?.callerSessionId || rt.session?.id || null,
        clientHostPid: rt.session?.clientHostPid || process.pid,
      }).catch(() => {});
      return undefined;
    },
  };
  const agentStatusState = () => {
    try {
      const status = agentTool.getStatus?.({
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
