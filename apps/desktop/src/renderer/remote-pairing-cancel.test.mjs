import assert from 'node:assert/strict';
import test from 'node:test';

import { sealRelayE2EEPairingMaterial } from '../shared/remote-e2ee.ts';
import { installTestDom } from './test-support/test-dom.mjs';

const until = async (check, ms = 6000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((done) => setTimeout(done, 20));
  }
};

const MATERIAL = {
  version: 1,
  serverPublicKey: 'A'.repeat(87),
  pairingSecret: 'B'.repeat(43),
};

test('cancel while an approved answer is in flight stores no credential and stays canceled', async (t) => {
  let publicKey = '';
  let releasePoll = () => undefined;
  let pollStarted = false;
  let pollSignal = null;
  const reply = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  const fakeFetch = (url, init = {}) => {
    const path = new URL(String(url), 'https://relay.example').pathname;
    if (path === '/pair-code/support') return reply({ online: true, pairV2: true });
    if (path === '/claim' && init.method === 'POST') {
      publicKey = JSON.parse(init.body).publicKey;
      return reply({ claimId: 'c1' }, 202);
    }
    pollStarted = true;
    pollSignal = init.signal;
    // The answer arrives late and ignores the abort: the guard, not the
    // network stack, must keep it from completing the pairing.
    return new Promise((resolve) => {
      releasePoll = async () =>
        resolve(
          new Response(
            JSON.stringify({
              status: 'approved',
              token: 'a'.repeat(64),
              sealed: await sealRelayE2EEPairingMaterial(MATERIAL, publicKey),
            }),
            { status: 200 }
          )
        );
    });
  };
  const { document } = installTestDom(t, {
    jsdom: { url: 'https://relay.example/d/abc/' },
    expose: ['localStorage', 'location', 'navigator'],
    globals: { fetch: fakeFetch },
  });
  const { createRemotePairingScreen } = await import('./remote-pairing-screen.ts');
  let accepted = 0;
  let verified = 0;
  createRemotePairingScreen({
    deviceId: 'abc',
    claimStorageKey: 'claim',
    serverBase: () => 'https://relay.example',
    clientId: () => 'client',
    acceptApproval: () => {
      accepted += 1;
      return true;
    },
    verifyConnection: () => {
      verified += 1;
      return Promise.resolve();
    },
  })('', true);
  await until(() => pollStarted);
  const layer = document.getElementById('mixdog-remote-pairing');
  layer.querySelector('[data-role="cancel"]').click();
  assert.equal(pollSignal.aborted, true, 'cancel aborts the in-flight poll');
  await releasePoll();
  await new Promise((done) => setTimeout(done, 300));
  assert.equal(accepted, 0, 'no credential accepted');
  assert.equal(verified, 0);
  assert.equal(layer.querySelector('.mxp-title').textContent, 'Request canceled');
  t.after(() => layer.remove());
});

test('pairing completes on engines without AbortSignal.any (Chrome < 116, Safari < 17.4)', async (t) => {
  const original = AbortSignal.any;
  delete AbortSignal.any;
  t.after(() => {
    AbortSignal.any = original;
  });
  let publicKey = '';
  const reply = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  const fakeFetch = async (url, init = {}) => {
    const path = new URL(String(url), 'https://relay.example').pathname;
    if (path === '/pair-code/support') return reply({ online: true, pairV2: true });
    if (path === '/claim' && init.method === 'POST') {
      publicKey = JSON.parse(init.body).publicKey;
      return reply({ claimId: 'c1' }, 202);
    }
    return reply({
      status: 'approved',
      token: 'a'.repeat(64),
      sealed: await sealRelayE2EEPairingMaterial(MATERIAL, publicKey),
    });
  };
  const { document } = installTestDom(t, {
    jsdom: { url: 'https://relay.example/d/abc/' },
    expose: ['localStorage', 'location', 'navigator'],
    globals: { fetch: fakeFetch },
  });
  const { createRemotePairingScreen } = await import('./remote-pairing-screen.ts');
  let accepted = 0;
  createRemotePairingScreen({
    deviceId: 'abc',
    claimStorageKey: 'claim',
    serverBase: () => 'https://relay.example',
    clientId: () => 'client',
    acceptApproval: () => {
      accepted += 1;
      return true;
    },
    verifyConnection: () => Promise.resolve(),
  })('', true);
  await until(() => accepted === 1);
  const layer = document.getElementById('mixdog-remote-pairing');
  assert.notEqual(layer?.querySelector('.mxp-title')?.textContent, 'Connection failed');
  t.after(() => layer?.remove());
});
