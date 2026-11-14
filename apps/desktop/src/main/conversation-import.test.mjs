import assert from 'node:assert/strict';
import test from 'node:test';

import { requiredDesktopCapabilityRequest } from './ipc-validation.ts';

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
