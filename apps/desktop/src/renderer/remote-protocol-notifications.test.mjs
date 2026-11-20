// The phone's native push registration, a notification's Allow / Deny and the desktop notices it is shown, on the notifications adapter
// (remote-protocol-notifications.ts). Inputs are inline; each expectation follows the rule written in the adapter.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adapter } from './remote-protocol-notifications.ts';

function scripted(replies = {}) {
  const sent = [];
  const client = { call: async (method, params) => (sent.push({ method, params }), replies[method] ?? {}) };
  const host = { ctx: {}, client: () => client, declareLane() {} };
  return { sent, call: async (name, args) => adapter.calls[name](args, host) };
}

test("push registrations are the core's requests; the phone adds only the argument checks Node made", async () => {
  const { sent, call } = scripted();
  await call('pushPublicKey', []);
  await call('registerPushSubscription', [{ endpoint: 'https://push.test/e' }]);
  await call('registerPushSubscription', []);
  await call('registerNativePush', [{ platform: 'ios', token: 't' }]);
  await call('removeNativePush', []);
  await call('removeNativePush', ['tok']);
  await call('removePushSubscription', ['  https://push.test/e  ']);
  assert.deepEqual(sent, [
    { method: 'remoteAccess/pushPublicKey', params: {} },
    { method: 'remoteAccess/registerPushSubscription', params: { input: { endpoint: 'https://push.test/e' } } },
    { method: 'remoteAccess/registerPushSubscription', params: { input: null } },
    { method: 'remoteAccess/registerNativePush', params: { input: { platform: 'ios', token: 't' } } },
    { method: 'remoteAccess/removeNativePush', params: {} },
    { method: 'remoteAccess/removeNativePush', params: { token: 'tok' } },
    { method: 'remoteAccess/removePushSubscription', params: { endpoint: 'https://push.test/e' } },
  ]);
});

test('a token that is not a string and a blank endpoint are refused before anything is sent', async () => {
  const { sent, call } = scripted();
  await assert.rejects(call('removeNativePush', [5]), { message: 'token must be a string.' });
  await assert.rejects(call('removePushSubscription', ['  ']), { message: 'endpoint is invalid.' });
  await assert.rejects(call('removePushSubscription', [null]), { message: 'endpoint must be a string.' });
  assert.deepEqual(sent, []);
});

test("Allow / Deny of a notification is the core's decision: the phone sends the three ids and answers the outcome", async () => {
  const { sent, call } = scripted({ 'thread/approval/answerNotification': { outcome: 'accepted' } });
  assert.equal(await call('answerApprovalNotification', ['sess_a', 'ap1', 'allow']), 'accepted');
  assert.deepEqual(sent, [
    {
      method: 'thread/approval/answerNotification',
      params: { threadId: 'sess_a', approvalId: 'ap1', action: 'allow' },
    },
  ]);
});

test('only a notice the connected client hears raised live is shown; a snapshot or a replay is not', () => {
  const shown = [];
  const sections = {
    'notice:a': { value: { key: 'a', code: 'secret-storage-failed', params: { name: 5, where: 'x' } } },
    'notice:b': { value: { key: 'b', code: 'unknown-code' } },
  };
  let live = false;
  let notify;
  const client = {
    store: {
      subscribe: (fn) => ((notify = fn), () => {}),
      section: (name, key) => sections[`${name}:${key}`],
      appLive: () => live,
    },
  };
  const host = {
    ctx: { desktopNoticeListeners: 'N', fanOut: (list, notice) => shown.push([list, notice]) },
    onClient: (wire) => (wire(client), () => {}),
  };
  adapter.install(host);
  notify({ type: 'section', section: 'notice', key: 'a' });
  assert.deepEqual(shown, [], 'not live yet: what a snapshot holds is not a raised notice');
  live = true;
  notify({ type: 'section', section: 'config', key: 'a' });
  notify({ type: 'section', section: 'notice', key: 'b' });
  assert.deepEqual(shown, [], 'another section, or a notice with an unknown code, is not shown');
  notify({ type: 'section', section: 'notice', key: 'a' });
  assert.deepEqual(shown, [['N', { key: 'a', code: 'secret-storage-failed', params: { where: 'x' } }]]);
});
