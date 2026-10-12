import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after } from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  actEnvironment: false,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Fakes for the browser-bound modules: Monaco, the Markdown renderer and the poll cadence.
const fake = (source) => ({ url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true });
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './monaco-setup') {
      return fake(`
        const state = () => globalThis.__fakeMonaco;
        export const monaco = {
          Uri: { parse: (value) => ({ toString: () => value }) },
          editor: {
            getModel: (uri) => state().models.get(uri.toString()) ?? null,
            onDidCreateModel: (listener) => {
              state().created.add(listener);
              return { dispose: () => state().created.delete(listener) };
            },
          },
        };`);
    }
    if (specifier === './EditorTextViews') {
      return fake(`
        import React from 'react';
        export const EditorMarkdownPreview = ({ text }) => React.createElement('pre', { 'data-preview': '' }, text);`);
    }
    if (specifier === './editor-disk-watch') {
      return fake(`
        export const startEditorDiskWatch = (win, check) => {
          globalThis.__fakeMonaco.tick = check;
          return () => { globalThis.__fakeMonaco.tick = null; };
        };`);
    }
    return next(specifier, context);
  },
});
after(() => {
  hooks.deregister();
  restore();
});

function fakeModel(uri, value) {
  const content = new Set();
  const disposal = new Set();
  return {
    uri: { toString: () => uri },
    value,
    getValue() {
      return this.value;
    },
    onDidChangeContent: (listener) => (content.add(listener), { dispose: () => content.delete(listener) }),
    onWillDispose: (listener) => (disposal.add(listener), { dispose: () => disposal.delete(listener) }),
    edit(next) {
      this.value = next;
      for (const listener of [...content]) listener();
    },
    dispose() {
      for (const listener of [...disposal]) listener();
      globalThis.__fakeMonaco.models.delete(uri);
    },
  };
}

test('side preview follows model edits, then disk after the model is disposed, and shows read errors', async () => {
  const { default: EditorSideMarkdownPreview } = await import('./editor-side-markdown-preview.tsx');
  const abs = 'C:/p/doc.md';
  globalThis.__fakeMonaco = { models: new Map(), created: new Set(), tick: null };
  const model = fakeModel(abs, 'unsaved edit');
  globalThis.__fakeMonaco.models.set(abs, model);
  const disk = { content: 'saved v1', mtimeMs: 1, fail: false };
  window.mixdogDesktop = {
    readProjectFile: async () => {
      if (disk.fail) throw new Error('read exploded');
      return { content: disk.content, mtimeMs: disk.mtimeMs, binary: false, tooLarge: false };
    },
    statProjectFile: async () => ({ mtimeMs: disk.mtimeMs, size: 0 }),
  };
  const host = document.createElement('div');
  document.querySelector('main').append(host);
  const root = createRoot(host);
  const shown = () => host.querySelector('[data-preview]')?.textContent;
  try {
    await act(async () =>
      root.render(
        React.createElement(EditorSideMarkdownPreview, {
          projectPath: 'C:/p',
          relPath: 'doc.md',
          onSideChrome() {},
        })
      )
    );
    assert.equal(shown(), 'unsaved edit');
    await act(async () => model.edit('unsaved edit 2'));
    assert.equal(shown(), 'unsaved edit 2');
    // The source tab closes and discards its changes: the saved file shows.
    await act(async () => model.dispose());
    assert.equal(shown(), 'saved v1');
    // Later disk changes keep it updated.
    disk.content = 'saved v2';
    disk.mtimeMs = 2;
    await act(async () => globalThis.__fakeMonaco.tick());
    assert.equal(shown(), 'saved v2');
    // Read errors are shown, not swallowed.
    disk.fail = true;
    disk.mtimeMs = 3;
    await act(async () => globalThis.__fakeMonaco.tick());
    assert.match(host.querySelector('[role="alert"]').textContent, /read exploded/);
  } finally {
    await act(async () => root.unmount());
  }
});

test('side preview disk polling is single-flight and ignores stale responses', async () => {
  const { default: EditorSideMarkdownPreview } = await import('./editor-side-markdown-preview.tsx');
  const abs = 'C:/p/poll.md';
  globalThis.__fakeMonaco = { models: new Map(), created: new Set(), tick: null };
  let stats = 0;
  const pending = [];
  window.mixdogDesktop = {
    readProjectFile: async () => ({ content: 'disk', mtimeMs: 1, binary: false, tooLarge: false }),
    statProjectFile: () => {
      stats += 1;
      return new Promise((resolve) => pending.push(resolve));
    },
  };
  const host = document.createElement('div');
  document.querySelector('main').append(host);
  const root = createRoot(host);
  const shown = () => host.querySelector('[data-preview]')?.textContent;
  try {
    await act(async () =>
      root.render(
        React.createElement(EditorSideMarkdownPreview, { projectPath: 'C:/p', relPath: 'poll.md', onSideChrome() {} })
      )
    );
    assert.equal(shown(), 'disk');
    for (let i = 0; i < 20; i += 1) await act(async () => globalThis.__fakeMonaco.tick());
    assert.equal(stats, 1, 'one stat in flight, later ticks skipped');
    // A model appears while the stat is pending: its late answer must not overwrite it.
    const model = fakeModel(abs, 'live');
    await act(async () => {
      globalThis.__fakeMonaco.models.set(abs, model);
      for (const listener of [...globalThis.__fakeMonaco.created]) listener(model);
    });
    await act(async () => pending[0]({ mtimeMs: 9, size: 0 }));
    assert.equal(shown(), 'live');
  } finally {
    await act(async () => root.unmount());
  }
});
