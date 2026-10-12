import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from './test-support/test-dom.mjs';
import { setRemoteClaimPromptActive } from './remote-claim-prompt-state.ts';
import { updateClaimQueue } from './remote-claim-store.ts';
import { RemoteClaimPrompt } from './RemoteClaimPrompt.tsx';
import { takeConnectionDialogRequest } from './settings/connection-intent.ts';

const claimFor = (extra) => ({
  claimId: 'c1',
  clientId: 'c1',
  name: 'iPhone',
  platform: 'iOS',
  browser: 'Mixdog App',
  desktop: false,
  method: 'qr',
  requestedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  ...extra,
});

async function mountPrompt(t, claim, answers = []) {
  const { root, document, window } = installTestDom(t, { rootId: 'root', expose: ['KeyboardEvent', 'Event'] });
  window.mixdogDesktop = {
    subscribeRemoteClientClaim: () => () => undefined,
    listRemoteClientClaims: () => Promise.resolve([claim]),
    resolveRemoteClientClaim: (id, approved) => {
      answers.push([id, approved]);
      return Promise.resolve(true);
    },
  };
  setRemoteClaimPromptActive(false);
  t.after(() => setRemoteClaimPromptActive(false));
  await act(async () => root.render(React.createElement(RemoteClaimPrompt)));
  return { document, window };
}

test('with the Connect dialog closed a waiting request shows the B3 notice: title, device name, View', async (t) => {
  const { document } = await mountPrompt(t, claimFor({}));
  const notice = document.querySelector('.remote-claim-notice');
  assert.ok(notice);
  assert.equal(notice.querySelector('b').textContent, 'Device connection request');
  assert.equal(notice.querySelector('span').textContent, 'iPhone');
  assert.equal(notice.querySelector('button').textContent, 'View');
  assert.equal(document.querySelector('.settings-confirm-dialog'), null, 'no standalone approval dialog any more');
  assert.equal(document.querySelector('[role="alertdialog"]'), null);
});

test('a Mixdog PC claim names the bare device in the notice', async (t) => {
  const { document } = await mountPrompt(
    t,
    claimFor({ name: 'Laptop · Mixdog Desktop', browser: 'Mixdog Desktop', desktop: true, method: 'code' })
  );
  assert.equal(document.querySelector('.remote-claim-notice span').textContent, 'Laptop');
});

test('the notice cannot answer: Escape denies nothing; View asks Settings → Connection to open the dialog', async (t) => {
  const answers = [];
  const { document, window } = await mountPrompt(t, claimFor({}), answers);
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  assert.deepEqual(answers, []);
  let opened = 0;
  window.addEventListener('mixdog:open-connection-settings', () => (opened += 1));
  await act(async () => document.querySelector('.remote-claim-notice button').click());
  assert.equal(opened, 1);
  assert.equal(takeConnectionDialogRequest(), 'connect', 'the page opens with the dialog in the approval state');
});

test('while the Connect dialog is open the notice steps aside, and returns when it closes', async (t) => {
  const { document } = await mountPrompt(t, claimFor({}));
  await act(async () => setRemoteClaimPromptActive(true));
  assert.equal(document.querySelector('.remote-claim-notice'), null);
  await act(async () => setRemoteClaimPromptActive(false));
  assert.ok(document.querySelector('.remote-claim-notice'));
});

test('an answered request disappears from the notice (the dialog and the notice share one list)', async (t) => {
  const { document } = await mountPrompt(t, claimFor({}));
  await act(async () => updateClaimQueue((current) => current.filter((row) => row.claimId !== 'c1')));
  assert.equal(document.querySelector('.remote-claim-notice'), null);
});
