import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><div id="root"></div></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
});

const { useProjectEntryRename } = await import('./use-project-entry-rename.ts');
const { navigationKey } = await import('../text-format.ts');
const { sideFileDirtyKey, sideFileKey } = await import('../side-file-tabs.ts');
const { withPaneDockFilesRetargeted } = await import('../pane-side-dock-model.ts');

const project = 'C:\\work\\demo';
const file = (rel) => ({ kind: 'file', project, rel });

async function mountRename(t, { leaves, docks = {}, dirty = [], dirtySide = [] }) {
  const renamed = [];
  const promoted = [];
  const registered = [];
  const retargets = [];
  window.mixdogDesktop = {
    renameProjectEntry: async (...args) => {
      renamed.push(args);
    },
  };
  let rename = null;
  const dirtyKeys = new Set([...dirty.map(navigationKey), ...dirtySide.map(sideFileDirtyKey)]);
  function Harness() {
    rename = useProjectEntryRename({
      paneWorkspace: {
        leaves,
        promoteInLeaf: (leafId, selection, replaceKey) => promoted.push([leafId, selection.rel, replaceKey]),
      },
      paneSideDocks: { docks, retargetFiles: (retarget) => retargets.push(retarget) },
      dirtyFileKeys: dirtyKeys,
      registerWorkspaceSelection: (selection, title, replaceKey) => registered.push([selection.rel, title, replaceKey]),
    });
    return null;
  }
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Harness)));
  t.after(async () => {
    await act(async () => root.unmount());
    delete window.mixdogDesktop;
  });
  return { rename: (...args) => rename(...args), renamed, promoted, registered, retargets, dirtyKeys };
}

test('renaming an open file retargets its tab to the new name', async (t) => {
  const view = await mountRename(t, {
    leaves: [{ id: 'left', tabs: [file('src/a.ts'), file('src/b.ts'), { kind: 'new', draftId: 'd' }] }],
  });
  await view.rename(project, 'src/a.ts', 'c.ts');
  assert.deepEqual(view.renamed, [[project, 'src/a.ts', 'c.ts']]);
  assert.deepEqual(view.promoted, [['left', 'src/c.ts', navigationKey(file('src/a.ts'))]]);
  assert.deepEqual(view.registered, [['src/c.ts', 'c.ts', navigationKey(file('src/a.ts'))]]);
});

test('renaming a folder moves every open tab inside it, in every pane', async (t) => {
  const view = await mountRename(t, {
    leaves: [
      { id: 'left', tabs: [file('src/x/a.ts'), file('src/xy.ts')] },
      // Another spelling of the same project path still matches.
      { id: 'right', tabs: [{ kind: 'file', project: 'c:/work/demo/', rel: 'src/x/y/b.ts' }] },
    ],
  });
  await view.rename(project, 'src/x', 'z');
  assert.deepEqual(
    view.promoted.map(([leafId, rel]) => [leafId, rel]),
    [
      ['left', 'src/z/a.ts'],
      ['right', 'src/z/y/b.ts'],
    ]
  );
});

test('renaming a folder moves its side-dock file tabs, held ones included, and an unsaved one refuses it', async (t) => {
  const sideFile = (rel) => ({ project, rel, nonce: 1, openedAt: 1 });
  const moved = sideFile('src/x/a.ts');
  const held = sideFile('src/x/y/b.ts');
  const other = sideFile('src/xy.ts');
  const entry = {
    open: true,
    view: null,
    surface: 'file',
    diff: null,
    files: [moved, other],
    activeFile: sideFileKey(moved),
    owner: 's1',
    held: { s2: { open: true, surface: 'file', diff: null, files: [held], activeFile: sideFileKey(held) } },
  };
  const view = await mountRename(t, { leaves: [], docks: { right: entry }, dirtySide: [held] });
  await assert.rejects(view.rename(project, 'src/x', 'z'), /b\.ts/);
  assert.deepEqual(view.renamed, [], 'nothing moves on disk while a side tab holds unsaved edits');
  assert.deepEqual(view.retargets, []);

  view.dirtyKeys.clear();
  await view.rename(project, 'src/x', 'z');
  assert.equal(view.retargets.length, 1);
  const next = withPaneDockFilesRetargeted(entry, view.retargets[0]);
  assert.deepEqual(
    next.files.map((f) => f.rel),
    ['src/z/a.ts', 'src/xy.ts']
  );
  assert.equal(next.activeFile, sideFileKey(next.files[0]), 'the active tab stays active on its new path');
  assert.deepEqual(
    next.held.s2.files.map((f) => f.rel),
    ['src/z/y/b.ts']
  );
  assert.equal(next.held.s2.activeFile, sideFileKey(next.held.s2.files[0]));
});

test('a path with unsaved edits is refused before anything moves on disk', async (t) => {
  const view = await mountRename(t, {
    leaves: [{ id: 'left', tabs: [file('src/a.ts')] }],
    dirty: [file('src/a.ts')],
  });
  await assert.rejects(view.rename(project, 'src', 'lib'), /a\.ts/);
  assert.deepEqual(view.renamed, []);
  assert.deepEqual(view.promoted, []);
});
