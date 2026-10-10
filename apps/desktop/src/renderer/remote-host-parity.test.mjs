import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteApi } from './remote-shim-api.ts';
import { publishedCeilings, until, withShim } from './remote-shim-test-harness.mjs';

const OLD_TRASH = 'Moving items to the trash is available in the desktop app only.';
const GATED = [
  'previewProjectFile',
  'localPageSource',
  'ghPrList',
  'ghPrDefaultBranch',
  'ghPrCreate',
  'ghPrView',
  'ghPrCheckout',
  'ghPrMerge',
  'ghPrDiff',
  'githubCliLoginOpenBrowser',
];

const connect = async ({ ctx, dial }, remoteParity) => {
  ctx.updaterListeners = new Set();
  ctx.settingsChangedListeners = new Set();
  const api = createRemoteApi(ctx);
  const leg = await dial({ remoteParity, ready: publishedCeilings(4096, 4096) });
  return { api, leg };
};

// The submit is interrupted the way a lost reply is: the pending call fails
// with the transport's interruption code.
const loseReply = (ctx) => {
  const failure = Object.assign(new Error('interrupted'), { code: 'MIXDOG_REMOTE_CONNECTION_INTERRUPTED' });
  for (const entry of [...ctx.pending.values()]) entry.reject(failure);
  ctx.pending.clear();
};

test('an old host (no remoteParity) keeps the pre-round behavior', async () => {
  await withShim({}, async (shim) => {
    const { api, leg } = await connect(shim, false);
    assert.equal(shim.ctx.peerRemoteParity, false);
    for (const key of GATED) assert.equal(api[key], undefined, `${key} is absent`);
    assert.deepEqual({ ...(await api.getUpdaterState()) }, { status: 'disabled' });
    assert.deepEqual({ ...(await api.checkForDesktopUpdate()) }, { status: 'disabled' });
    assert.deepEqual({ ...(await api.showDesktopUpdate()) }, { status: 'disabled' });
    api.subscribeUpdaterState(() => {})();
    assert.equal(shim.ctx.updaterListeners.size, 0);
    await assert.rejects(api.trashProjectEntry('/p', 'a.txt'), { message: OLD_TRASH });
    await api.browserReleasePage('page');

    const submit = api.submitToSession('s1', 'hello', {});
    const sent = await leg.nextPayload();
    assert.equal(sent.method, 'submitToSession');
    loseReply(shim.ctx);
    await assert.rejects(submit, { code: 'MIXDOG_REMOTE_CONNECTION_INTERRUPTED' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Nothing else (no unknown-method probe, no retry) went over the wire.
    assert.equal(leg.ws.sent.length, 2);
  });
});

test('a new host (remoteParity) exposes the new members and retries submits with a stable id', async () => {
  await withShim({}, async (shim) => {
    const { api, leg } = await connect(shim, true);
    assert.equal(shim.ctx.peerRemoteParity, true);
    for (const key of GATED) assert.equal(typeof api[key], 'function', `${key} is present`);

    const state = api.getUpdaterState();
    const request = await leg.nextPayload();
    assert.equal(request.method, 'getUpdaterState');
    await leg.deliver({ id: request.id, ok: true, value: { status: 'ready' } });
    assert.equal((await state).status, 'ready');

    const trash = api.trashProjectEntry('/p', 'a.txt');
    const trashFrame = await leg.nextPayload();
    assert.equal(trashFrame.method, 'trashProjectEntry');
    await leg.deliver({ id: trashFrame.id, ok: true });
    await trash;

    const submit = api.submitToSession('s1', 'hello', {});
    const first = await leg.nextPayload();
    assert.equal(first.method, 'submitToSession');
    assert.ok(first.params[2].id);
    loseReply(shim.ctx);
    const second = await leg.nextPayload();
    assert.equal(second.method, 'submitToSession');
    assert.equal(second.params[2].id, first.params[2].id);
    await leg.deliver({ id: second.id, ok: true, value: true });
    assert.equal(await submit, true);
  });
});

test('presence follows the host of the current connection after a reconnect', async () => {
  await withShim({}, async (shim) => {
    const { api } = await connect(shim, true);
    assert.equal(typeof api.ghPrList, 'function');
    shim.ctx.connectionReady = false;
    shim.ctx.socket = null;
    shim.ctx.openPromise = null;
    await shim.dial({ remoteParity: false, ready: publishedCeilings(4096, 4096) });
    await until(() => shim.ctx.peerRemoteParity === false);
    assert.equal(api.ghPrList, undefined);
  });
});
