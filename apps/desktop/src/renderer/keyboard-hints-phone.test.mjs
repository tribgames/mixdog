// Keyboard hints are meaningless on a touch-only phone: each surface that
// carried one shows it on desktop and drops it under the phone marker
// (`html[data-mixdog-mobile-tabs]`). Rendered, not shape-checked.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

/** Mount `build()` on a fresh window (`phone` installs the phone UA and root marker first), hand the
 *  document to `check`, then unmount and restore the globals so the next surface starts clean. */
async function onSurface({ phone, build }, check) {
  const { root, document, window, restore } = installTestDom(null, {
    rootId: 'root',
    expose: ['navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Element', 'KeyboardEvent', 'MutationObserver'],
  });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.Element.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  if (phone) {
    Object.defineProperty(window.navigator, 'userAgent', { configurable: true, get: () => PHONE_UA });
    document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
  }
  try {
    await act(async () => root.render(await build()));
    return await check(document);
  } finally {
    await act(async () => root.unmount());
    restore();
    delete globalThis.ResizeObserver;
  }
}

test('the empty workspace lists keyboard shortcuts on desktop and drops the whole list on the phone', async () => {
  const build = async () => {
    const { WorkspaceEmptyState } = await import('./WorkspaceEmptyState.tsx');
    return React.createElement(WorkspaceEmptyState);
  };
  await onSurface({ phone: false, build }, (document) =>
    assert.deepEqual(
      [...document.querySelectorAll('.welcome-shortcuts kbd')].map((node) => node.textContent).slice(0, 2),
      ['Ctrl', 'N']
    )
  );
  await onSurface({ phone: true, build }, (document) => {
    assert.equal(document.querySelector('.welcome-shortcuts'), null, 'no orphan labels without their keys');
    assert.equal(document.querySelectorAll('kbd').length, 0);
  });
});

test('a mounted surface follows the phone marker both ways as the layout flips', async () => {
  const build = async () => {
    const { WorkspaceEmptyState } = await import('./WorkspaceEmptyState.tsx');
    return React.createElement(WorkspaceEmptyState);
  };
  await onSurface({ phone: false, build }, async (document) => {
    const list = () => document.querySelector('.welcome-shortcuts');
    assert.ok(list(), 'desktop shows the list');
    await act(async () => document.documentElement.setAttribute('data-mixdog-mobile-tabs', ''));
    assert.equal(list(), null, 'the phone marker hides it at once');
    await act(async () => document.documentElement.removeAttribute('data-mixdog-mobile-tabs'));
    assert.ok(list(), 'back on desktop it returns');
  });
});

test('the question card hint names Enter and ← on desktop and only the selection count on the phone', async () => {
  const questions = [
    { question: 'Which?', header: 'W', multi_select: true, options: [{ label: 'A', description: '' }] },
    { question: 'Keep?', header: 'K', options: [{ label: 'Yes', description: '' }] },
  ];
  const build = async () => {
    const { QuestionCard } = await import('./QuestionCard.tsx');
    return React.createElement(QuestionCard, { questions, draftsRef: { current: [] }, resolve: async () => true });
  };
  const hint = (document) => document.querySelector('.question-hint').textContent;
  await onSurface({ phone: false, build }, (document) => assert.equal(hint(document), 'Enter Skip'));
  await onSurface({ phone: true, build }, async (document) => {
    assert.equal(hint(document), '');
    await act(async () => document.querySelector('.question-option').click());
    assert.equal(hint(document), '1 selected', 'the count stays; the key names go');
  });
});

test('the side-question card says only "Answering…" on the phone, not "Esc to cancel"', async () => {
  const build = async () => {
    const { BtwCard } = await import('./BtwCard.tsx');
    return React.createElement(BtwCard, {
      card: { status: 'pending', question: 'q', text: '' },
      onClose() {},
      onRetry() {},
    });
  };
  const text = (document) => document.querySelector('.btw-pending').textContent;
  await onSurface({ phone: false, build }, (document) => assert.equal(text(document), 'Answering… · Esc to cancel'));
  await onSurface({ phone: true, build }, (document) => assert.equal(text(document), 'Answering…'));
});

test('Settings lists the Shortcuts page on desktop and hides it on the phone', async () => {
  const api = {
    async readCapabilities(requests) {
      return requests.map(() => ({ ok: true, value: null }));
    },
    async invokeCapability() {
      return { value: null, snapshot: null };
    },
    async listProviderModels() {
      return [];
    },
    async getSnapshot() {
      return null;
    },
    async getUpdaterState() {
      return { status: 'idle' };
    },
    async checkForDesktopUpdate() {
      return { status: 'idle' };
    },
    subscribeState: () => () => {},
    subscribeUpdaterState: () => () => {},
  };
  const build = async () => {
    const { SettingsView } = await import('./settings/SettingsView.tsx');
    return React.createElement(SettingsView, { api, open: true, onClose() {} });
  };
  const rail = (document) =>
    [...document.querySelectorAll('.mixdog-settings__rail-group button')].map((b) => b.getAttribute('aria-label'));
  await onSurface({ phone: false, build }, (document) => assert.ok(rail(document).includes('Shortcuts')));
  await onSurface({ phone: true, build }, (document) => {
    const labels = rail(document);
    assert.ok(labels.includes('General') && !labels.includes('Shortcuts'));
  });
});
