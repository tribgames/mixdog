/**
 * src/session-runtime/agent-tool-routing.mjs - routes the lead's agent tool
 * through an injected agent-control executor and reads worker/job
 * status for the facade.
 */

export function createRoutedAgentTool({ rt, agentTool, executeAgentControl = null }) {
  const routedAgentTool = {
    ...agentTool,
    execute(args, context = {}) {
      if (typeof executeAgentControl === 'function') return executeAgentControl(args, context);
      return agentTool.execute(args, context);
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
