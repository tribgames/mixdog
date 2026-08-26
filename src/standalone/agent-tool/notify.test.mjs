import assert from 'node:assert/strict';
import test from 'node:test';

import { createNotify } from './notify.mjs';

test('Subagent tool completion stays in the worker session', () => {
  const queued = [];
  const ownerDeliveries = [];
  const { workerNotifyFn } = createNotify({
    enqueuePendingMessage(sessionId, message) {
      queued.push({ sessionId, message });
      return 1;
    },
  }, {
    notifySessionCompletion(sessionId, text, meta) {
      ownerDeliveries.push({ sessionId, text, meta });
      return true;
    },
  });

  const delivered = workerNotifyFn('sess_worker', {
    callerSessionId: 'sess_lead',
  })(
    'Async shell task job_test (completed, exit 0) finished.\n\nresult',
    {
      type: 'shell_task_result',
      execution_surface: 'shell',
      execution_id: 'job_test',
      status: 'completed',
    },
  );

  assert.equal(delivered, true);
  assert.equal(ownerDeliveries.length, 0);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].sessionId, 'sess_worker');
});
