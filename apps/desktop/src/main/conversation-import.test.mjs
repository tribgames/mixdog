import assert from 'node:assert/strict';
import test from 'node:test';

import { requiredDesktopCapabilityRequest } from './ipc-validation.ts';
import { createConversationImportProgress } from './conversation-import-progress.ts';

const request = (capability, args) => requiredDesktopCapabilityRequest({ capability, args });

test('import capabilities take exactly one well-formed object argument', () => {
  assert.doesNotThrow(() => request('listImportableConversations', [{ source: 'codex', limit: 50 }]));
  assert.throws(() => request('listImportableConversations', [{ source: 'other' }]), TypeError);
  assert.throws(() => request('listImportableConversations', [{ source: 'codex', limit: 500 }]), TypeError);
  assert.throws(() => request('listImportableConversations', ['codex']), TypeError);
  assert.throws(() => request('listImportableConversations', [{ source: 'codex' }, {}]), TypeError);
  assert.doesNotThrow(() => request('getConversationImportJobs', [{}]));
  assert.doesNotThrow(() => request('registerConversationImportFile', [{ source: 'claude', path: 'C:\\a.jsonl' }]));
  assert.throws(() => request('registerConversationImportFile', [{ source: 'claude' }]), TypeError);
  assert.doesNotThrow(() => request('startConversationImport', [{ requestId: 'r', selection: { ids: ['a'] } }]));
  assert.doesNotThrow(() =>
    request('startConversationImport', [{ requestId: 'r', selection: { viewId: 'v', excludeIds: [] } }])
  );
  assert.throws(() => request('startConversationImport', [{ requestId: 'r', selection: { ids: 'a' } }]), TypeError);
  assert.throws(() => request('startConversationImport', [{ requestId: 'r', selection: {} }]), TypeError);
  assert.doesNotThrow(() => request('cancelConversationImport', [{ jobId: 'j' }]));
  assert.throws(() => request('cancelConversationImport', [{}]), TypeError);
});

test('progress polling publishes only changed snapshots and stops when the job ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // One poll interval of fake time, then the microtask-only poll settles.
  const pollOnce = async () => {
    t.mock.timers.tick(5);
    await new Promise((resolve) => setImmediate(resolve));
  };
  const published = [];
  let state = { jobId: 'j', seq: 1, state: 'running', processed: 0 };
  const progress = createConversationImportProgress({
    fetchJobs: async () => [state],
    publish: (name, value) => published.push([name, value.seq]),
    intervalMs: 5,
  });
  progress.observe('startConversationImport', state);
  await pollOnce();
  assert.deepEqual(published, [['conversation-import-progress', 1]]);
  state = { ...state, seq: 2, processed: 1 };
  await pollOnce();
  state = { ...state, seq: 3, state: 'completed', processed: 2 };
  await pollOnce();
  assert.deepEqual(
    published.map(([, seq]) => seq),
    [1, 2, 3]
  );
  const count = published.length;
  await pollOnce();
  assert.equal(published.length, count);
  progress.dispose();
});
