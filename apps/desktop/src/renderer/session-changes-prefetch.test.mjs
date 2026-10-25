import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { SessionDiffPane } from './SessionDiffPane.tsx';
import {
  intentSelectedRow,
  prefetchSessionChanges,
  publishPaneSelection,
  setSessionChangesSource,
  useSessionChanges,
} from './session-changes-store.ts';

const h = React.createElement;
const patchOf = (path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
// Landed file patches are announced in one batch per 100ms.
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 150)));

function Chip({ cwd, sessionId }) {
  useSessionChanges({ cwd, sessionId, active: true });
  return null;
}

async function setup(t, sessionId, cwd) {
  const view = installTestDom(t, {
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent'],
    rootId: 'root',
  });
  const files = Array.from({ length: 40 }, (_, index) => ({
    path: `src/f${index}.ts`,
    status: 'M',
    additions: 1,
    deletions: 1,
    untracked: false,
  }));
  const batches = [];
  view.window.mixdogDesktop = {
    gitReview: async () => ({ repository: true, root: cwd, base: 'HEAD', files }),
    gitReviewDiffs: async (_cwd, requested) => {
      batches.push(requested.map((file) => file.path));
      return { patches: requested.map(({ path }) => ({ path, patch: patchOf(path) })), omitted: [] };
    },
    invokeCapability: async () => ({ value: null }),
  };
  setSessionChangesSource('uncommitted');
  // The composer's chip holds the list read.
  await act(async () => view.root.render(h(Chip, { cwd, sessionId })));
  await settle();
  return { ...view, batches };
}

test('intent starts the open’s own single batch, which the open joins and draws complete at once', async (t) => {
  const view = await setup(t, 'prefetch-a', 'C:/prefetch-a');
  assert.deepEqual(view.batches, []);
  // Menu open, then pressing and focusing "View changes": one load.
  prefetchSessionChanges('prefetch-a');
  prefetchSessionChanges('prefetch-a');
  prefetchSessionChanges('prefetch-a');
  await settle();
  assert.equal(view.batches.length, 1);
  assert.equal(view.batches[0].length, 40, 'every file, the batch the open itself asks for');

  await act(async () =>
    view.root.render(
      h(
        React.Fragment,
        null,
        h(Chip, { cwd: 'C:/prefetch-a', sessionId: 'prefetch-a' }),
        h(SessionDiffPane, {
          sessionId: 'prefetch-a',
          cwd: 'C:/prefetch-a',
          active: true,
          onClose() {},
        })
      )
    )
  );
  // The open's first frame: the whole list with every diff, no placeholder.
  assert.equal(view.document.querySelector('.initial-surface'), null);
  const stack = () => view.document.querySelector('.session-diff-stack');
  const sections = [...view.document.querySelectorAll('.session-diff-section')];
  assert.equal(sections.length, 40);
  for (const section of sections) {
    assert.ok(section.querySelector('.inline-diff'));
    assert.equal(section.textContent.includes('Loading diff…'), false);
  }
  const drawn = stack().innerHTML;
  await settle();
  // Nothing grows later and nothing is read again.
  assert.equal(stack().innerHTML, drawn);
  assert.equal(view.batches.length, 1);
});

test('without intent the open reads the set as one batch and lifts the placeholder with it', async (t) => {
  const view = await setup(t, 'prefetch-b', 'C:/prefetch-b');
  await act(async () =>
    view.root.render(
      h(
        React.Fragment,
        null,
        h(Chip, { cwd: 'C:/prefetch-b', sessionId: 'prefetch-b' }),
        h(SessionDiffPane, {
          sessionId: 'prefetch-b',
          cwd: 'C:/prefetch-b',
          active: true,
          onClose() {},
        })
      )
    )
  );
  await settle();
  assert.equal(view.document.querySelector('.initial-surface'), null);
  assert.equal(view.batches.length, 1);
  assert.equal(view.batches[0].length, 40);
});

test('intent retries a failed list read as the open does, once however often it is signalled', async (t) => {
  const view = installTestDom(t, {
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent'],
    rootId: 'root',
  });
  const cwd = 'C:/prefetch-err';
  let reviews = 0;
  const batches = [];
  view.window.mixdogDesktop = {
    gitReview: async () => {
      reviews += 1;
      if (reviews === 1) throw new Error('git is busy');
      return {
        repository: true,
        root: cwd,
        base: 'HEAD',
        files: [{ path: 'a.ts', status: 'M', additions: 1, deletions: 1, untracked: false }],
      };
    },
    gitReviewDiffs: async (_cwd, requested) => {
      batches.push(requested.map((file) => file.path));
      return { patches: requested.map(({ path }) => ({ path, patch: patchOf(path) })), omitted: [] };
    },
    invokeCapability: async () => ({ value: null }),
  };
  setSessionChangesSource('uncommitted');
  await act(async () => view.root.render(h(Chip, { cwd, sessionId: 'prefetch-err' })));
  await settle();
  assert.equal(reviews, 1, 'the first list read failed and holds its error');
  prefetchSessionChanges('prefetch-err');
  prefetchSessionChanges('prefetch-err');
  await settle();
  assert.equal(reviews, 2, 'intent reads the list again, once');
  assert.deepEqual(batches, [['a.ts']], 'and then the patches the open would ask for');
});

/** A 130-file set (capped: one file drawn) behind one workspace, with the
 *  source preference readable by intents without telling the readers. */
function cappedSetup(t, cwd) {
  const view = installTestDom(t, {
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent'],
    rootId: 'root',
  });
  const files = Array.from({ length: 130 }, (_, index) => ({
    path: `src/f${index}.ts`,
    status: 'M',
    additions: 1,
    deletions: 1,
    untracked: false,
  }));
  const batches = [];
  view.window.mixdogDesktop = {
    gitReview: async () => ({ repository: true, root: cwd, base: 'HEAD', files }),
    gitReviewDiffs: async (_cwd, requested) => {
      batches.push(requested.map((file) => file.path));
      return { patches: requested.map(({ path }) => ({ path, patch: patchOf(path) })), omitted: [] };
    },
    invokeCapability: async () => ({ value: null }),
  };
  setSessionChangesSource('uncommitted');
  const pane = (paneKey, sessionId, key = paneKey) =>
    h(SessionDiffPane, { key, paneKey, sessionId, cwd, active: true, onClose() {} });
  const show = async (...nodes) => {
    await act(async () => view.root.render(h(React.Fragment, null, ...nodes)));
    await settle();
  };
  // The nth pane in the document, whether it draws a file (unfolded), and a pick by header.
  const paneNode = (index) => view.document.querySelectorAll('.session-diff-pane')[index];
  const drawnIn = (index, path) =>
    paneNode(index)?.querySelector(`[data-session-diff-path="${path}"]`)?.dataset.collapsed === undefined;
  const pickIn = async (index, path) => {
    await act(async () =>
      paneNode(index).querySelector(`[data-session-diff-path="${path}"] .session-diff-section-title`).click()
    );
    await settle();
  };
  return { view, batches, pane, show, drawnIn, pickIn };
}
test('two panes on one session keep their own picks; one pane leaving the session or remounting never touches another', async (t) => {
  const probe = cappedSetup(t, 'C:/parity');
  const { pane, show, drawnIn, pickIn } = probe;
  const a = 'parity-a';
  const b = 'parity-b';
  const chips = [
    h(Chip, { key: 'chip-a', cwd: 'C:/parity', sessionId: a }),
    h(Chip, { key: 'chip-b', cwd: 'C:/parity', sessionId: b }),
  ];
  const left = 0;
  const right = 1;
  await show(...chips, pane('left', a), pane('right', a));
  assert.ok(drawnIn(left, 'src/f0.ts') && drawnIn(right, 'src/f0.ts'));
  // HEAD parity: left on f77, right on f0.
  await pickIn(left, 'src/f77.ts');
  assert.ok(drawnIn(left, 'src/f77.ts') && !drawnIn(left, 'src/f0.ts'));
  assert.ok(drawnIn(right, 'src/f0.ts') && !drawnIn(right, 'src/f77.ts'), 'the other pane keeps the first file');
  await pickIn(right, 'src/f50.ts');
  assert.ok(drawnIn(left, 'src/f77.ts') && drawnIn(right, 'src/f50.ts'));
  // Left moves to another session: it starts on its first file; right is untouched.
  await show(...chips, pane('left', b), pane('right', a));
  assert.ok(drawnIn(left, 'src/f0.ts') && !drawnIn(left, 'src/f77.ts'));
  assert.ok(drawnIn(right, 'src/f50.ts'), 'the other pane keeps its pick');
  // Back to the first session: reset, as before.
  await show(...chips, pane('left', a), pane('right', a));
  assert.ok(drawnIn(left, 'src/f0.ts'));
  assert.ok(drawnIn(right, 'src/f50.ts'));
  // A pane that remounts (readers survive) starts on the first file.
  await pickIn(left, 'src/f77.ts');
  await show(...chips, pane('left', a, 'left-again'), pane('right', a));
  assert.ok(drawnIn(left, 'src/f0.ts') && !drawnIn(left, 'src/f77.ts'));
  assert.ok(drawnIn(right, 'src/f50.ts'));
});

test('intent asks for the file of the pane it opens: its published pick, else the first row, and a focus file wins', async (t) => {
  const { pane, show, pickIn } = cappedSetup(t, 'C:/intent-pane');
  const sessionId = 'intent-pane';
  const rows = Array.from({ length: 130 }, (_, index) => ({ path: `src/f${index}.ts` }));
  const chip = h(Chip, { cwd: 'C:/intent-pane', sessionId });
  await show(chip, pane('left', sessionId), pane('right', sessionId));
  await pickIn(0, 'src/f77.ts');
  const pathFor = (paneKey, focusPath = '') => intentSelectedRow(rows, sessionId, paneKey, focusPath)?.path;
  // The mounted pane with a pick: that file; the pane beside it: its own (first) file.
  assert.equal(pathFor('left'), 'src/f77.ts');
  assert.equal(pathFor('right'), 'src/f0.ts');
  // A pane that is not mounted opens on the first row, as a fresh pane does.
  assert.equal(pathFor('not-mounted'), 'src/f0.ts');
  // A focus file (a chip menu row) wins over the pick.
  assert.equal(pathFor('left', 'src/f5.ts'), 'src/f5.ts');
  // A pane showing another session publishes nothing for this one.
  assert.equal(intentSelectedRow(rows, 'another-session', 'left', '')?.path, 'src/f0.ts');
  // The pick follows the pane: gone with it.
  await show(chip, pane('right', sessionId));
  assert.equal(pathFor('left'), 'src/f0.ts');
});

test('intent requests the published pick of the pane it opens, the first row for one not mounted, and the focus file over both', async (t) => {
  const { view, batches, show } = cappedSetup(t, 'C:/intent-batch');
  const sessionId = 'intent-batch';
  await show(h(Chip, { cwd: 'C:/intent-batch', sessionId }));
  const KEY = 'mixdog.session-changes-source.v1';
  // Only intent reads a source the readers are not on.
  const asks = async (source, options) => {
    view.window.localStorage.setItem(KEY, source);
    batches.length = 0;
    prefetchSessionChanges(sessionId, options);
    await settle();
    return batches.flat();
  };
  const unpublish = publishPaneSelection('dock-1', sessionId, 'src/f77.ts');
  assert.deepEqual(await asks('branch', { paneKey: 'dock-1' }), ['src/f77.ts']);
  assert.deepEqual(await asks('branch', { paneKey: 'dock-1', focusPath: 'src/f5.ts' }), ['src/f5.ts']);
  // The pane unmounts: an intent for it finds a fresh pane, on the first row.
  unpublish();
  assert.deepEqual(await asks('branch', { paneKey: 'dock-1' }), ['src/f0.ts']);
});
test("the chip menu opens its own pane's dock: it names the pane from context", async (t) => {
  const { TurnReviewFilesMenu } = await import('./turn-review-files-menu.tsx');
  const { PaneKeyContext } = await import('./pane-key-context.ts');
  const { view, batches, show } = cappedSetup(t, 'C:/menu-pane');
  const sessionId = 'menu-pane';
  const files = new Map([['src/f0.ts', { additions: 1, deletions: 1, lineStats: true }]]);
  const menu = (paneKey) =>
    h(
      PaneKeyContext.Provider,
      { value: paneKey },
      h(
        TurnReviewFilesMenu,
        {
          sessionId,
          historyTurns: 1,
          label: 'Uncommitted',
          title: 'Files 1',
          files,
          onViewChanges() {},
          onOpenFile() {},
        },
        'Files'
      )
    );
  await show(h(Chip, { cwd: 'C:/menu-pane', sessionId }), menu('dock-9'));
  const unpublish = publishPaneSelection('dock-9', sessionId, 'src/f77.ts');
  // Only intent reads a source the readers are not on.
  view.window.localStorage.setItem('mixdog.session-changes-source.v1', 'branch');
  await act(async () => view.document.querySelector('.turn-review-segment').click());
  await settle();
  assert.deepEqual(batches.flat(), ['src/f77.ts']);
  unpublish();
});
test('intent follows the readers: an unmounted or moved reader leaves no workspace to read', async (t) => {
  const view = installTestDom(t, {
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent'],
    rootId: 'root',
  });
  const reviewed = [];
  const patchBatches = [];
  view.window.mixdogDesktop = {
    gitReview: async (cwd) => {
      reviewed.push(cwd);
      return {
        repository: true,
        root: cwd,
        base: 'HEAD',
        files: [{ path: 'a.ts', status: 'M', additions: 1, deletions: 1, untracked: false }],
      };
    },
    gitReviewDiffs: async (cwd, requested) => {
      patchBatches.push(cwd);
      return { patches: requested.map(({ path }) => ({ path, patch: patchOf(path) })), omitted: [] };
    },
    invokeCapability: async () => ({ value: null }),
  };
  setSessionChangesSource('uncommitted');
  await act(async () => view.root.render(h(Chip, { cwd: 'C:/readers-old', sessionId: 'readers' })));
  await settle();
  // The reader's workspace moved: only the new one is a target.
  await act(async () => view.root.render(h(Chip, { cwd: 'C:/readers-new', sessionId: 'readers' })));
  await settle();
  reviewed.length = 0;
  // The preference changes without telling the readers (another window), so
  // only intent reads the new source.
  const KEY = 'mixdog.session-changes-source.v1';
  view.window.localStorage.setItem(KEY, 'branch');
  prefetchSessionChanges('readers');
  await settle();
  assert.deepEqual(reviewed, ['C:/readers-new']);
  // The last reader leaves: intent has nothing to read or fetch.
  await act(async () => view.root.render(null));
  reviewed.length = 0;
  patchBatches.length = 0;
  view.window.localStorage.setItem(KEY, 'uncommitted');
  prefetchSessionChanges('readers');
  view.window.localStorage.setItem(KEY, 'unstaged');
  prefetchSessionChanges('readers');
  await settle();
  assert.deepEqual(reviewed, []);
  assert.deepEqual(patchBatches, []);
});

// ── Entry wiring: every Changes entry signals intent through prefetchSessionChanges ──

/** A desktop whose first `failing` patch batches fail (a failed patch is asked
 *  for again), so each later signal that reaches the store shows as one more call. */
function countingDesktop(view, cwd, failing) {
  const calls = { batches: 0 };
  view.window.mixdogDesktop = {
    gitReview: async () => ({
      repository: true,
      root: cwd,
      base: 'HEAD',
      files: [{ path: 'a.ts', status: 'M', additions: 1, deletions: 1, untracked: false }],
    }),
    gitReviewDiffs: async (_cwd, requested) => {
      calls.batches += 1;
      if (calls.batches <= failing) throw new Error('read failed');
      return { patches: requested.map(({ path }) => ({ path, patch: patchOf(path) })), omitted: [] };
    },
    invokeCapability: async () => ({ value: null }),
  };
  return calls;
}

const flushReads = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

/** The descriptors a dock element hands its children, rendered once. */
async function descriptorsOf(view, element) {
  const { createRoot } = await import('react-dom/client');
  const host = view.document.createElement('div');
  view.document.body.append(host);
  const root = createRoot(host);
  let captured;
  await act(async () =>
    root.render(
      React.cloneElement(element, {
        children: (descriptors) => {
          captured = descriptors;
          return null;
        },
      })
    )
  );
  await act(async () => root.unmount());
  return captured;
}
test("a session pane's Changes rail entry prefetches through the descriptor's onPrefetch", async (t) => {
  const { renderPaneSideDockView } = await import('./app-shell-side-dock.tsx');
  const view = installTestDom(t, {
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent'],
    rootId: 'root',
  });
  const calls = countingDesktop(view, 'C:/wired-toggle', 0);
  setSessionChangesSource('uncommitted');
  await act(async () => view.root.render(h(Chip, { cwd: 'C:/wired-toggle', sessionId: 'wired-toggle' })));
  await settle();
  const chunk = [];
  const base = new Map([
    ['session-diff', { id: 'session-diff', label: 'Changes', icon: () => null, onPrefetch: () => chunk.push('chunk') }],
  ]);
  const surfaces = {
    sessionSideSurfaces: new Map(),
    sessionDiffs: new Map(),
    sessionPanelViews: new Map(),
    sessionSurfaceSources: new Map(),
    panelViewFronts: new Set(),
    terminalSurfaces: { prewarm: () => {} },
  };
  const leaf = { id: 'leaf', activeKey: 'session:wired-toggle', tabs: [{ kind: 'session', id: 'wired-toggle' }] };
  const rail = await descriptorsOf(
    view,
    renderPaneSideDockView(leaf, false, {
      paneWorkspace: { focusLeaf() {} },
      paneSideDocks: { entryFor: () => ({ open: false, view: null, surface: '', diff: null }) },
      sessionSurfaces: surfaces,
      workbenchSideLayout: { layout: { left: [], right: [['session-diff']] } },
      sideViewDescriptors: base,
      paneProjectPathFor: () => '',
    })
  );
  assert.equal(calls.batches, 0);
  rail.get('session-diff').onPrefetch();
  rail.get('session-diff').onPrefetch();
  await flushReads();
  assert.equal(calls.batches, 1, 'the signal starts one load; the next joins it');
  assert.deepEqual(chunk, ['chunk', 'chunk'], 'the chunk prefetch still runs');
});

test('each pane’s rail and strip entry requests the pick of its own pane, for a capped set', async (t) => {
  const { renderPaneSideDockView, renderPaneDockStripTrailing } = await import('./app-shell-side-dock.tsx');
  const { view, batches, show } = cappedSetup(t, 'C:/rails');
  const sessionId = 'rails';
  await show(h(Chip, { cwd: 'C:/rails', sessionId }));
  const surfaces = {
    sessionSideSurfaces: new Map(),
    sessionDiffs: new Map(),
    sessionPanelViews: new Map(),
    sessionSurfaceSources: new Map(),
    panelViewFronts: new Set(),
    terminalSurfaces: { prewarm: () => {} },
  };
  const base = new Map([
    ['session-diff', { id: 'session-diff', label: 'Changes', icon: () => null }],
    ['terminal', { id: 'terminal', label: 'Terminal', icon: () => null }],
  ]);
  const leaf = (id) => ({ id, activeKey: `session:${sessionId}`, tabs: [{ kind: 'session', id: sessionId }] });
  const paneDocks = { entryFor: () => ({ open: false, view: null, surface: '', diff: null }) };
  const layout = { layout: { left: [], right: [['terminal'], ['session-diff']] } };
  const rail = (id) =>
    descriptorsOf(
      view,
      renderPaneSideDockView(leaf(id), false, {
        paneWorkspace: { focusLeaf() {} },
        paneSideDocks: paneDocks,
        sessionSurfaces: surfaces,
        workbenchSideLayout: layout,
        sideViewDescriptors: base,
        paneProjectPathFor: () => '',
      })
    );
  const strip = (id) =>
    descriptorsOf(
      view,
      renderPaneDockStripTrailing(leaf(id), {
        workbenchSideLayout: layout,
        paneSideDocks: paneDocks,
        sessionSurfaces: surfaces,
        sideViewDescriptors: base,
        selectWorkbenchSideView() {},
        closePaneRightRegion() {},
        focusLeaf() {},
      })
    );
  const picks = { 'dock-a': 'src/f77.ts', 'dock-b': 'src/f50.ts', 'strip-a': 'src/f90.ts', 'strip-b': 'src/f101.ts' };
  const unpublish = Object.entries(picks).map(([id, path]) => publishPaneSelection(id, sessionId, path));
  // Only intent reads a source the readers are not on.
  view.window.localStorage.setItem('mixdog.session-changes-source.v1', 'branch');
  const asks = async (descriptors) => {
    batches.length = 0;
    descriptors.get('session-diff').onPrefetch();
    await settle();
    return batches.flat();
  };
  assert.deepEqual(await asks(await rail('dock-a')), ['src/f77.ts']);
  assert.deepEqual(await asks(await rail('dock-b')), ['src/f50.ts']);
  assert.deepEqual(await asks(await strip('strip-a')), ['src/f90.ts']);
  assert.deepEqual(await asks(await strip('strip-b')), ['src/f101.ts']);
  for (const off of unpublish) off();
});
test('the Changes chip menu prefetches on open and again on pressing or focusing View changes', async (t) => {
  const { TurnReviewFilesMenu } = await import('./turn-review-files-menu.tsx');
  const view = installTestDom(t, {
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'],
    rootId: 'root',
  });
  // Opening and pressing fail; focusing succeeds: three signals, three reads.
  const calls = countingDesktop(view, 'C:/wired-menu', 2);
  setSessionChangesSource('uncommitted');
  const files = new Map([['a.ts', { additions: 1, deletions: 1, lineStats: true }]]);
  await act(async () =>
    view.root.render(
      h(
        React.Fragment,
        null,
        h(Chip, { cwd: 'C:/wired-menu', sessionId: 'wired-menu' }),
        h(
          TurnReviewFilesMenu,
          {
            sessionId: 'wired-menu',
            historyTurns: 1,
            label: 'Uncommitted',
            title: 'Files 1',
            files,
            onViewChanges() {},
            onOpenFile() {},
          },
          'Files'
        )
      )
    )
  );
  await settle();
  assert.equal(calls.batches, 0, 'nothing is read before the user signals intent');
  await act(async () => view.document.querySelector('.turn-review-segment').click());
  await flushReads();
  assert.equal(calls.batches, 1, 'opening the menu starts the load');
  const viewChanges = [...view.document.querySelectorAll('.turn-review-files-foot [role="menuitem"]')].at(-1);
  await act(async () => viewChanges.dispatchEvent(new view.window.Event('pointerdown', { bubbles: true })));
  await flushReads();
  assert.equal(calls.batches, 2, 'pressing View changes asks again');
  await act(async () => viewChanges.focus());
  await flushReads();
  assert.equal(calls.batches, 3, 'focusing View changes asks again');
});
