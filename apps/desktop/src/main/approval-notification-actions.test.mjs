// A phone notification's Allow / Deny reaches the host as
// answerApprovalNotification. The host, not the phone, decides what an Allow
// may answer: only the approval the session shows now, and only where this
// PC's card allows it once with a bare Enter. Anything else is answered
// 'open': the app opens on it and it is decided there, with its content shown.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createPushNotifier } from './push-notifier.ts';
import { createRemoteMethods } from './remote-methods.ts';
import { generateWebPushKeys } from './web-push.ts';

const SESSION = `sess_desktop_${'a'.repeat(64)}`;

function host(t, { pushLane = true } = {}) {
  const resolved = [];
  const desktop = {
    resolveToolApprovalForSession: async (...args) => {
      resolved.push(args);
      return true;
    },
    invokeDesktopOperation: async () => null,
  };
  const notifier = createPushNotifier({
    store: { keys: async () => generateWebPushKeys(), list: async () => [], remove: async () => true },
    isEnabled: () => true,
    readFinalAnswer: async () => null,
    isClientForeground: () => false,
  });
  t.after(() => notifier.dispose());
  const methods = createRemoteMethods(
    { host: desktop, ...(pushLane ? { approvalNotifications: notifier } : {}) },
    { deviceName: async () => 'Pixel 9' }
  );
  const show = (approval) =>
    notifier.onSessionState({ sessionId: SESSION, frameSource: 'live', snapshot: { toolApproval: approval } });
  const answer = (id, action) => methods.answerApprovalNotification([SESSION, id, action]);
  const legacy = (id, decision) => methods.resolveToolApprovalForSession([SESSION, id, decision]);
  return { resolved, show, answer, legacy };
}

const refused = {
  payment: { id: 'p1', kind: 'outbound', outbound: { category: 'payment', target: 'Notion Labs' } },
  delete: { id: 'd1', kind: 'outbound', outbound: { category: 'delete', details: { count: '3' } } },
  'always-only permission': {
    id: 'w1',
    kind: 'permission',
    permission: { scopes: [{ id: 'always', kind: 'allow_always', label: 'Always' }] },
  },
  'login takeover': { id: 'l1', kind: 'takeover', takeover: { purpose: 'login', url: 'https://github.com/login' } },
  'secret input': { id: 's1', kind: 'secret', secret: { requestId: 'r1', form: 'login' } },
  'Office rollback': { id: 'o1', kind: 'approval', name: 'office', args: { action: 'rollback' } },
};

for (const [name, approval] of Object.entries(refused)) {
  test(`a notification Allow for a ${name} is refused: the host answers "open" and decides nothing`, async (t) => {
    const h = host(t);
    h.show(approval);
    assert.equal(await h.answer(approval.id, 'allow'), 'open');
    assert.deepEqual(h.resolved, []);
  });
}

test('an ordinary shell approval is allowed once from its notification, as the connection’s device', async (t) => {
  const h = host(t);
  h.show({ id: 'a1', kind: 'approval', name: 'shell', args: { command: 'npm test' } });
  assert.equal(await h.answer('a1', 'allow'), 'answered');
  // Once: no remember, no scope, nothing standing.
  assert.deepEqual(h.resolved, [[SESSION, 'a1', { approved: true, device: 'Pixel 9' }]]);
});

test('a notification Deny answers any approval, as the card’s 거절', async (t) => {
  const h = host(t);
  h.show(refused.payment);
  assert.equal(await h.answer('p1', 'deny'), 'answered');
  assert.deepEqual(h.resolved, [[SESSION, 'p1', { approved: false, device: 'Pixel 9' }]]);
});

test('an Allow for an approval the session no longer shows opens the app instead', async (t) => {
  const h = host(t);
  h.show({ id: 'a1', kind: 'approval', name: 'shell', args: {} });
  h.show({ id: 'a2', kind: 'approval', name: 'shell', args: {} });
  assert.equal(await h.answer('a1', 'allow'), 'open');
  h.show(null);
  assert.equal(await h.answer('a2', 'allow'), 'open');
  assert.deepEqual(h.resolved, []);
});

// An older phone page answered a notification's Allow with the card's own
// call, resolveToolApprovalForSession, and a bare { approved: true }.
for (const name of ['payment', 'delete', 'Office rollback']) {
  test(`an older page’s bare Allow for a ${name} is refused; the card’s own click (response 'approve') still allows it`, async (t) => {
    const h = host(t);
    const approval = refused[name];
    h.show(approval);
    assert.equal(await h.legacy(approval.id, { approved: true }), false);
    assert.deepEqual(h.resolved, []);
    assert.equal(await h.legacy(approval.id, { approved: true, response: 'approve' }), true);
    assert.equal(await h.legacy(approval.id, { approved: false }), true, 'a Deny is always taken');
    assert.deepEqual(
      h.resolved.map(([, , decision]) => decision.approved),
      [true, false]
    );
  });
}

test('an older page’s bare Allow still answers an ordinary approval once', async (t) => {
  const h = host(t);
  h.show({ id: 'a1', kind: 'approval', name: 'shell', args: { command: 'npm test' } });
  assert.equal(await h.legacy('a1', { approved: true }), true);
  assert.equal(h.resolved.length, 1);
});

test('a connection without the push lane allows nothing from a notification', async (t) => {
  const h = host(t, { pushLane: false });
  h.show({ id: 'a1', kind: 'approval', name: 'shell', args: {} });
  assert.equal(await h.answer('a1', 'allow'), 'open');
  assert.deepEqual(h.resolved, []);
});

test('an answer the session no longer takes is reported settled, and a malformed action is rejected', async () => {
  const methods = createRemoteMethods(
    {
      host: { resolveToolApprovalForSession: async () => false, invokeDesktopOperation: async () => null },
      approvalNotifications: { approvalAllowsOnce: () => true },
    },
    { deviceName: async () => 'Pixel 9' }
  );
  assert.equal(await methods.answerApprovalNotification([SESSION, 'a1', 'deny']), 'settled');
  await assert.rejects(methods.answerApprovalNotification([SESSION, 'a1', 'always']), /allow or deny/);
});
