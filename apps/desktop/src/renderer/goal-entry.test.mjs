import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('/goal and the add menu open the same goal editor without creating or failing a goal', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
    url: 'https://mixdog.test/',
    pretendToBeVisual: true,
  });
  for (const key of [
    'window',
    'document',
    'Node',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'Event',
    'CustomEvent',
    'MutationObserver',
    'getComputedStyle',
  ]) {
    globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  const { createRoot } = await import('react-dom/client');
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const calls = [];
  window.mixdogDesktop = {
    readCapabilities: async (requests) => requests.map(() => ({ ok: true, value: [] })),
    invokeCapability: async (request) => {
      calls.push(request);
      return { value: { ok: true } };
    },
    onFocusComposer: () => () => {},
  };
  const directory = mkdtempSync(join(fileURLToPath(new URL('../../', import.meta.url)), '.goal-entry-'));
  const host = document.getElementById('root');
  const root = createRoot(host);
  try {
    const outfile = join(directory, 'composer.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('./Composer.tsx', import.meta.url))],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      jsx: 'automatic',
      loader: { '.css': 'empty' },
    });
    const { Composer } = await import(pathToFileURL(outfile).href);
    const noop = () => {};
    const props = {
      turnBusy: false,
      commandBusy: false,
      transitioning: false,
      focusRequest: 0,
      historyScope: 'goal-entry',
      identityScope: 'draft:goal-entry',
      recoveryScope: 'goal-entry',
      projectScope: '',
      hasConversation: false,
      provider: 'openai',
      model: 'model',
      effort: 'medium',
      fast: false,
      fastCapable: false,
      draftMode: true,
      dropTargetRef: { current: null },
      submit: async () => {
        calls.push('submit');
        return true;
      },
      abort: async () => {},
      invokeResult: async (fn) => fn(),
      applySnapshot: noop,
      onNewTask: noop,
      onResumeSession: noop,
      onOpenSessions: noop,
      onOpenProjects: noop,
      onOpenSettings: noop,
      onOpenCommandSurface: noop,
    };
    await act(async () => root.render(React.createElement(Composer, props)));
    await act(async () => host.querySelector('[aria-label="Add to message"]').click());
    await act(async () =>
      [...document.querySelectorAll('[role="menuitem"]')]
        .find((node) => node.textContent.includes('Set a goal'))
        .click()
    );
    let dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(dialog.querySelector('[role="combobox"]').textContent, 'Maximum time — finish early when verified');
    await act(async () => dialog.querySelector('[aria-label="Close"]').click());
    const input = host.querySelector('textarea');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, '/goal');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () =>
      input.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    );
    dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog, 'bare /goal opens the same editor');
    assert.equal(dialog.querySelector('[role="combobox"]').textContent, 'Maximum time — finish early when verified');
    assert.deepEqual(
      calls.filter((call) => call === 'submit' || call?.capability === 'goalControl'),
      [],
      'opening an editor does not send a goal command or a message'
    );
    assert.equal(host.textContent.includes('Usage: /goal'), false);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
