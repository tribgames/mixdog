import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['navigator', 'HTMLElement', 'MouseEvent', 'KeyboardEvent', 'Event'],
});
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
// The core's `login:<flowId>` feed as the preload hands it to the window: pushed updates, a loss, and the read of
// what the connection holds of the feed that the window makes once it listens.
const updates = new Set();
const losses = new Set();
const feed = {
  push: (flowId, state) => updates.forEach((listener) => listener({ flowId, state })),
  lose: (flowId) => losses.forEach((listener) => listener({ flowId })),
};
window.mixdogDesktop = {
  sections: {
    // The page's capabilities are served by the test's own daemon, not by a core connection.
    core: async () => false,
    snapshot: async () => ({ status: 'ready', entries: [] }),
    subscribe: () => () => undefined,
    subscribeLoginUpdated(listener) {
      updates.add(listener);
      return () => updates.delete(listener);
    },
    subscribeLoginFeedLost(listener) {
      losses.add(listener);
      return () => losses.delete(listener);
    },
    loginFeed: async () => ({ state: null, lost: false }),
  },
  getQuotaAutoResume: async () => true,
  setQuotaAutoResume: async (next) => next,
  openExternal: async () => undefined,
};

const { CapabilitySettings } = await import('./CapabilitySettings.tsx');

const PROVIDER = 'openai-oauth';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The daemon as the Providers page sees it: one GPT sign-in that completes
// when its feed pushes the completed status. `holdSetup` parks the provider-setup read the
// completed flow refreshes, so the completed step stays on screen.
function daemon({ accounts }) {
  const state = { accounts, complete: false, holdSetup: false, held: [], cancels: 0, setupReads: 0 };
  const answer = async (capability) => {
    switch (capability) {
      case 'getProviderSetup':
        state.setupReads += 1;
        if (state.holdSetup) await new Promise((resume) => state.held.push(resume));
        return { oauth: [{ id: PROVIDER, name: 'GPT' }], api: [] };
      case 'getProviderAccounts':
        return { selectedId: state.accounts[0]?.id ?? null, auto: true, accounts: structuredClone(state.accounts) };
      case 'beginOAuthProviderLogin':
        return { flowId: 'flow-1', state: 'pending', url: 'https://auth.test/authorize' };
      case 'cancelOAuthProviderLogin':
        state.cancels += 1;
        return {};
      case 'getUsageDashboard':
        return { rows: [] };
      default:
        return null;
    }
  };
  return {
    state,
    release() {
      for (const resume of state.held.splice(0)) resume();
    },
    api: {
      async readCapabilities(requests) {
        return Promise.all(
          requests.map(async ({ capability, args }) => ({ ok: true, value: await answer(capability, args) }))
        );
      },
      async invokeCapability({ capability, args }) {
        return { value: await answer(capability, args), snapshot: null };
      },
      async listProviderModels() {
        return [];
      },
      async getSnapshot() {
        return null;
      },
    },
  };
}

const click = (el) => act(async () => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const dialog = () => document.querySelector('[role="dialog"].settings-oauth-dialog');
const footerClose = () => dialog()?.querySelector('footer button');
const settle = (ms = 30) => act(async () => sleep(ms));

async function openCompletedSignIn(t, { accounts }) {
  const host = daemon({ accounts });
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    host.release();
    await act(async () => root.unmount());
  });
  await act(async () =>
    root.render(React.createElement(CapabilitySettings, { api: host.api, category: 'providers', active: true }))
  );
  await settle(50);
  const add = document.querySelector('button[aria-label="Add account"]');
  assert.ok(add, 'the GPT card offers Add account');
  host.state.holdSetup = true;
  await click(add);
  assert.ok(dialog(), 'the sign-in dialog opened');
  // The core pushes the browser sign-in done on the flow's feed; the refresh of the
  // provider setup that follows is still running (held), so the dialog stays.
  host.state.complete = true;
  await act(async () => feed.push('flow-1', { flowId: 'flow-1', state: 'complete' }));
  await settle(30);
  assert.ok(host.state.complete, 'the sign-in completed');
  assert.ok(dialog(), 'the completed step is on screen while the provider data refreshes');
  assert.match(dialog().querySelector('.settings-oauth-wait').textContent, /Complete/);
  return host;
}

test('Close on the completed GPT sign-in step closes it', async (t) => {
  const host = await openCompletedSignIn(t, { accounts: [] });
  assert.equal(footerClose().disabled, false, 'Close is usable on the completed step');
  await click(footerClose());
  assert.equal(dialog(), null);
  host.release();
  await settle(100);
  assert.equal(dialog(), null, 'the late refresh does not bring the dialog back');
});

test('Close still works while another settings mutation keeps the page busy', async (t) => {
  const host = await openCompletedSignIn(t, { accounts: [{ id: 'a0', label: 'First GPT', authenticated: true }] });
  host.state.accounts = [
    { id: 'a0', label: 'First GPT', authenticated: true },
    { id: 'a1', label: 'Second GPT', authenticated: true },
  ];
  await act(async () => window.dispatchEvent(new window.Event('mixdog:provider-accounts-changed')));
  await settle(30);
  // Switching account refreshes the provider setup as a held, non-silent mutation.
  await click(document.querySelector('button[aria-label="Use account Second GPT"]'));
  await settle(30);
  assert.ok(dialog(), 'the completed step is still up');
  await click(footerClose());
  assert.equal(dialog(), null, 'Close closes it even while the page is busy');
});

const EXISTING = { id: 'a0', label: 'First GPT', authenticated: true };
const ADDED = { id: 'a1', label: 'Second GPT', authenticated: true };

const dismissals = {
  'the footer Close': () => click(footerClose()),
  'the header close button': () => click(dialog().querySelector('header button')),
  'the scrim': () =>
    act(async () => {
      const layer = dialog().parentElement;
      layer.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
      layer.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    }),
};

for (const [name, dismiss] of Object.entries(dismissals)) {
  test(`${name} closes the completed step while the new account and a provider refresh land`, async (t) => {
    const host = await openCompletedSignIn(t, { accounts: [EXISTING] });
    // The new account lands and the roster/usage refresh broadcasts it.
    host.state.accounts = [EXISTING, ADDED];
    await act(async () => window.dispatchEvent(new window.Event('mixdog:provider-accounts-changed')));
    await settle(30);
    assert.ok(dialog(), 'the completed step survives the refresh');
    await dismiss();
    assert.equal(dialog(), null, 'closed');
    host.release();
    await settle(100);
    assert.equal(dialog(), null, 'a late refresh does not bring it back');
    assert.ok(document.querySelector('[data-account-id="a1"]'), 'the list shows the new account');
  });
}

test('a lost feed ends the wait with the status-failure notice and the sign-in can still be cancelled', async (t) => {
  const host = daemon({ accounts: [] });
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    host.release();
    await act(async () => root.unmount());
  });
  await act(async () =>
    root.render(React.createElement(CapabilitySettings, { api: host.api, category: 'providers', active: true }))
  );
  await settle(50);
  await click(document.querySelector('button[aria-label="Add account"]'));
  assert.ok(dialog(), 'the sign-in dialog opened');
  assert.doesNotMatch(dialog().textContent, /OAuth status could not be checked\./);
  await act(async () => feed.lose('flow-1'));
  assert.match(dialog().textContent, /OAuth status could not be checked\./);
  assert.equal(footerClose().textContent, 'Cancel');
  await click(footerClose());
  assert.equal(dialog(), null);
  assert.equal(host.state.cancels, 1, 'closing the waiting dialog cancels the flow on the core');
});
