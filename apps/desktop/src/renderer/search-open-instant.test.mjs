// Opening Search and typing into it paint finished frames: the dock chunk
// renders synchronously once loaded, the file tree opens on its cached root,
// the phone drawer waits for the chunk, and a new query never blanks the list.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act, useLayoutEffect } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['Node', 'HTMLElement', 'HTMLInputElement', 'Event', 'KeyboardEvent', 'navigator'],
  globals: {
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  },
});
after(restore);

const { createRoot } = await import('react-dom/client');
const { SearchPane } = await import('./SearchPane.tsx');
const { FilesRootPane } = await import('./ExplorerTree.tsx');
const {
  explorerRootSettled,
  loadExplorerRoot,
  peekExplorerRoot,
  peekExplorerRootFailure,
  prefetchExplorerRoot,
  pruneExplorerRoots,
  refreshExplorerRoot,
  resetExplorerRootCache,
  retainExplorerRoot,
  setCurrentExplorerProject,
} = await import('./explorer-root-cache.ts');

const ROOT_ENTRIES = [
  { name: 'src', dir: true },
  { name: 'readme.md', dir: false },
];

function mount(t) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { host, render: (node) => act(async () => root.render(node)) };
}

const controlled = () => Promise.withResolvers();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const type = (input, value) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });

test('typing a query keeps the tree, then the previous list, up until the next results land', async (t) => {
  resetExplorerRootCache();
  const searches = [];
  window.mixdogDesktop = {
    listProjectDir: async () => ROOT_ENTRIES.map((entry) => ({ ...entry })),
    searchProjectFiles: (_project, query) => {
      const read = controlled();
      searches.push({ query, read });
      return read.promise;
    },
  };
  const view = mount(t);
  await view.render(
    React.createElement(SearchPane, { projectPath: 'C:/demo', gitStatus: null, active: true, headerActionSlot: null })
  );
  const explorer = () => view.host.querySelector('.workbench-explorer');
  const input = view.host.querySelector('.workbench-search-input input');
  const empties = () => [...view.host.querySelectorAll('.utility-dock-empty')].map((node) => node.textContent);
  assert.ok(view.host.querySelector('[role="treeitem"]'), 'idle: the file tree');

  await type(input, 'set');
  // The keystroke's own commit and the debounce wait: the tree stays, nothing
  // reads "No matching files." or "Searching…" in place of it.
  assert.ok(view.host.querySelector('[role="treeitem"]'), 'tree kept while the first search is pending');
  assert.deepEqual(empties(), []);
  assert.equal(explorer().getAttribute('aria-busy'), 'true');
  assert.equal(view.host.querySelector('[role="status"].sr-only').textContent, 'Searching…');
  await act(async () => sleep(150));
  assert.equal(searches.length, 1);
  assert.deepEqual(empties(), []);

  await act(async () => searches[0].read.resolve(['src/a.ts', 'src/b.ts']));
  assert.equal(view.host.querySelectorAll('.workbench-search-name-row').length, 2);
  assert.equal(explorer().getAttribute('aria-busy'), null);

  await type(input, 'setx');
  assert.equal(view.host.querySelectorAll('.workbench-search-name-row').length, 2, 'previous list kept while pending');
  assert.deepEqual(empties(), []);
  await act(async () => sleep(150));
  await act(async () => searches[1].read.resolve([]));
  assert.deepEqual(empties(), ['No matching files.']);
  assert.equal(explorer().getAttribute('aria-busy'), null);

  await type(input, '');
  assert.ok(view.host.querySelector('[role="treeitem"]'), 'clearing the query shows the tree at once');
  assert.deepEqual(empties(), []);
});

test('the file tree opens on its prefetched root in the first committed frame and revalidates behind it', async (t) => {
  resetExplorerRootCache();
  setCurrentExplorerProject('C:/demo');
  const reads = [];
  window.mixdogDesktop = {
    listProjectDir: (_project, rel) => {
      const read = controlled();
      reads.push({ rel, read });
      return read.promise;
    },
  };
  const warm = prefetchExplorerRoot(window.mixdogDesktop, 'C:/demo');
  reads[0].read.resolve(ROOT_ENTRIES);
  await warm;
  const view = mount(t);
  let firstFrame = null;
  function FirstPaint({ children }) {
    useLayoutEffect(() => {
      firstFrame ??= [...view.host.querySelectorAll('[role="treeitem"]')].length;
    });
    return children;
  }
  await view.render(
    React.createElement(
      FirstPaint,
      null,
      React.createElement(FilesRootPane, {
        projectPath: 'C:/demo',
        gitStatus: null,
        changed: new Set(),
        activeFileKey: '',
        active: true,
        readinessKey: 'files',
        onReadyChange() {},
      })
    )
  );
  assert.equal(firstFrame, 2, 'the cached root paints with the mount');
  assert.equal(reads.length, 2, 'opening revalidates with one read');
  await act(async () => reads[1].read.resolve([...ROOT_ENTRIES, { name: 'new.txt', dir: false }]));
  assert.equal(view.host.querySelectorAll('[role="treeitem"]').length, 3);
});

test('open intent and the gated open share one root read; the tree then paints rows in its first frame', async (t) => {
  resetExplorerRootCache();
  setCurrentExplorerProject('C:/demo');
  const reads = [];
  window.mixdogDesktop = {
    listProjectDir: (_project, rel) => {
      const read = controlled();
      reads.push({ rel, read });
      return read.promise;
    },
  };
  const warm = prefetchExplorerRoot(window.mixdogDesktop, 'C:/demo');
  const gate = loadExplorerRoot(window.mixdogDesktop, 'C:/demo');
  assert.equal(reads.length, 1, 'one read in flight serves the warm-up and the open');
  assert.equal(peekExplorerRoot('C:/demo'), undefined);
  reads[0].read.resolve(ROOT_ENTRIES);
  await Promise.all([warm, gate]);
  const view = mount(t);
  let firstFrame = null;
  function FirstPaint({ children }) {
    useLayoutEffect(() => {
      firstFrame ??= view.host.querySelectorAll('[role="treeitem"]').length;
    });
    return children;
  }
  await view.render(
    React.createElement(
      FirstPaint,
      null,
      React.createElement(FilesRootPane, {
        projectPath: 'C:/demo',
        gitStatus: null,
        changed: new Set(),
        activeFileKey: '',
        active: true,
        readinessKey: 'files',
        onReadyChange() {},
      })
    )
  );
  assert.equal(firstFrame, 2, 'the open that waited for the read paints its rows in the first frame');
  await act(async () => reads[1].read.resolve(ROOT_ENTRIES));
});
test('the dock chunk renders synchronously once it is loaded, with no placeholder frame', async (t) => {
  resetExplorerRootCache();
  window.mixdogDesktop = {
    listProjectDir: async () => [],
    listProjects: async () => [],
    gitStatus: async () => null,
    rendererDiagnostic() {},
  };
  const { SnapshotUtilityDock, utilityDockModule } = await import('./app-snapshot-views.tsx');
  await utilityDockModule.load();
  const store = { getSnapshot: () => ({}), subscribe: () => () => {} };
  const view = mount(t);
  const frames = [];
  function Observe({ children }) {
    useLayoutEffect(() => {
      frames.push({
        placeholder: Boolean(view.host.querySelector('.initial-surface')),
        dock: Boolean(view.host.querySelector('.utility-dock')),
      });
    });
    return children;
  }
  await view.render(
    React.createElement(
      Observe,
      null,
      React.createElement(SnapshotUtilityDock, {
        snapshotStore: store,
        hidden: false,
        open: true,
        tab: 'search',
        projectPath: 'C:/demo',
        entering: true,
        contentReady: true,
      })
    )
  );
  assert.deepEqual(frames[0], { placeholder: false, dock: true });
  assert.ok(
    frames.every((frame) => !frame.placeholder),
    'no frame shows the placeholder'
  );
});

test('the Search entry prepares its root listing on open intent, shared with the real open', async (t) => {
  resetExplorerRootCache();
  setCurrentExplorerProject('C:/demo');
  const reads = [];
  window.mixdogDesktop = {
    listProjectDir: (project, rel) => {
      const read = controlled();
      reads.push({ project, rel, read });
      return read.promise;
    },
  };
  const { useSideViewPrefetch } = await import('./app-shell-side-views.ts');
  let prefetch;
  function Harness() {
    prefetch = useSideViewPrefetch(() => {}, 'C:/demo');
    return null;
  }
  const view = mount(t);
  await view.render(React.createElement(Harness));
  prefetch('search');
  prefetch('search');
  assert.deepEqual(
    reads.map(({ project, rel }) => [project, rel]),
    [['C:/demo', '']],
    'one root read per intent burst'
  );
  await view.render(
    React.createElement(FilesRootPane, {
      projectPath: 'C:/demo',
      gitStatus: null,
      changed: new Set(),
      activeFileKey: '',
      active: true,
      readinessKey: 'files',
      onReadyChange() {},
    })
  );
  assert.equal(reads.length, 1, 'the open joins the read in flight');
  await act(async () => reads[0].read.resolve(ROOT_ENTRIES));
});

test('leaving Search drops its results and resets the mode: Contents rows never show under the Names tab', async (t) => {
  resetExplorerRootCache();
  const searches = [];
  window.mixdogDesktop = {
    listProjectDir: async () => ROOT_ENTRIES.map((entry) => ({ ...entry })),
    searchProjectFiles: (_project, query) => {
      const read = controlled();
      searches.push({ kind: 'names', query, read });
      return read.promise;
    },
    searchWorkspaceText: (_project, options) => {
      const read = controlled();
      searches.push({ kind: 'contents', query: options.query, read });
      return read.promise;
    },
  };
  const view = mount(t);
  const pane = (active) =>
    React.createElement(SearchPane, { projectPath: 'C:/demo', gitStatus: null, active, headerActionSlot: null });
  await view.render(pane(true));
  const tabs = () => [...view.host.querySelectorAll('[role="tab"]')];
  await act(async () => tabs()[1].click());
  await type(view.host.querySelector('.workbench-search-input input'), 'export');
  await act(async () => sleep(150));
  await act(async () =>
    searches[0].read.resolve({
      matchCount: 1,
      limitHit: false,
      files: [
        { relPath: 'a.ts', matches: [{ line: 1, column: 1, endColumn: 2, preview: 'export', matchText: 'export' }] },
      ],
    })
  );
  assert.equal(searches[0].kind, 'contents');
  assert.ok(view.host.querySelector('.workbench-search-file'), 'Contents rows show under the Contents tab');

  await view.render(pane(false));
  assert.equal(view.host.querySelector('.workbench-search-file'), null, 'closing drops the results');
  assert.equal(tabs()[0].getAttribute('aria-selected'), 'true', 'closing resets the mode to Names');
  assert.equal(view.host.querySelector('.workbench-search-input input').value, 'export', 'the query stays');

  await view.render(pane(true));
  assert.equal(view.host.querySelector('.workbench-search-file'), null, 'coming back never shows Contents rows');
  assert.equal(tabs()[0].getAttribute('aria-selected'), 'true');
  await act(async () => sleep(150));
  assert.equal(searches.at(-1).kind, 'names', 'the query is read again, in Names mode');
  assert.equal(view.host.querySelector('.workbench-search-file'), null);
});

test('while a new query is read the previous rows stay put but cannot be opened; they act again once results land', async (t) => {
  resetExplorerRootCache();
  const searches = [];
  const opened = [];
  window.mixdogDesktop = {
    listProjectDir: async () => ROOT_ENTRIES.map((entry) => ({ ...entry })),
    searchProjectFiles: (_project, query) => {
      const read = controlled();
      searches.push({ query, read });
      return read.promise;
    },
  };
  const view = mount(t);
  await view.render(
    React.createElement(SearchPane, {
      projectPath: 'C:/demo',
      gitStatus: null,
      active: true,
      headerActionSlot: null,
      onOpenFile: (project, rel) => opened.push(`${project}:${rel}`),
    })
  );
  const input = view.host.querySelector('.workbench-search-input input');
  const list = () => view.host.querySelector('.workbench-search-results');
  const row = () => view.host.querySelector('.workbench-search-name-row');
  await type(input, 'set');
  await act(async () => sleep(150));
  await act(async () => searches[0].read.resolve(['src/a.ts']));
  assert.equal(list().hasAttribute('inert'), false);
  assert.equal(list().getAttribute('aria-busy'), null);

  row().focus();
  assert.equal(document.activeElement, row());
  await type(input, 'setx');
  assert.equal(list().hasAttribute('inert'), true, 'the stale list is inert');
  assert.equal(list().getAttribute('aria-busy'), 'true');
  assert.equal(list().getAttribute('data-pending'), 'true', 'and visibly pending');
  assert.equal(document.activeElement, input, 'focus left the stale list for the field');
  await act(async () => row().click());
  await act(async () => row().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.deepEqual(opened, [], 'a stale row opens nothing');
  assert.equal(view.host.querySelectorAll('.workbench-search-name-row').length, 1, 'the rows stay in place');

  await act(async () => sleep(150));
  await act(async () => searches[1].read.resolve(['src/b.ts']));
  assert.equal(list().hasAttribute('inert'), false);
  await act(async () => row().click());
  assert.deepEqual(opened, ['C:/demo:src/b.ts'], 'the fresh row opens');
});

test('a cached root listing lives only with the current project, a mounted tree or a registered project', async () => {
  resetExplorerRootCache();
  const api = { listProjectDir: async () => ROOT_ENTRIES.map((entry) => ({ ...entry })) };
  setCurrentExplorerProject('C:/a');
  await loadExplorerRoot(api, 'C:/a');
  await loadExplorerRoot(api, 'C:/b');
  assert.ok(peekExplorerRoot('C:/a'), 'the current project keeps its listing');
  assert.equal(peekExplorerRoot('C:/b'), undefined, 'a project nothing holds does not keep one');

  const release = retainExplorerRoot('C:/b');
  await loadExplorerRoot(api, 'C:/b');
  assert.ok(peekExplorerRoot('C:/b'), 'a mounted tree holds its project');
  release();
  release();
  assert.equal(peekExplorerRoot('C:/b'), undefined, 'the last reader leaving drops it');
  assert.ok(peekExplorerRoot('C:/a'));

  setCurrentExplorerProject('C:/c');
  assert.equal(peekExplorerRoot('C:/a'), undefined, 'moving to another project drops the unheld one');

  setCurrentExplorerProject('C:/a');
  await loadExplorerRoot(api, 'C:/a');
  pruneExplorerRoots(['c:\\A\\', 'C:/other']);
  assert.ok(peekExplorerRoot('C:/a'), 'a registered project (same identity) stays');
  pruneExplorerRoots(['C:/other']);
  assert.equal(peekExplorerRoot('C:/a'), undefined, 'an unregistered project is dropped, current or not');
});

test('a failed root read is kept for the tree that opens next: its first frame shows the error, a later success replaces it', async (t) => {
  resetExplorerRootCache();
  setCurrentExplorerProject('C:/demo');
  const reads = [];
  window.mixdogDesktop = {
    listProjectDir: () => {
      const read = controlled();
      reads.push(read);
      return read.promise;
    },
  };
  const warm = prefetchExplorerRoot(window.mixdogDesktop, 'C:/demo');
  reads[0].reject(new Error('EACCES: boom'));
  await warm.catch(() => {});
  assert.equal(explorerRootSettled('C:/demo'), true, 'a failure settles the open gate');

  const view = mount(t);
  let firstFrame = null;
  function FirstPaint({ children }) {
    useLayoutEffect(() => {
      firstFrame ??= { text: view.host.textContent, rows: view.host.querySelectorAll('[role="treeitem"]').length };
    });
    return children;
  }
  await view.render(
    React.createElement(
      FirstPaint,
      null,
      React.createElement(FilesRootPane, {
        projectPath: 'C:/demo',
        gitStatus: null,
        changed: new Set(),
        activeFileKey: '',
        active: true,
        readinessKey: 'files',
        onReadyChange() {},
      })
    )
  );
  assert.match(firstFrame.text, /EACCES: boom/, 'the open shows the tree error in its first frame');
  assert.equal(reads.length, 2, 'the tree still revalidates');
  await act(async () => reads[1].resolve(ROOT_ENTRIES.map((entry) => ({ ...entry }))));
  assert.doesNotMatch(view.host.textContent, /EACCES: boom/, 'the successful read replaces the error');
  assert.equal(view.host.querySelectorAll('[role="treeitem"]').length, 2);
  assert.equal(peekExplorerRootFailure('C:/demo'), undefined);
});

test('Names results are dropped on leaving Search and read again, in Names, on return; nothing is pending while closed', async (t) => {
  resetExplorerRootCache();
  const searches = [];
  window.mixdogDesktop = {
    listProjectDir: async () => ROOT_ENTRIES.map((entry) => ({ ...entry })),
    searchProjectFiles: (_project, query) => {
      const read = controlled();
      searches.push({ query, read });
      return read.promise;
    },
  };
  const view = mount(t);
  const pane = (active) =>
    React.createElement(SearchPane, { projectPath: 'C:/demo', gitStatus: null, active, headerActionSlot: null });
  const busy = () => view.host.querySelector('.workbench-explorer').hasAttribute('aria-busy');
  await view.render(pane(true));
  await type(view.host.querySelector('.workbench-search-input input'), 'set');
  await act(async () => sleep(150));
  await act(async () => searches[0].read.resolve(['src/a.ts']));
  assert.ok(view.host.querySelector('.workbench-search-name-row'));
  assert.equal(busy(), false);

  await view.render(pane(false));
  assert.equal(view.host.querySelector('.workbench-search-name-row'), null, 'results are dropped on leaving');
  assert.equal(busy(), false, 'a closed Search is not pending');

  await view.render(pane(true));
  assert.equal(view.host.querySelector('.workbench-search-name-row'), null, 'no stale rows on return');
  assert.equal(busy(), true, 'the requery is pending');
  await act(async () => sleep(150));
  assert.equal(searches.length, 2, 'the query is read again');
  await act(async () => searches[1].read.resolve(['src/b.ts']));
  assert.equal(view.host.querySelectorAll('.workbench-search-name-row').length, 1);
});

test('switching Contents to Names while Search stays open never shows Contents rows under Names', async (t) => {
  resetExplorerRootCache();
  const searches = [];
  window.mixdogDesktop = {
    listProjectDir: async () => ROOT_ENTRIES.map((entry) => ({ ...entry })),
    searchProjectFiles: (_project, query) => {
      const read = controlled();
      searches.push({ kind: 'names', query, read });
      return read.promise;
    },
    searchWorkspaceText: (_project, options) => {
      const read = controlled();
      searches.push({ kind: 'contents', query: options.query, read });
      return read.promise;
    },
  };
  const view = mount(t);
  await view.render(
    React.createElement(SearchPane, { projectPath: 'C:/demo', gitStatus: null, active: true, headerActionSlot: null })
  );
  const tabs = () => [...view.host.querySelectorAll('[role="tab"]')];
  await act(async () => tabs()[1].click());
  await type(view.host.querySelector('.workbench-search-input input'), 'export');
  await act(async () => sleep(150));
  await act(async () =>
    searches[0].read.resolve({
      matchCount: 1,
      limitHit: false,
      files: [
        { relPath: 'a.ts', matches: [{ line: 1, column: 1, endColumn: 2, preview: 'export', matchText: 'export' }] },
      ],
    })
  );
  assert.ok(view.host.querySelector('.workbench-search-file'), 'Contents rows under Contents');

  await act(async () => tabs()[0].click());
  assert.equal(tabs()[0].getAttribute('aria-selected'), 'true');
  assert.equal(view.host.querySelector('.workbench-search-file'), null, 'no Contents rows under Names');
  await act(async () => sleep(150));
  assert.equal(searches.at(-1).kind, 'names');
  await act(async () => searches.at(-1).read.resolve(['src/export.ts']));
  assert.equal(view.host.querySelector('.workbench-search-file'), null);
  assert.equal(view.host.querySelectorAll('.workbench-search-name-row').length, 1);
});

test('a read finishing after its project was evicted leaves no listing or failure behind', async () => {
  resetExplorerRootCache();
  setCurrentExplorerProject('C:/a');
  const reads = [];
  const api = {
    listProjectDir: (project) => {
      const read = controlled();
      reads.push({ project, read });
      return read.promise;
    },
  };
  // A refresh in flight, then the app moves to another project: A is evicted.
  const refreshA = refreshExplorerRoot(api, 'C:/a');
  setCurrentExplorerProject('C:/b');
  reads[0].read.reject(new Error('EACCES: late'));
  await refreshA.catch(() => {});
  assert.equal(peekExplorerRootFailure('C:/a'), undefined, 'no ownerless failure');
  assert.equal(explorerRootSettled('C:/a'), false);

  // The same for a success, and for a load.
  const loadA = loadExplorerRoot(api, 'C:/a');
  setCurrentExplorerProject('C:/c');
  reads[1].read.resolve(ROOT_ENTRIES.map((entry) => ({ ...entry })));
  await loadA;
  assert.equal(peekExplorerRoot('C:/a'), undefined);
  assert.equal(explorerRootSettled('C:/a'), false);

  // A completion of an evicted entry never replaces a newer entry's outcome.
  setCurrentExplorerProject('C:/a');
  const stale = refreshExplorerRoot(api, 'C:/a');
  setCurrentExplorerProject('C:/c');
  const fresh = loadExplorerRoot(api, 'C:/a');
  await act(async () => {});
  retainExplorerRoot('C:/a');
  reads[3].read.reject(new Error('EACCES: fresh'));
  await fresh.catch(() => {});
  reads[2].read.resolve(ROOT_ENTRIES.map((entry) => ({ ...entry })));
  await stale;
  assert.match(peekExplorerRootFailure('C:/a')?.reason?.message ?? '', /fresh/, 'the stale success does not clear it');

  // A refresh finishing for a project nothing holds is swept with its read.
  const refreshB = refreshExplorerRoot(api, 'C:/d');
  reads[4].read.reject(new Error('EACCES: unheld'));
  await refreshB.catch(() => {});
  assert.equal(explorerRootSettled('C:/d'), false, 'an unheld, non-current project keeps nothing');
});
