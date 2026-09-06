import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { ErrorNotice } from './ErrorNotice.tsx';
import { DesktopToastRegion, showDesktopToast } from './desktop-toasts.tsx';
import { groupToasts, reduceToasts } from './desktop-toast-state.ts';
import { projectSettledTranscriptRows } from './transcript-rows.ts';
import { RemoteClaimPrompt } from './RemoteClaimPrompt.tsx';
import { setRemoteClaimPromptActive } from './remote-claim-prompt-state.ts';
import RemoteBrowserPane from './RemoteBrowserPane.tsx';

const failure = (index) => `Anthropic OAuth API 400: ${JSON.stringify({
  error: { type: 'invalid_request_error', message: `image dimensions exceed max allowed size for many-image requests (${index})` },
})}`;

function host(records, toasts) { return reduceToasts(records, { type: 'host', toasts }); }

test('notification identity merges repeat failures only inside the same operation', () => {
  let records = host([], [
    { id: 1, text: failure(54), tone: 'error', scope: 'session:a' },
    { id: 2, text: failure(62), tone: 'error', scope: 'session:a' },
    { id: 3, text: failure(54), tone: 'error', scope: 'session:b' },
  ]);
  assert.deepEqual(groupToasts(records).map((group) => group.count), [2, 1]);
  records = host(records, [{ id: 2, text: failure(62), tone: 'error', scope: 'session:a' }]);
  assert.deepEqual(groupToasts(records).map((group) => group.count), [2, 1]);
});

test('state failures close on recovery while event failures survive source TTL', () => {
  const records = host([], [
    { id: 'connection', text: 'connection stopped', tone: 'error', lifetime: 'state' },
    { id: 'operation', text: 'save failed', tone: 'error' },
  ]);
  assert.deepEqual(groupToasts(host(records, [])).map((entry) => entry.text), ['save failed']);
});

test('turn-owned failures never produce a second desktop notification', () => {
  assert.equal(groupToasts(host([], [{ id: 1, text: 'failed', tone: 'error', owner: 'transcript' }])).length, 0);
});

test('dismissed snapshots do not reappear, but a new occurrence is visible', () => {
  const toast = { id: 1, text: 'save failed', tone: 'error' };
  let records = host([], [toast]);
  records = reduceToasts(records, { type: 'dismiss', ids: ['host:1'] });
  assert.equal(groupToasts(host(records, [toast])).length, 0);
  assert.equal(groupToasts(host(records, [{ ...toast, id: 2 }])).length, 1);
});

test('consecutive failed continuation turns share one stable row and preserve every reason', () => {
  const items = Array.from({ length: 6 }, (_, index) => ({
    id: `d${index}`, kind: 'turndone', status: 'failed', detail: failure(index),
  }));
  const turnKeys = items.map((_, index) => `t${index}`);
  const rows = projectSettledTranscriptRows({ sessionKey: 'a', items, turnKeys, failedTurns: new Set(turnKeys) }).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]._tag, 'Error');
  assert.equal(rows[0].failures.length, 6);
  assert.equal(rows[0].turnKey, 't5');
  const first = projectSettledTranscriptRows({ sessionKey: 'a', items: items.slice(0, 1), turnKeys: ['t0'], failedTurns: new Set(['t0']) }).rows;
  assert.equal(first[0].key, rows[0].key);
});

test('visible prompts and progress separate error runs instead of folding unrelated work', () => {
  for (const middle of [{ kind: 'user', text: 'new request' }, { kind: 'assistant', text: 'progress' }]) {
    const items = [
      { id: 1, kind: 'turndone', status: 'failed', detail: 'first' },
      { id: 2, ...middle },
      { id: 3, kind: 'turndone', status: 'failed', detail: 'second' },
    ];
    const rows = projectSettledTranscriptRows({
      sessionKey: 'a', items, turnKeys: ['a', 'b', 'b'], failedTurns: new Set(['a', 'b']),
    }).rows;
    assert.equal(rows.filter((row) => row._tag === 'Error').length, 2);
  }
});

async function withDom(run) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const names = ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, {
    configurable: true, writable: true,
    value: name === 'IS_REACT_ACT_ENVIRONMENT' ? true : name === 'window' ? dom.window : dom.window[name],
  });
  const root = createRoot(document.getElementById('root'));
  const render = async (element) => act(async () => root.render(element));
  try { await run({ dom, render }); } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test('one error surface keeps diagnostics collapsed and retry respects busy state', async () => withDom(async ({ dom, render }) => {
  let retries = 0;
  const element = (busy) => React.createElement(ErrorNotice, {
    errors: [failure(54), failure(62)], retryDisabled: busy, onRetry: () => retries++,
  });
  await render(element(true));
  assert.equal(document.querySelectorAll('.error-notice').length, 1);
  assert.equal(document.querySelector('pre'), null);
  assert.match(document.body.textContent, /×2/);
  const retry = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Retry');
  await act(async () => retry.click());
  assert.equal(retries, 0);
  await render(element(false));
  await act(async () => retry.click());
  assert.equal(retries, 1);
  await act(async () => document.querySelector('[aria-expanded]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  assert.equal(document.querySelectorAll('pre').length, 2);
  assert.match(document.querySelectorAll('pre')[1].textContent, /\(62\)/);
}));

test('opening toast details does not dismiss the error and recovered bridge clears', async () => withDom(async ({ render }) => {
  let dismissed = 0;
  const props = { toasts: [], bridgeError: failure(54), onDismissBridgeError: () => dismissed++ };
  await render(React.createElement(DesktopToastRegion, props));
  await act(async () => document.querySelector('[aria-expanded]').click());
  assert.equal(document.querySelectorAll('.mx-toast').length, 1);
  assert.equal(dismissed, 0);
  await render(React.createElement(DesktopToastRegion, { ...props, bridgeError: '' }));
  assert.equal(document.querySelectorAll('.mx-toast').length, 0);
  await act(async () => {
    showDesktopToast(failure(54), 'error', { scope: 'job' });
    showDesktopToast(failure(62), 'error', { scope: 'job' });
  });
  assert.equal(document.querySelectorAll('.mx-toast').length, 1);
  assert.match(document.body.textContent, /×2/);
}));

test('a failed remote approval stays actionable and explains the failure', async () => withDom(async ({ render }) => {
  let listener;
  let attempts = 0;
  window.mixdogDesktop = {
    subscribeRemoteClientClaim: (callback) => { listener = callback; return () => {}; },
    resolveRemoteClientClaim: async () => { attempts++; throw new Error('connection temporarily lost'); },
  };
  setRemoteClaimPromptActive(true);
  try {
    await render(React.createElement(RemoteClaimPrompt));
    await act(async () => listener({ claimId: 'c', clientId: 'client', expiresAt: Date.now() + 60_000 }));
    const approve = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Approve');
    await act(async () => approve.click());
    assert.equal(attempts, 1);
    assert.match(document.querySelector('.error-notice').textContent, /connection temporarily lost/);
    assert.equal(approve.disabled, false);
  } finally { await act(async () => setRemoteClaimPromptActive(false)); }
}));

test('successful remote screen reads do not erase an unsuccessful user gesture', async () => withDom(async ({ render }) => {
  let controls = 0;
  window.mixdogDesktop = {
    remoteBrowserFrame: async () => ({
      frameId: 'frame', width: 100, height: 100, url: 'https://example.test/', title: 'Page',
      image: { mimeType: 'image/png', data: 'AA==' },
    }),
    remoteBrowserControl: async () => { controls++; throw new Error('gesture could not be delivered'); },
  };
  await render(React.createElement(RemoteBrowserPane, { sessionId: 'a', active: true }));
  const reload = document.querySelector('button[aria-label="Reload"]');
  assert.ok(reload);
  await act(async () => { reload.click(); await new Promise((resolve) => setTimeout(resolve, 30)); });
  assert.equal(controls, 1);
  assert.match(document.querySelector('.error-notice').textContent, /gesture could not be delivered/);
}));
