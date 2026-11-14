import assert from 'node:assert/strict';
import test from 'node:test';

import {
  browserApprovalDecision,
  browserApprovalPrompt,
  subscribeBrowserApprovals,
} from './browser-approval-protocol.ts';

function fakeClient(pending = []) {
  const listeners = new Set();
  const responses = [];
  return {
    responses,
    emit: (event) => listeners.forEach((l) => l(event)),
    listeners,
    failRespond: false,
    pendingServerRequests: () => pending,
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    respond(id, answer) {
      if (this.failRespond) throw new Error('connectionLost');
      responses.push({ id, answer });
    },
  };
}

const browserRequest = (id, request = {}) => ({
  id,
  method: 'item/browser/requestApproval',
  params: { threadId: 't1', surfaceThreadId: 't0', action: 'submit', request, requestedAt: 1, order: 0 },
});

test('choices map to tool approval decisions', () => {
  assert.deepEqual(browserApprovalDecision('once'), { approved: true, remember: 'once' });
  assert.deepEqual(browserApprovalDecision('session'), { approved: true, remember: 'session' });
  assert.deepEqual(browserApprovalDecision('always'), { approved: true, remember: 'always' });
  assert.deepEqual(browserApprovalDecision('deny'), { approved: false });
  assert.deepEqual(browserApprovalDecision('deny', 'no'), { approved: false, reason: 'no' });
});

test('the prompt keeps the card fields and takes the ids from the envelope', () => {
  const prompt = browserApprovalPrompt('a1', {
    action: 'upload',
    threadId: 't1',
    surfaceThreadId: 't0',
    request: {
      url: 'https://x.test/p',
      requester: 'Lead',
      target: 'form',
      paths: ['/a'],
      files: [{ name: 'f', path: '/a/f', size: 3, outside: true }],
      remember: { kinds: ['upload'], session: true },
      payment: true,
    },
  });
  assert.equal(prompt.id, 'a1');
  assert.equal(prompt.sessionId, 't1');
  assert.equal(prompt.surfaceSessionId, 't0');
  assert.equal(prompt.action, 'upload');
  assert.deepEqual(prompt.remember, { kinds: ['upload'], session: true });
  assert.equal(prompt.files[0].outside, true);
  assert.equal(prompt.payment, true);
  const bare = browserApprovalPrompt('a2', { action: 'post', threadId: 't1', request: null });
  assert.equal(bare.remember, null);
  assert.deepEqual(bare.paths, []);
  assert.equal('surfaceSessionId' in bare, false);
});

test('a raised card shows and its answer reaches the core', () => {
  const client = fakeClient([browserRequest('held')]);
  const seen = [];
  subscribeBrowserApprovals(client, (prompt, answer) => seen.push({ prompt, answer }));
  client.emit({ type: 'serverRequest', request: browserRequest('r1', { url: 'u' }) });
  client.emit({ type: 'serverRequest', request: { id: 'other', method: 'item/tool/requestApproval', params: {} } });
  assert.deepEqual(seen.map((s) => s.prompt.id), ['held', 'r1']);
  assert.equal(seen[1].answer('deny', 'because'), true);
  assert.deepEqual(client.responses, [{ id: 'r1', answer: { result: { approved: false, reason: 'because' } } }]);
});

test('an answer that cannot leave reports false', () => {
  const client = fakeClient();
  const seen = [];
  subscribeBrowserApprovals(client, (prompt, answer) => seen.push(answer));
  client.emit({ type: 'serverRequest', request: browserRequest('r1') });
  client.failRespond = true;
  const original = console.error;
  console.error = () => undefined;
  try {
    assert.equal(seen[0]('once'), false);
  } finally {
    console.error = original;
  }
});

test('the core resolving a request elsewhere closes its card; stopping closes the rest', () => {
  const client = fakeClient();
  const closed = [];
  const stop = subscribeBrowserApprovals(client, () => undefined, (id) => closed.push(id));
  client.emit({ type: 'serverRequest', request: browserRequest('r1') });
  client.emit({ type: 'serverRequest', request: browserRequest('r2') });
  client.emit({ type: 'serverRequestResolved', params: { threadId: 't1', requestId: 'r1', resolution: {} } });
  client.emit({ type: 'serverRequestResolved', params: { threadId: 't1', requestId: 'zzz', resolution: {} } });
  assert.deepEqual(closed, ['r1']);
  stop();
  assert.deepEqual(closed, ['r1', 'r2']);
  assert.equal(client.listeners.size, 0);
});
