import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import {
  PaneSideDock,
  normalizePaneSideDocks,
  paneDockActiveRoot,
  paneFilesShowing,
  samePaneSideDocks,
  usePaneSideDocks,
  withPaneDockFileOpened,
  withPaneDockFolderClosed,
  withPaneDockFolderOpened,
} from './pane-side-dock.tsx';
import { PaneDockFilesSurface } from './pane-dock-files.tsx';
import { sessionSideDockEntryForSession } from './session-side-surface-policy.ts';

const RIGHT = [['source-control'], ['browser'], ['terminal']];
const closed = { open: false, view: 'source-control', surface: '', diff: null };
const folderLink = { project: 'C:/p', rel: 'assets' };

test('a folder link opens the Files surface, replaces in place, persists and closes', () => {
  let entry = withPaneDockFolderOpened(closed, folderLink, 1);
  assert.equal(entry.open, true);
  assert.equal(entry.surface, 'files');
  assert.deepEqual(entry.folder, { ...folderLink, nonce: 1 });
  assert.equal(paneFilesShowing(entry), true);
  assert.equal(paneDockActiveRoot(entry), null);
  entry = withPaneDockFolderOpened(entry, { project: 'C:/p', rel: 'src' }, 2);
  assert.equal(entry.folder.rel, 'src');
  const restored = normalizePaneSideDocks(JSON.parse(JSON.stringify({ a: entry })), ['a'], RIGHT, false);
  assert.deepEqual(restored.a.folder, entry.folder);
  assert.equal(restored.a.surface, 'files');
  assert.ok(!samePaneSideDocks(restored, { a: { ...restored.a, folder: undefined } }));
  // A session's browser surface does not hide the revealed folder.
  assert.equal(sessionSideDockEntryForSession(restored.a, 'sess', 'browser').surface, 'files');
  // Opening a file from the tree follows the side-file rule: the editor takes the body.
  const withFile = withPaneDockFileOpened(entry, { project: 'C:/p', rel: 'src/a.ts' }, 3);
  assert.equal(withFile.surface, 'file');
  assert.equal(withFile.folder.rel, 'src', 'the tree stays mounted behind the editor');
  entry = withPaneDockFolderClosed(entry);
  assert.equal(entry.folder, undefined);
  assert.equal(entry.surface, '');
});

test('opening a folder touches only the pane dock, never the left side panel state', async (t) => {
  const { dom, root } = installTestDom(t, { rootId: 'root' });
  // Left sidebar / side-panel preferences live outside the dock store.
  dom.window.localStorage.setItem('mixdog.desktop.sidebar-view', 'sessions');
  dom.window.localStorage.setItem('mixdog.desktop.sidebar-open', 'true');
  const before = { ...dom.window.localStorage };
  let docks;
  function Harness() {
    docks = usePaneSideDocks({ leafIds: ['p1', 'p2'], groups: RIGHT });
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
  const other = docks.docks.p2;
  await act(async () => docks.openFolder('p1', 'C:/p', 'assets/'));
  assert.equal(docks.docks.p1.surface, 'files');
  assert.equal(docks.docks.p1.folder.rel, 'assets');
  assert.equal(docks.docks.p2, other, 'other panes are untouched');
  const after = { ...dom.window.localStorage };
  delete after['mixdog.desktop.pane-side-dock.v1'];
  delete before['mixdog.desktop.pane-side-dock.v1'];
  assert.deepEqual(after, before);
});

test('the dock Files view reveals the folder under the single DockHeaderRow', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node'],
  });
  dom.window.requestAnimationFrame = (callback) => {
    callback(16);
    return 1;
  };
  dom.window.cancelAnimationFrame = () => {};
  const tree = {
    '': [
      { name: 'assets', dir: true },
      { name: 'src', dir: true },
    ],
    assets: [
      { name: 'img', dir: true },
      { name: 'logo.png', dir: false },
    ],
  };
  dom.window.mixdogDesktop = { listProjectDir: async (_project, rel) => tree[rel] ?? [] };
  const opened = [];
  const Icon = () => React.createElement('span');
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () =>
      root.render(
        React.createElement(PaneSideDock, {
          leafId: 'pane-1',
          groups: [['source-control']],
          descriptors: new Map([['source-control', { id: 'source-control', label: 'Source Control', icon: Icon }]]),
          focused: true,
          onSelect() {},
          onClose() {},
          onCloseDiff() {},
          onMoveGroup() {},
          onMoveView() {},
          onFocusPane() {},
          openFileTab() {},
          renderView: () => null,
          renderFilesSurface: (folder, active, side) =>
            React.createElement(PaneDockFilesSurface, {
              folder,
              active,
              onOpenFile: (...args) => opened.push(args),
              onClose: side.onClose,
            }),
          entry: withPaneDockFolderOpened(closed, folderLink, 1),
        })
      )
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(document.querySelectorAll('.dock-header-row').length, 1);
    const header = document.querySelector('.dock-header-row');
    assert.equal(header.querySelector('.dock-header-chip').textContent, 'assets');
    const labels = [...header.querySelectorAll('.dock-header-controls .browser-pane-nav-button')].map((b) =>
      b.getAttribute('aria-label')
    );
    // Claude header rule: only ⋯, Expand and Close are inline; Refresh lives in ⋯.
    assert.deepEqual(labels, ['More actions', 'Expand', 'Close panel']);
    const rows = [...document.querySelectorAll('[aria-level]')];
    const assets = rows.find((row) => row.textContent.includes('assets'));
    assert.equal(assets.getAttribute('aria-expanded'), 'true', 'the target folder is expanded');
    assert.equal(assets.getAttribute('aria-selected'), 'true', 'and selected');
    assert.ok(
      rows.some((row) => row.textContent.includes('logo.png')),
      'its children are listed'
    );
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
