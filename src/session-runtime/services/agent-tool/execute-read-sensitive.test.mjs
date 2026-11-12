// The agent tool's `read` of a worker with no task reads the worker's own text off its session: its sensitive values
// come back as the marker, as its report does.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentExecute } from './execute.mjs';
import { rememberSensitiveValues } from '../../../runtime/agent/orchestrator/session/sensitive-values.mjs';

const CODE = '482913';

function executeOver(handoff) {
  const job = { taskId: null, meta: { sessionId: 'read-worker' }, result: `fallback ${CODE}` };
  const views = { getJobOrWorker: () => ({ ...job, meta: { ...job.meta } }), renderJob: (shown) => shown };
  return createAgentExecute({
    mgr: { readSessionHandoff: async () => handoff },
    defaultCwd: '',
    awaitKeychainPrewarm: async () => {},
    registry: { resolveTombstoneOwners() {} },
    views,
    spawnFlow: {},
    sendFlow: {},
    closeFlow: {},
    terminalTrace: null,
  });
}

test('a read of a worker has its sensitive values as the marker, handoff or fallback', async () => {
  rememberSensitiveValues('read-worker', [{ name: 'browser', arguments: { action: 'fill', input: { sensitive: true, text: CODE } } }]);
  for (const handoff of [`handoff ${CODE}`, '']) {
    const shown = String(await executeOver(handoff)({ type: 'read', sessionId: 'read-worker' }, {}));
    assert.ok(!shown.includes(CODE), shown);
    assert.ok(shown.includes('[redacted]'), shown);
  }
});
