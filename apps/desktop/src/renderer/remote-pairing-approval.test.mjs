import assert from 'node:assert/strict';
import test from 'node:test';

import { VirtualConsole } from 'jsdom';

import { sealRelayE2EEPairingMaterial } from '../shared/remote-e2ee.ts';
import { fakeIndexedDB as namedIndexedDB } from './test-support/fake-indexeddb.mjs';
import { installTestDom } from './test-support/test-dom.mjs';

const until = async (check, ms = 8000) => {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((done) => setTimeout(done, 20));
  }
};

const MATERIAL = { version: 1, serverPublicKey: 'A'.repeat(87), pairingSecret: 'B'.repeat(43) };
const TOKEN = 'a'.repeat(64);

/** IndexedDB as far as remote-pairing-durable.ts uses it: every request and
 *  transaction settles on a later task, like the real one. */
function fakeIndexedDB({ failWrites = false } = {}) {
  const data = new Map();
  // Which writes fail; a test flips them mid-run.
  const faults = { put: failWrites, delete: failWrites };
  const later = (fn) => setTimeout(fn, 0);
  const transaction = () => {
    const tx = {};
    const finish = (request, apply) => {
      later(() => {
        if (apply.write && faults[apply.write]) {
          tx.error = new Error('QuotaExceededError');
          tx.onerror?.();
          return;
        }
        request.result = apply();
        later(() => tx.oncomplete?.());
      });
      return request;
    };
    tx.objectStore = () => ({
      put: (value, key) =>
        finish(
          {},
          Object.assign(
            () => {
              data.set(key, structuredClone(value));
              return key;
            },
            { write: 'put' }
          )
        ),
      get: (key) => finish({}, () => structuredClone(data.get(key))),
      delete: (key) =>
        finish(
          {},
          Object.assign(() => void data.delete(key), { write: 'delete' })
        ),
    });
    return tx;
  };
  return {
    data,
    faults,
    open() {
      const request = {};
      later(() => {
        request.result = { createObjectStore() {}, transaction, close() {} };
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

test('the durable copy round-trips and is gone once cleared', async () => {
  const { saveDurablePairing, loadDurablePairing, clearDurablePairing } = await import('./remote-pairing-durable.ts');
  const factory = fakeIndexedDB();
  const pairing = { token: TOKEN, e2eePublicKey: 'pub', e2eeSecret: 'secret', browserId: 'b1', server: 'https://r' };
  await saveDurablePairing('key', pairing, factory);
  assert.deepEqual(await loadDurablePairing('key', factory), pairing);
  assert.equal(await loadDurablePairing('other', factory), null);
  await clearDurablePairing('key', factory);
  assert.equal(await loadDurablePairing('key', factory), null);
  await assert.rejects(saveDurablePairing('key', pairing, fakeIndexedDB({ failWrites: true })));
});

/** The real pairing module over a minimal shim context. */
async function installPairing(t, { indexedDB, storage = {} } = {}) {
  const dom = installTestDom(t, {
    jsdom: { url: 'https://relay.example/d/abc/' },
    expose: ['localStorage', 'location', 'navigator', 'Event', 'CustomEvent'],
    globals: indexedDB ? { indexedDB } : {},
  });
  for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
  const { remotePairingKeys } = await import('./remote-pairing-recovery.ts');
  const { installRemotePairing } = await import('./remote-shim-pairing.ts');
  const connects = [];
  const ctx = {
    deviceId: 'abc',
    pairingKeys: remotePairingKeys('https://relay.example', 'abc'),
    serverBase: 'https://relay.example',
    browserId: 'browser-1',
    token: '',
    e2eePairing: null,
    clientRegistered: false,
    registrationInFlight: null,
    connectionReady: false,
    socket: null,
    retireConnection: null,
    reconnectTimer: null,
    approvalVerificationInFlight: false,
    rosterCache: { clear() {} },
    visualizePages: { clear() {} },
    viewBaselines: { clear() {} },
    resetDeltaState() {},
    connect: () => {
      connects.push(Date.now());
      return new Promise(() => {});
    },
  };
  installRemotePairing(ctx);
  return { ctx, connects, window: dom.window };
}

test('an approval is stored only with its durable copy, and boot restores from that copy', async (t) => {
  const factory = fakeIndexedDB();
  const { ctx } = await installPairing(t, { indexedDB: factory });
  assert.equal(await ctx.adoptApproval(TOKEN, MATERIAL), true);
  assert.equal(factory.data.get(ctx.pairingKeys.token).token, TOKEN);

  // The OS trimmed localStorage; IndexedDB survived.
  localStorage.clear();
  ctx.token = '';
  ctx.e2eePairing = null;
  ctx.browserId = 'fresh';
  await ctx.restoreDurablePairing();
  assert.equal(ctx.token, TOKEN);
  assert.deepEqual(ctx.e2eePairing, MATERIAL);
  assert.equal(ctx.browserId, 'browser-1');
  assert.equal(localStorage.getItem(ctx.pairingKeys.token), TOKEN, 'localStorage is refilled');

  // A refused credential is wiped from both copies.
  ctx.resetApprovalAndAsk('gone');
  await until(() => !factory.data.has(ctx.pairingKeys.token));
  document.getElementById('mixdog-remote-pairing')?.remove();
});

test('unpairing a PC retires its secure-desktop controller key and keeps the others', async (t) => {
  const pairingDb = fakeIndexedDB();
  const keysDb = namedIndexedDB();
  const factory = { open: (name) => (name === 'mixdog-remote-screen-controller' ? keysDb : pairingDb).open(name) };
  const { ctx } = await installPairing(t, { indexedDB: factory });
  const { ensureControllerKey, loadControllerKey } = await import('./remote-screen-controller-key.ts');
  const { remotePairingKeys } = await import('./remote-pairing-recovery.ts');
  const otherPc = remotePairingKeys('https://relay.example', 'def').token;
  const kept = await ensureControllerKey(otherPc, factory);
  await ensureControllerKey(ctx.pairingKeys.token, factory);
  const { hasAutoRequestedHelper, markAutoRequestedHelper } = await import('./remote-screen-controller-key.ts');
  await markAutoRequestedHelper(ctx.pairingKeys.token, factory);
  await markAutoRequestedHelper(otherPc, factory);
  const stored = () => keysDb.databases.get('mixdog-remote-screen-controller').get('keys');
  assert.equal(stored().has(ctx.pairingKeys.token), true);

  ctx.resetApprovalAndAsk('gone');
  await until(() => !stored().has(ctx.pairingKeys.token));
  assert.equal(await loadControllerKey(ctx.pairingKeys.token, factory), null);
  assert.equal(await hasAutoRequestedHelper(ctx.pairingKeys.token, factory), false, 'the mark goes with the key');
  assert.equal(await hasAutoRequestedHelper(otherPc, factory), true);
  assert.equal((await loadControllerKey(otherPc, factory)).publicKey, kept.publicKey);
  document.getElementById('mixdog-remote-pairing')?.remove();
});

/** What the next boot holds: the credential createRemoteShimContext reads
 *  from localStorage, then the durable fallback remote-shim.ts runs when it
 *  is missing. */
async function reload(ctx) {
  const keys = ctx.pairingKeys;
  ctx.token = localStorage.getItem(keys.token) || '';
  const pub = localStorage.getItem(keys.e2eePublicKey) || '';
  const secret = localStorage.getItem(keys.e2eeSecret) || '';
  ctx.e2eePairing = pub && secret ? { version: 1, serverPublicKey: pub, pairingSecret: secret } : null;
  if (!ctx.token || !ctx.e2eePairing) await ctx.restoreDurablePairing();
  return { token: ctx.token, e2eePairing: ctx.e2eePairing };
}

test('an approval whose durable copy cannot be committed is refused and leaves nothing to adopt', async (t) => {
  const factory = fakeIndexedDB({ failWrites: true });
  const { ctx } = await installPairing(t, { indexedDB: factory });
  assert.equal(await ctx.adoptApproval(TOKEN, MATERIAL), false);
  const keys = ctx.pairingKeys;
  for (const key of [keys.token, keys.e2eePublicKey, keys.e2eeSecret]) {
    assert.equal(localStorage.getItem(key), null, `${key} was never published`);
  }
  assert.equal(factory.data.size, 0);
  assert.deepEqual(await reload(ctx), { token: '', e2eePairing: null }, 'the next boot adopts nothing');
});

test('a revoked credential whose durable delete failed is never adopted again', async (t) => {
  const factory = fakeIndexedDB();
  const { ctx } = await installPairing(t, { indexedDB: factory });
  assert.equal(await ctx.adoptApproval(TOKEN, MATERIAL), true);
  factory.faults.delete = true;
  ctx.resetApprovalAndAsk('gone');
  document.getElementById('mixdog-remote-pairing')?.remove();
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(factory.data.get(ctx.pairingKeys.token)?.token, TOKEN, 'the delete did fail');

  assert.deepEqual(await reload(ctx), { token: '', e2eePairing: null }, 'the revoked copy is not adopted');
  assert.ok(factory.data.has(ctx.pairingKeys.token), 'the delete still fails');
  assert.deepEqual(await reload(ctx), { token: '', e2eePairing: null }, 'nor on any later boot');

  // Once a delete commits, the copy is gone and the flag with it.
  factory.faults.delete = false;
  await reload(ctx);
  assert.equal(factory.data.has(ctx.pairingKeys.token), false);
  assert.equal(localStorage.getItem(`${ctx.pairingKeys.token}.revoked`), null);

  // A new approval replaces the flagged copy and is restorable again.
  assert.equal(await ctx.adoptApproval(TOKEN, MATERIAL), true);
  localStorage.clear();
  assert.equal((await reload(ctx)).token, TOKEN);
});

test('a fresh approval is verified by the secure channel and redials until it comes up', async (t) => {
  const { ctx, connects, window } = await installPairing(t, { indexedDB: fakeIndexedDB() });
  const { APPROVED_CONNECTION_ATTEMPT_MS } = await import('./remote-shim-pairing.ts');
  const deadlines = [];
  const realSetTimeout = window.setTimeout;
  window.setTimeout = (fn, ms) => {
    if (ms === APPROVED_CONNECTION_ATTEMPT_MS) {
      deadlines.push(fn);
      return 424242;
    }
    return realSetTimeout(fn, ms);
  };
  t.after(() => {
    window.setTimeout = realSetTimeout;
  });
  let retired = 0;
  ctx.retireConnection = () => {
    retired += 1;
  };
  let settled = null;
  const verified = ctx.verifyApprovedConnection().then(
    () => (settled = 'ok'),
    (error) => (settled = error)
  );
  assert.equal(connects.length, 1);
  assert.equal(ctx.approvalVerificationInFlight, true);
  // Two attempts that never become secure: no failure, just a redial each.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await until(() => deadlines.length === attempt);
    deadlines[attempt - 1]();
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(settled, null, 'a slow connection is never a failure');
    assert.equal(retired, attempt, 'the stuck attempt is dropped for the reconnect loop');
  }
  // The secure channel — not the view sync — completes the approval.
  await until(() => deadlines.length === 3);
  window.dispatchEvent(new window.Event('mixdog:remote-secure-channel-ready'));
  await verified;
  assert.equal(settled, 'ok');
  assert.equal(ctx.approvalVerificationInFlight, false);
});

test('a boot whose saved sign-in vanished asks the user instead of filing a claim', async () => {
  const { remoteBootApproval } = await import('./remote-pairing-recovery.ts');
  const boot = (overrides) =>
    remoteBootApproval({
      installed: true,
      token: TOKEN,
      hasE2eePairing: true,
      browserIdStored: true,
      claimPending: false,
      ...overrides,
    });
  assert.equal(boot({}), 'dial');
  assert.equal(boot({ installed: false }), 'not-installed');
  assert.equal(boot({ token: '' }), 'lost');
  assert.equal(boot({ token: '', claimPending: true }), 'no-token', 'a pending request resumes');
  assert.equal(boot({ token: '', browserIdStored: false }), 'no-token', 'a first launch pairs as before');
  assert.equal(boot({ hasE2eePairing: false }), 'no-key');
});

/** The approval loop against a fake relay; `poll` answers each claim poll. */
async function runApproval(t, poll, { support, deviceId = 'abc', installed = false } = {}) {
  const claims = [];
  const supportCalls = [];
  const fetchCalls = [];
  const navigations = [];
  const virtualConsole = new VirtualConsole();
  // jsdom cannot navigate: an attempted move to another path is reported here.
  virtualConsole.on('jsdomError', (error) => navigations.push(error.message));
  let publicKey = '';
  const reply = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  const approved = async () => ({
    status: 'approved',
    token: TOKEN,
    sealed: await sealRelayE2EEPairingMaterial(MATERIAL, publicKey),
  });
  const fakeFetch = async (url, init = {}) => {
    const path = new URL(String(url), 'https://relay.example').pathname;
    fetchCalls.push(path);
    if (path === '/pair-code/support') {
      supportCalls.push(path);
      return support(init);
    }
    if (path === '/claim' && init.method === 'POST') {
      publicKey = JSON.parse(init.body).publicKey;
      claims.push(publicKey);
      return reply({ claimId: `c${claims.length}` }, 202);
    }
    return reply(await poll(path, approved));
  };
  const { document, window } = installTestDom(t, {
    jsdom: { url: 'https://relay.example/d/abc/', virtualConsole },
    expose: ['localStorage', 'location', 'navigator'],
    globals: { fetch: fakeFetch },
  });
  if (installed) window.localStorage.setItem('mixdog.directBrowser', '1');
  const { createRemotePairingScreen } = await import('./remote-pairing-screen.ts');
  let accepted = 0;
  createRemotePairingScreen({
    deviceId,
    claimStorageKey: 'claim',
    serverBase: () => 'https://relay.example',
    clientId: () => 'client',
    acceptApproval: async () => {
      accepted += 1;
      return true;
    },
    verifyConnection: () => Promise.resolve(),
  })('', true);
  t.after(() => document.getElementById('mixdog-remote-pairing')?.remove());
  return { claims, accepted: () => accepted, document, supportCalls, fetchCalls, navigations };
}

const pending = async () => ({ status: 'pending' });

for (const [name, answer] of [
  ['429', () => Promise.resolve(new Response('{}', { status: 429, headers: { 'Retry-After': '1' } }))],
  ['404', () => Promise.resolve(new Response('{}', { status: 404 }))],
  ['a probe that never answers', () => new Promise(() => undefined)],
  ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
]) {
  test(`a browser tab asks its PC directly and never probes support (${name})`, async (t) => {
    const run = await runApproval(t, pending, { support: answer });
    await until(() => run.claims.length === 1);
    await until(() => run.document.querySelector('.mxp-title')?.textContent === 'Allow it on your PC');
    assert.equal(run.document.querySelector('.mxp-step'), null, 'no install steps');
    assert.deepEqual(
      [...run.document.querySelectorAll('.mxp-actions button')].map((b) => b.dataset.role),
      ['cancel']
    );
    assert.deepEqual(run.supportCalls, [], 'the support endpoint is not called');
    assert.deepEqual(run.navigations, []);
  });
}

test('a browser tab with no deviceId goes to the code entry page and paints nothing', async (t) => {
  const run = await runApproval(t, pending, { deviceId: '' });
  await until(() => run.navigations.some((message) => /navigation/iu.test(message)));
  assert.equal(run.document.getElementById('mixdog-remote-pairing'), null);
  assert.deepEqual(run.fetchCalls, [], 'nothing is asked of the relay');
});

test('an installed surface still asks directly, and without a deviceId still reports instead of navigating', async (t) => {
  const asking = await runApproval(t, pending, { installed: true });
  await until(() => asking.claims.length === 1);
  assert.equal(asking.document.querySelector('.mxp-title').textContent, 'Allow it on your PC');
  assert.deepEqual(asking.supportCalls, []);
  const empty = await runApproval(t, pending, { installed: true, deviceId: '' });
  await until(() => empty.document.querySelector('.mxp-title')?.textContent === 'Connection failed');
  assert.deepEqual(empty.navigations, []);
  assert.deepEqual(empty.fetchCalls, []);
});

test('a claim the relay no longer knows is filed again on its own', async (t) => {
  const run = await runApproval(t, async (path, approved) =>
    path === '/claim/c1' ? { status: 'unknown' } : approved()
  );
  await until(() => run.accepted() === 1);
  assert.equal(run.claims.length, 2, 'one automatic re-claim');
  assert.equal(run.claims[0], run.claims[1], 'with the same key');
});

test('a page that thaws past the poll deadline still polls once more', async (t) => {
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  t.after(() => {
    Date.now = realNow;
  });
  let polls = 0;
  const run = await runApproval(t, async (_path, approved) => {
    polls += 1;
    if (polls === 1) {
      // Frozen in the background for longer than the whole wait.
      skew += 301_000;
      return { status: 'pending' };
    }
    return approved();
  });
  await until(() => run.accepted() === 1);
  assert.equal(polls, 2);
  assert.notEqual(run.document.querySelector('.mxp-title')?.textContent, 'Request expired');
});
