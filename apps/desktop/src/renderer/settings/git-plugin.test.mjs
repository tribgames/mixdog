import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'CustomEvent', 'navigator'],
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLElement.prototype.attachEvent = () => {};
window.HTMLElement.prototype.detachEvent = () => {};
window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };
const { BuiltInFeaturesPanel } = await import('./built-in-features-panel.tsx');
const { GitPanel } = await import('./git-panel.tsx');

test('Git & GitHub detail retains the saved account without commit-message settings or identity writes', async () => {
  const changes = [];
  const api = {
    readSettings: async () => ({}),
    gitCliStatus: async () => ({ installed: true, version: '2.50' }),
    githubCliStatus: async () => ({ installed: true, authenticated: true, login: 'owner', version: '2.81' }),
    githubCliAccount: async () => ({ login: 'owner', name: 'Saved Owner', email: 'saved@example.com' }),
    gitGlobalConfig: async () => ({ name: 'Manual identity', email: 'manual@example.com' }),
    setGitGlobalConfig: async (...args) => {
      changes.push(args);
    },
    githubCliLoginStart: async () => {
      changes.push('login');
    },
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        React.createElement(BuiltInFeaturesPanel, {
          api,
          data: { toolModules: { git: { installed: true, enabled: true } }, skills: { skills: [] } },
          snapshot: null,
          pending: '',
          run: async () => ({}),
          initialFeature: 'git',
        })
      )
    );
    const dialog = document.querySelector('[data-feature-id="git"]');
    assert.ok(dialog);
    assert.match(dialog.textContent, /Git & GitHub/);
    assert.match(dialog.textContent, /saved@example.com/);
    assert.doesNotMatch(dialog.textContent, /Commit messages|Conventional Commits|AI instructions/);
    assert.equal(dialog.querySelector('textarea'), null);
    assert.deepEqual(changes, []);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('GitHub Connect cannot start a device flow on a host without cancellation', async () => {
  let starts = 0;
  const api = {
    githubCliStatus: async () => ({ installed: true, authenticated: false }),
    githubCliLoginStart: async () => {
      starts += 1;
      return { flowId: 'flow-1', state: 'pending' };
    },
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(GitPanel, { api })));
    const connect = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Connect');
    assert.equal(connect?.disabled, true);
    await act(async () => connect.click());
    assert.equal(starts, 0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('an inconclusive GitHub status read leaves the device code and Cancel available', async () => {
  const cancelled = [];
  let reads = 0;
  const api = {
    githubCliStatus: async () => ({ installed: true, authenticated: false }),
    githubCliLoginStart: async () => ({ flowId: 'flow-1', state: 'code', code: 'ABCD-EFGH' }),
    githubCliLoginStatus: async () => {
      reads += 1;
      throw new Error('Connection interrupted');
    },
    githubCliLoginCancel: async (id) => {
      cancelled.push(id);
      if (cancelled.length === 1) throw new Error('Connection interrupted');
    },
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const button = (label) => [...host.querySelectorAll('button')].find((item) => item.textContent === label);
  try {
    await act(async () => root.render(React.createElement(GitPanel, { api })));
    await act(async () => button('Connect').click());
    assert.ok(reads > 0, 'the fallback status read ran');
    assert.equal(host.querySelector('code')?.textContent, 'ABCD-EFGH');
    assert.equal(button('Connect'), undefined);
    await act(async () => button('Cancel').click());
    assert.equal(button('Cancel')?.disabled, false, 'Cancel is retryable if the host did not acknowledge it');
    await act(async () => button('Cancel').click());
    assert.deepEqual(cancelled, ['flow-1', 'flow-1']);
    assert.equal(button('Cancel'), undefined);
    assert.ok(button('Connect'));
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
