import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mixdog.test/' });
const globals = ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'];
const saved = globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
Object.defineProperties(globalThis, {
  window: { configurable: true, writable: true, value: dom.window },
  document: { configurable: true, writable: true, value: dom.window.document },
  navigator: { configurable: true, writable: true, value: { userAgent: 'Electron/41.0' } },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
});
after(() => {
  dom.window.close();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

// File routing and breadcrumbs do not need Monaco's browser-only providers.
// Keep the production routing and UI real, isolating only editor preloading
// and the unrelated layout-storage constant imported by the pane model.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === './editor-monaco-providers' ||
      specifier === './monaco-setup' ||
      specifier === './lazy-widgets' ||
      specifier.endsWith('.css')
    ) {
      return next(new URL('./test-fixtures/editor-opening-deps.mjs', import.meta.url).href, context);
    }
    return next(specifier, context);
  },
});
after(() => hooks.deregister());

const { createRoot } = await import('react-dom/client');
const { useEditorNavigation } = await import('./use-editor-navigation.ts');
const { EditorBreadcrumbs } = await import('./editor-breadcrumbs.tsx');
const { DESKTOP_TOAST_EVENT } = await import('./desktop-toasts.tsx');

async function mountNavigation(t, api) {
  window.mixdogDesktop = api;
  const opened = [];
  const tabs = [];
  const current = { value: null };
  function Harness() {
    current.value = useEditorNavigation({
      setTabs: (update) => tabs.push(update),
      openSelectionInFocusedPane: (...args) => opened.push(args),
    });
    return null;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Harness)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { current, tabs, opened };
}

test('desktop document clicks launch the default app without tabs, reads or navigation history', async (t) => {
  const external = [];
  const reads = [];
  const view = await mountNavigation(t, {
    openFilePath: async (...args) => external.push(args),
    readProjectFile: async (...args) => reads.push(args),
  });
  for (const rel of ['deck.pptx', 'legacy.ppt', 'report.docx', 'sheet.xlsx', 'image.tiff', 'movie.mkv']) {
    await act(async () => view.current.value.openFileTab(' C:/Project/demo ', `docs\\${rel}`, undefined, 'grant'));
    assert.deepEqual(external.at(-1), ['C:/Project/demo', `docs/${rel}`, 'grant']);
  }
  assert.equal(external.length, 6);
  assert.deepEqual(reads, []);
  assert.deepEqual(view.tabs, []);
  assert.deepEqual(view.opened, []);
  assert.deepEqual(view.current.value.editorNavigationHistory.current.entries, []);
});

test('a failed external launch reports the error without opening a blank editor', async (t) => {
  const notices = [];
  const receive = (event) => notices.push(event.detail);
  window.addEventListener(DESKTOP_TOAST_EVENT, receive);
  t.after(() => window.removeEventListener(DESKTOP_TOAST_EVENT, receive));
  const view = await mountNavigation(t, {
    openFilePath: async () => {
      throw new Error('No application is associated with this file.');
    },
  });
  await act(async () => view.current.value.openFileTab('C:/Project/demo', 'deck.pptx'));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].tone, 'error');
  assert.match(notices[0].text, /No application is associated/);
  assert.deepEqual(view.tabs, []);
  assert.deepEqual(view.opened, []);
});

test('native previews, text and unsafe files retain editor routing without launching apps', async (t) => {
  const external = [];
  const view = await mountNavigation(t, { openFilePath: async (...args) => external.push(args) });
  const names = ['image.png', 'report.pdf', 'audio.mp3', 'movie.mp4', 'note.md', 'run.exe', 'deck.pptm', 'data.bin'];
  for (const rel of names) {
    await act(async () => view.current.value.openFileTab('C:/Project/demo', rel));
    assert.equal(view.opened.at(-1)[0].rel, rel);
  }
  assert.deepEqual(external, []);
  assert.equal(view.tabs.length, names.length);
});

test('remote document clicks keep their internal page-viewer tab instead of calling the inert OS bridge', async (t) => {
  const previous = navigator.userAgent;
  navigator.userAgent = 'Mozilla/5.0';
  t.after(() => {
    navigator.userAgent = previous;
  });
  const external = [];
  const view = await mountNavigation(t, { openFilePath: async (...args) => external.push(args) });
  await act(async () => view.current.value.openFileTab('C:/Project/demo', 'deck.pptx'));
  assert.deepEqual(external, []);
  assert.equal(view.tabs.length, 1);
  assert.equal(view.opened[0][0].rel, 'deck.pptx');
});

test('the external-open escape stays visible even for a successfully loaded PDF preview', async (t) => {
  const opened = [];
  window.mixdogDesktop = { openFilePath: async (...args) => opened.push(args) };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () =>
    root.render(
      React.createElement(EditorBreadcrumbs, {
        projectPath: 'C:/Project/demo',
        relPath: 'report.pdf',
        accessToken: 'grant',
        load: { content: '', binary: true, tooLarge: false, mtimeMs: 1, encoding: 'utf8' },
        preview: {
          kind: 'pdf',
          mime: 'application/pdf',
          url: 'mixdog-media://preview/token/report.pdf',
          mtimeMs: 1,
          size: 1,
        },
        dirty: false,
        saving: false,
        reverting: false,
        cursorLine: 1,
        outline: [],
        problemStatus: { errors: 0, warnings: 0 },
        onSave() {},
        onRevert() {},
        onShowProblems() {},
        onFocusEditor() {},
        onRevealSymbol() {},
      })
    )
  );
  const button = host.querySelector('.editor-breadcrumb-actions button');
  assert.ok(button);
  await act(async () => button.click());
  assert.deepEqual(opened, [['C:/Project/demo', 'report.pdf', 'grant']]);
});
