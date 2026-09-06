import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mixdog.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLElement.prototype.attachEvent = () => {};
window.HTMLElement.prototype.detachEvent = () => {};
window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };
const { BuiltInFeaturesPanel } = await import('./built-in-features-panel.tsx');

test('Git & GitHub detail reuses saved account and commit settings without reconnecting or overwriting them', async () => {
  const changes = [];
  const preferences = { commitPreset: 'custom', commitExample: 'feat: 한글', commitInstructions: '한국어로 작성', autoCommitMessage: false };
  const api = {
    readSettings: async () => ({}),
    gitCliStatus: async () => ({ installed: true, version: '2.50' }),
    githubCliStatus: async () => ({ installed: true, authenticated: true, login: 'owner', version: '2.81' }),
    githubCliAccount: async () => ({ login: 'owner', name: 'Saved Owner', email: 'saved@example.com' }),
    readGitPreferences: async () => preferences,
    gitGlobalConfig: async () => ({ name: 'Manual identity', email: 'manual@example.com' }),
    setGitGlobalConfig: async (...args) => { changes.push(args); },
    updateGitPreferences: async (...args) => { changes.push(args); return preferences; },
    githubCliLoginStart: async () => { changes.push('login'); },
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(BuiltInFeaturesPanel, {
      api, data: { toolModules: { git: { installed: true, enabled: true } }, skills: { skills: [] } },
      snapshot: null, pending: '', run: async () => ({}), initialFeature: 'git',
    })));
    const dialog = document.querySelector('[data-feature-id="git"]');
    assert.ok(dialog);
    assert.match(dialog.textContent, /Git & GitHub/);
    assert.match(dialog.textContent, /saved@example.com/);
    assert.equal(dialog.querySelector('textarea[name="commitExample"]').value, 'feat: 한글');
    assert.equal(dialog.querySelector('textarea[name="commitInstructions"]').value, '한국어로 작성');
    assert.deepEqual(changes, []);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
