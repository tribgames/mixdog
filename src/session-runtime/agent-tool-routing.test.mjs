import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoutedAgentTool } from './agent-tool-routing.mjs';

function routed() {
  const calls = [];
  const { routedAgentTool } = createRoutedAgentTool({
    rt: { currentCwd: '/work', session: { id: 'sess_lead', clientHostPid: 7 } },
    agentTool: {},
    executeAgentControl: async (args, context) => {
      calls.push({ args, context });
    },
  });
  return { routedAgentTool, calls };
}

test('a process-exit closeAll reaches the agent control as one, so the rows survive the exit', async () => {
  const { routedAgentTool, calls } = routed();
  await routedAgentTool.closeAll('SIGTERM', { processExit: true });
  assert.deepEqual(calls[0].args, { type: '__close_all', reason: 'SIGTERM', processExit: true });
  assert.equal(calls[0].context.callerSessionId, 'sess_lead');
});

test('any other closeAll stays a plain close', async () => {
  const { routedAgentTool, calls } = routed();
  await routedAgentTool.closeAll('agent owner closed');
  assert.deepEqual(calls[0].args, { type: '__close_all', reason: 'agent owner closed' });
});
