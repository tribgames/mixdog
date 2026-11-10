import assert from 'node:assert/strict';
import test from 'node:test';
import { peerFlagsOf } from '../../../mobile/src/phone-capabilities.ts';
import { settle, withPhoneApi } from './test-support/phone-api-rig.mjs';

const OLD_TRASH = 'Moving items to the trash is available in the desktop app only.';
const GATED = [
  'previewProjectFile',
  'localPageSource',
  'localPageUrl',
  'ghPrList',
  'ghPrDefaultBranch',
  'ghPrCreate',
  'ghPrView',
  'ghPrCheckout',
  'ghPrMerge',
  'ghPrDiff',
  'githubCliLoginOpenBrowser',
];

// Node's version of these tests (b6f10295a) drove the table over a fake relay socket with the challenge's `remoteParity` flag. Here the table
// is the same (remote-shim-api.ts), the flag is the context's `peerRemoteParity` (the phone sets it per connection from the core's
// capabilities, apps/mobile/src/phone-capabilities.ts), and what Node read off the socket is what reached the adapter that owns the name.
const handlers = {
  getUpdaterState: () => ({ status: 'ready' }),
  trashProjectEntry: () => undefined,
  submitToSession: () => true,
};

// The submit is interrupted the way a lost reply is: the call fails with the connection-interrupted code.
const lostReply = () => Object.assign(new Error('interrupted'), { code: 'MIXDOG_REMOTE_CONNECTION_INTERRUPTED' });

test('an old host (no remoteParity) keeps the pre-round behavior', async () => {
  let submits = 0;
  await withPhoneApi({ ...handlers, submitToSession: () => Promise.reject((submits += 1, lostReply())) }, async ({ ctx, api, calls }) => {
    ctx.updaterListeners = new Set();
    ctx.peerRemoteParity = false;
    // Node remote-shim-api.ts:546-567 -- the gated members read as absent unless `parity()` (:97, ctx.peerRemoteParity === true).
    for (const key of GATED) assert.equal(api[key], undefined, `${key} is absent`);
    // :400-404 -- without parity the updater answers are LEGACY_HOST_FALLBACKS (inert `disabled`), and nothing is called.
    assert.deepEqual({ ...(await api.getUpdaterState()) }, { status: 'disabled' });
    assert.deepEqual({ ...(await api.checkForDesktopUpdate()) }, { status: 'disabled' });
    assert.deepEqual({ ...(await api.showDesktopUpdate()) }, { status: 'disabled' });
    // :408 -- subscribeUpdaterState is always registered on ctx.updaterListeners (listenOn).
    const unsubscribe = api.subscribeUpdaterState(() => {});
    assert.equal(ctx.updaterListeners.size, 1);
    unsubscribe();
    assert.equal(ctx.updaterListeners.size, 0);
    // :415-418 -- without parity the trash refusal (remote-browser-fallbacks.ts:23) and the page release are local fallbacks.
    await assert.rejects(api.trashProjectEntry('/p', 'a.txt'), { message: OLD_TRASH });
    await api.browserReleasePage('page');
    // :444-446 -- without parity submitToSession is a plain call: no stable id, a lost reply is not replayed.
    await assert.rejects(api.submitToSession('s1', 'hello', {}), { code: 'MIXDOG_REMOTE_CONNECTION_INTERRUPTED' });
    await settle();
    // Nothing else (no unknown-method probe, no retry) reached the adapter: the one submit.
    assert.deepEqual(calls.map((call) => call.method), ['submitToSession']);
    assert.equal(submits, 1);
  });
});

test('a new host (remoteParity) exposes the new members and retries submits with a stable id', async () => {
  let attempt = 0;
  const submitted = [];
  await withPhoneApi(
    {
      ...handlers,
      submitToSession: (params) => {
        submitted.push(params);
        return (attempt += 1) === 1 ? Promise.reject(lostReply()) : true;
      },
    },
    async ({ ctx, api, calls }) => {
      ctx.peerRemoteParity = true;
      for (const key of GATED) assert.equal(typeof api[key], 'function', `${key} is present`);
      assert.equal((await api.getUpdaterState()).status, 'ready');
      await api.trashProjectEntry('/p', 'a.txt');
      assert.deepEqual(calls.map((call) => call.method), ['getUpdaterState', 'trashProjectEntry']);
      // :444-451 -- with parity submitToSession adds a stable id (:449) and recoverableCreation replays the call after a lost reply with the same one (:450-451).
      assert.equal(await api.submitToSession('s1', 'hello', {}), true);
      assert.equal(submitted.length, 2);
      assert.ok(submitted[0][2].id);
      assert.equal(submitted[1][2].id, submitted[0][2].id);
    }
  );
});

test('an updater subscription made before the connection says what the host has survives it', async () => {
  await withPhoneApi(handlers, async ({ ctx, api }) => {
    ctx.updaterListeners = new Set();
    const seen = [];
    api.subscribeUpdaterState((state) => seen.push(state.status));
    assert.equal(ctx.peerRemoteParity, false);
    // What the phone does when a connection is ready: the flags of that connection are set; no listener is touched (phone-boot.ts).
    // Node: the flag is set from the challenge (remote-shim-socket.ts:388) and the listener set lives on ctx (remote-shim-state.ts:517), so it survives.
    ctx.peerRemoteParity = true;
    assert.equal(ctx.updaterListeners.size, 1);
    ctx.fanOut(ctx.updaterListeners, { status: 'ready' });
    assert.deepEqual(seen, ['ready']);
  });
});

test('presence follows the host of the current connection after a reconnect', async () => {
  await withPhoneApi(handlers, async ({ ctx, api }) => {
    ctx.peerRemoteParity = true;
    assert.equal(typeof api.ghPrList, 'function');
    // phone-boot.ts resets the peer flags when a connection is lost, and the next connection sets its own (Node: remote-shim-socket.ts:291 and :388).
    // The gate is evaluated per read (remote-shim-api.ts:564-567).
    ctx.peerRemoteParity = false;
    assert.equal(api.ghPrList, undefined);
  });
});

// Node set the flag from the challenge (remote-shim-socket.ts, `peerRemoteParity = challenge.remoteParity`). The core's capabilities have no
// counterpart yet (PEER_FLAGS_WITHOUT_CAPABILITY.remoteParity in apps/mobile/src/phone-capabilities.ts), so a phone on the core reads false.
test('a phone connected to the core reads no remoteParity until the core advertises it', () => {
  const capabilities = { browser: { state: 'unavailable' } };
  assert.equal(peerFlagsOf(capabilities).peerRemoteParity, false);
});