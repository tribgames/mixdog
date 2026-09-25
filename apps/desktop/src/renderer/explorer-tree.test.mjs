// Files pane cover at the seams the directory-state module and the inline edit
// row now sit behind: the first root listing, lazy expansion, the batched
// toolbar refresh, a partially failed delete, and the rename caret. Each case
// drives the rendered pane, so the extracted modules are pinned by behaviour
// rather than by shape.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

// React DOM decides ONCE, at module evaluation, whether the host supports
// native input events; evaluated without a document it falls back to the IE
// `onpropertychange` polyfill, which calls attachEvent on focus and never
// delivers onChange. So the DOM globals land first and react-dom/client plus
// the pane are imported afterwards (same order as goal-entry.test.mjs).
const DOM_GLOBALS = ['window', 'document', 'Node', 'HTMLElement', 'HTMLInputElement', 'Event', 'KeyboardEvent'];
const savedGlobals = DOM_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://mixdog.test/',
  pretendToBeVisual: true,
});
for (const key of DOM_GLOBALS) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => {
  dom.window.close();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

const { createRoot } = await import('react-dom/client');
const { FilesRootPane } = await import('./ExplorerTree.tsx');

const treeRows = () => [...document.querySelectorAll('[role="treeitem"]')];
// The label span is the only unclassed span in a row (twistie, Seti glyph and
// Git badge all carry classes).
const labelOf = (element) => element.querySelector('span:not([class])')?.textContent ?? '';
const rowNames = () => treeRows().map(labelOf);
const rowFor = (name) => treeRows().find((candidate) => labelOf(candidate) === name);
const click = (element) => act(async () => element.click());
const press = (element, key) =>
  act(async () => element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
// The native setter keeps React's value tracker honest, so the dispatched
// input/change pair reaches the pane's onChange instead of being deduped.
const type = (input, value) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });

function fixture(t, { listings, failing = new Set(), api = {}, strict = false }) {
  const calls = [];
  const opened = [];
  const readiness = [];
  window.mixdogDesktop = {
    listProjectDir: async (_project, rel) => {
      calls.push(rel);
      if (failing.has(rel)) throw new Error(`EACCES: ${rel} is not readable`);
      return (listings[rel] ?? []).map((entry) => ({ ...entry }));
    },
    ...api,
  };
  const host = document.createElement('main');
  const header = document.createElement('div');
  document.body.append(host, header);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    header.remove();
  });
  return {
    calls,
    opened,
    readiness,
    header,
    render: (props = {}) => {
      const pane = React.createElement(FilesRootPane, {
        projectPath: 'C:/demo',
        gitStatus: null,
        changed: new Set(),
        activeFileKey: '',
        active: true,
        readinessKey: 'files',
        onReadyChange: (key, ready) => readiness.push([key, ready]),
        onOpenFile: (_project, rel, mode) => opened.push([rel, mode]),
        headerSlot: header,
        ...props,
      });
      return act(async () => root.render(strict ? React.createElement(React.StrictMode, null, pane) : pane));
    },
  };
}

test('the first listing renders the sorted root and expanding lists only that folder', async (t) => {
  const view = fixture(t, {
    listings: {
      '': [
        { name: 'readme.md', dir: false },
        { name: 'src', dir: true },
      ],
      src: [{ name: 'main.ts', dir: false }],
    },
  });
  await view.render();
  assert.deepEqual(view.calls, ['']);
  assert.deepEqual(view.readiness, [
    ['files', false],
    ['files', true],
  ]);
  assert.deepEqual(rowNames(), ['src', 'readme.md']);

  await click(rowFor('src'));
  assert.deepEqual(view.calls, ['', 'src']);
  assert.deepEqual(rowNames(), ['src', 'main.ts', 'readme.md']);
  assert.equal(rowFor('src').getAttribute('aria-expanded'), 'true');
  assert.equal(rowFor('src').getAttribute('aria-selected'), 'true');

  // Folding and unfolding again are pure state: no repeated listing.
  await click(rowFor('src'));
  assert.deepEqual(rowNames(), ['src', 'readme.md']);
  await click(rowFor('src'));
  assert.deepEqual(view.calls, ['', 'src']);
  assert.deepEqual(rowNames(), ['src', 'main.ts', 'readme.md']);
});

test('a refresh re-lists the root and every expanded folder once and keeps rows a failed listing could not replace', async (t) => {
  const listings = {
    '': [
      { name: 'src', dir: true },
      { name: 'readme.md', dir: false },
    ],
    src: [{ name: 'main.ts', dir: false }],
  };
  const failing = new Set();
  const view = fixture(t, { listings, failing });
  await view.render();
  await click(rowFor('src'));
  view.calls.length = 0;

  listings[''] = [...listings[''], { name: 'added.txt', dir: false }];
  listings.src = [
    { name: 'main.ts', dir: false },
    { name: 'never-shown.ts', dir: false },
  ];
  failing.add('src');
  await click(view.header.querySelector('[aria-label="Refresh files"]'));

  assert.deepEqual([...view.calls].sort(), ['', 'src']);
  assert.deepEqual(rowNames(), ['src', 'main.ts', 'added.txt', 'readme.md']);
  // A refresh that could not read a folder stays silent; the rows it already
  // had remain, and nothing is reported as a tree error.
  assert.equal(document.querySelector('.error-notice'), null);
  assert.equal(view.header.querySelector('[aria-label="Refresh files"]').disabled, false);
});

// React may run a state updater more than once (StrictMode does so on every
// update), so the watcher refresh must not issue its listings from inside one.
test('a watched project change re-lists each expanded folder once, even when React replays the update', async (t) => {
  let notify = () => {};
  const view = fixture(t, {
    strict: true,
    listings: {
      '': [{ name: 'src', dir: true }],
      src: [{ name: 'main.ts', dir: false }],
    },
    api: {
      folderWatch: async () => undefined,
      folderUnwatch: async () => undefined,
      subscribeFolderChanges: (listener) => {
        notify = listener;
        return () => {
          notify = () => {};
        };
      },
    },
  });
  await view.render();
  // StrictMode's mount replay drops the first root listing; a readiness change
  // lists the root again outside that replay.
  await view.render({ readinessKey: 'files-watch' });
  await click(rowFor('src'));
  assert.deepEqual(rowNames(), ['src', 'main.ts']);
  view.calls.length = 0;

  await act(async () => notify('C:/demo'));
  assert.deepEqual(view.calls, ['', 'src']);
});

test('a failed delete keeps exactly the failed entry selected and surfaces the message', async (t) => {
  const trashed = [];
  const view = fixture(t, {
    listings: {
      '': [
        { name: 'keep.txt', dir: false },
        { name: 'locked.txt', dir: false },
      ],
    },
    api: {
      trashProjectEntry: async (_project, rel) => {
        trashed.push(rel);
        throw new Error('EBUSY: locked.txt is in use');
      },
    },
  });
  const previousConfirm = window.confirm;
  window.confirm = () => true;
  t.after(() => {
    window.confirm = previousConfirm;
  });
  await view.render();
  await click(rowFor('locked.txt'));
  view.calls.length = 0;

  await press(rowFor('locked.txt'), 'Delete');
  assert.deepEqual(trashed, ['locked.txt']);
  assert.equal(rowFor('locked.txt').getAttribute('aria-selected'), 'true');
  assert.equal(rowFor('keep.txt').getAttribute('aria-selected'), 'false');
  assert.match(document.querySelector('.error-notice').textContent, /locked\.txt/);
  // The parent folder is re-listed even though the entry survived.
  assert.deepEqual(view.calls, ['']);
});

test('F2 opens the inline rename with the basename pre-selected and Escape restores the row', async (t) => {
  const view = fixture(t, { listings: { '': [{ name: 'report.txt', dir: false }] } });
  await view.render();
  await click(rowFor('report.txt'));

  await press(rowFor('report.txt'), 'F2');
  const input = document.querySelector('.explorer-edit-row input');
  assert.ok(input);
  assert.equal(input.value, 'report.txt');
  assert.equal(document.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 'report'.length]);
  assert.equal(rowFor('report.txt'), undefined);

  await press(input, 'Escape');
  assert.equal(document.querySelector('.explorer-edit-row'), null);
  assert.ok(rowFor('report.txt'));
});

// The multi-select delete label must stay a catalog key: an interpolated
// literal ("Delete 2 items") matches no key and renders untranslated.
test('the multi-select delete menu item resolves through the translation catalog', async (t) => {
  const i18n = (await import('./i18n')).default;
  i18n.addResourceBundle('en', 'translation', { 'Delete {{name}}': 'Discard {{name}}' }, true, true);
  t.after(() => i18n.addResourceBundle('en', 'translation', { 'Delete {{name}}': 'Delete {{name}}' }, true, true));
  const view = fixture(t, {
    listings: {
      '': [
        { name: 'a.txt', dir: false },
        { name: 'b.txt', dir: false },
      ],
    },
  });
  await view.render();
  await click(rowFor('a.txt'));
  const mouse = (element, type, init) =>
    act(async () => element.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...init })));
  await mouse(rowFor('b.txt'), 'click', { ctrlKey: true });
  await mouse(rowFor('b.txt'), 'contextmenu');

  const remove = document.querySelector('.dock-file-menu button.danger span');
  assert.equal(remove.textContent, 'Discard 2 items');
});

test('a right-click on empty tree space or on the root header opens the project-root menu', async (t) => {
  const view = fixture(t, { listings: { '': [{ name: 'a.txt', dir: false }] } });
  await view.render({ showRootHeader: true });
  const contextMenu = (element) =>
    act(async () => element.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  const menuLabels = () =>
    [...document.querySelectorAll('.dock-file-menu [role="menuitem"] span:not([class])')].map(
      (label) => label.textContent
    );
  const rootMenu = ['New file…', 'New folder…', 'Paste', 'Reveal in Explorer', 'Copy path'];

  await contextMenu(document.querySelector('.dock-files-tree'));
  assert.deepEqual(menuLabels(), rootMenu);
  await act(async () => window.dispatchEvent(new window.Event('pointerdown')));
  assert.deepEqual(menuLabels(), []);

  await contextMenu(document.querySelector('.workbench-explorer-root'));
  assert.deepEqual(menuLabels(), rootMenu);
});

test('a nested new name creates the entry, expands each folder it introduced and opens the file', async (t) => {
  const listings = { '': [] };
  const created = [];
  const view = fixture(t, {
    listings,
    api: {
      createProjectEntry: async (_project, relDir, name, dir) => {
        created.push([relDir, name, dir]);
        listings[''] = [{ name: 'app', dir: true }];
        listings.app = [{ name: 'main.ts', dir: false }];
      },
    },
  });
  await view.render();
  await click(view.header.querySelector('[aria-label="New file"]'));
  const input = document.querySelector('.explorer-edit-row input');
  const editBox = () => document.querySelector('.explorer-edit-box');
  assert.ok(input);
  // An empty name blocks, so the bubble clearing after the keystrokes proves
  // the typed value really travelled through onChange into pane state.
  assert.equal(editBox().getAttribute('data-problem'), 'error');

  await type(input, 'app/main.ts');
  assert.equal(editBox().getAttribute('data-problem'), null);
  assert.equal(document.querySelector('.explorer-edit-row input').value, 'app/main.ts');

  await press(input, 'Enter');

  assert.deepEqual(created, [['', 'app/main.ts', false]]);
  assert.deepEqual(view.opened, [['app/main.ts', 'preview']]);
  assert.deepEqual(rowNames(), ['app', 'main.ts']);
  assert.equal(rowFor('main.ts').getAttribute('aria-selected'), 'true');
  assert.equal(document.querySelector('.explorer-edit-row'), null);
});
