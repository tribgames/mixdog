import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import {
  readSessionChangesSource,
  setSessionChangesSource,
  useSessionChangePatches,
  useSessionChanges,
  useSessionChangesSource,
} from './session-changes-store.ts';
import { defaultSessionLaneStore } from './session-lane-store.ts';

const h = React.createElement;
const SOURCE_KEY = 'mixdog.session-changes-source.v1';

function mount(t, desktop) {
  const view = installTestDom(t, { expose: ['navigator', 'HTMLElement', 'Node', 'Event'], rootId: 'root' });
  view.window.mixdogDesktop = desktop;
  const settle = (ms = 0) =>
    act(async () => {
      if (ms) t.mock.timers.tick(ms);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
  return { ...view, settle };
}

/** Renders one hook per probe and records its latest state by name. */
function probes(states) {
  return function Probe({ name, ...props }) {
    states[name] = useSessionChanges(props);
    return null;
  };
}

const reviewFile = (path, additions = 1, deletions = 0, untracked = false) => ({
  path,
  status: untracked ? '??' : 'M',
  additions,
  deletions,
  untracked,
});

test('the source preference persists in localStorage, defaults to uncommitted and ignores junk', async (t) => {
  const view = mount(t, {});
  const seen = [];
  function SourceProbe() {
    seen.push(useSessionChangesSource());
    return null;
  }
  assert.equal(readSessionChangesSource(), 'uncommitted');
  view.window.localStorage.setItem(SOURCE_KEY, 'sideways');
  assert.equal(readSessionChangesSource(), 'uncommitted');
  await act(async () => view.root.render(h(SourceProbe)));
  await act(async () => setSessionChangesSource('staged'));
  assert.equal(view.window.localStorage.getItem(SOURCE_KEY), 'staged');
  assert.equal(seen.at(-1), 'staged', 'every reader follows the global choice');
  // A later window (or reload) reads the stored choice.
  assert.equal(readSessionChangesSource(), 'staged');
});

test('switching the source reads that source: review, index, worktree and the last turn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const calls = [];
  const status = {
    repository: true,
    root: 'C:/switch',
    files: [
      {
        path: 'staged.ts',
        index: 'M',
        worktree: ' ',
        untracked: false,
        stagedAdditions: 2,
        stagedDeletions: 1,
        unstagedAdditions: 0,
        unstagedDeletions: 0,
      },
      {
        path: 'both.ts',
        index: 'A',
        worktree: 'M',
        untracked: false,
        stagedAdditions: 5,
        stagedDeletions: 0,
        unstagedAdditions: 1,
        unstagedDeletions: 1,
      },
      {
        path: 'new.ts',
        index: '?',
        worktree: '?',
        untracked: true,
        stagedAdditions: 0,
        stagedDeletions: 0,
        unstagedAdditions: 3,
        unstagedDeletions: 0,
      },
    ],
  };
  const view = mount(t, {
    gitReview: async (cwd, source) => {
      calls.push(['review', source]);
      return {
        repository: true,
        root: 'C:/switch',
        base: source === 'branch' ? 'origin/main' : 'HEAD',
        files: [reviewFile(`${source}.ts`)],
      };
    },
    gitStatus: async (cwd, options) => {
      calls.push(['status', options?.skipLineStats ? 'skip' : 'lines']);
      return status;
    },
    invokeCapability: async (request) => {
      calls.push(['capability', request.capability, request.sessionId]);
      return {
        value: {
          supported: true,
          authoritative: true,
          files: [{ path: 'turn.ts', status: 'M', additions: 4, deletions: 2 }],
          patch: '',
          historyTurns: 3,
        },
      };
    },
  });
  const states = {};
  const Probe = probes(states);
  await act(async () => view.root.render(h(Probe, { name: 'a', cwd: 'C:/switch', sessionId: 's1', active: true })));
  await view.settle();
  assert.deepEqual(calls, [['review', 'uncommitted']]);
  assert.equal(states.a.repository, true);
  assert.equal(states.a.base, 'HEAD');
  assert.deepEqual(
    states.a.rows.map((row) => row.path),
    ['uncommitted.ts']
  );

  calls.length = 0;
  await act(async () => states.a.setSource('branch'));
  await view.settle();
  assert.deepEqual(calls, [['review', 'branch']]);
  assert.equal(states.a.base, 'origin/main');

  calls.length = 0;
  await act(async () => states.a.setSource('staged'));
  await view.settle();
  assert.deepEqual(calls, [['status', 'lines']]);
  assert.deepEqual(
    states.a.rows.map((row) => [row.path, row.status, row.additions, row.deletions]),
    [
      ['staged.ts', 'M', 2, 1],
      ['both.ts', 'A', 5, 0],
    ]
  );

  await act(async () => states.a.setSource('unstaged'));
  await view.settle();
  assert.deepEqual(
    states.a.rows.map((row) => [row.path, row.status, row.additions, row.deletions]),
    [
      ['both.ts', 'M', 1, 1],
      ['new.ts', 'A', 3, 0],
    ]
  );

  calls.length = 0;
  await act(async () => states.a.setSource('last-turn'));
  await view.settle();
  assert.deepEqual(calls, [
    ['status', 'skip'],
    ['capability', 'getTurnReviewDiff', 's1'],
  ]);
  assert.deepEqual(
    states.a.rows.map((row) => row.path),
    ['turn.ts']
  );
  assert.equal(states.a.summary.additions, 4);
});

test('the chip and the pane share one single-flight read per (root, source)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let reads = 0;
  const gate = Promise.withResolvers();
  const view = mount(t, {
    gitReview: async () => {
      reads += 1;
      await gate.promise;
      return { repository: true, root: 'C:/shared', base: 'HEAD', files: [reviewFile('a.ts', 2, 1)] };
    },
  });
  const states = {};
  const Probe = probes(states);
  await act(async () =>
    view.root.render([
      h(Probe, { key: 'chip', name: 'chip', cwd: 'C:/shared', sessionId: 's1', active: true }),
      h(Probe, { key: 'pane', name: 'pane', cwd: 'C:/shared', sessionId: 's2', active: true }),
    ])
  );
  await view.settle();
  assert.equal(states.chip.loading, true);
  // A foreground refresh while the read runs joins it.
  let joined;
  await act(async () => {
    joined = states.pane.refresh(true);
  });
  assert.equal(reads, 1);
  gate.resolve();
  await view.settle();
  assert.equal(await joined, true);
  assert.equal(reads, 1);
  assert.equal(states.chip.rows, states.pane.rows, 'both read the same cached entry');
  assert.equal(states.chip.summary.additions, 2);
  assert.equal(states.chip.loading, false);
});

test('a cwd switch never renders the counts cached before the move, only the new read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let projectFiles = [reviewFile('old.ts', 7, 3)];
  let gate = null;
  const view = mount(t, {
    gitReview: async (cwd) => {
      if (cwd === 'C:/merge/wt') {
        return { repository: true, root: 'C:/merge/wt', base: 'HEAD', files: [reviewFile('wt.ts', 2)] };
      }
      await gate?.promise;
      return { repository: true, root: 'C:/merge/project', base: 'HEAD', files: projectFiles };
    },
  });
  const states = {};
  const Probe = probes(states);
  const render = (cwd) =>
    act(async () => view.root.render(h(Probe, { name: 'a', cwd, sessionId: 's-merge', active: true })));
  await render('C:/merge/project');
  await view.settle(200);
  assert.deepEqual(
    states.a.rows.map((row) => row.path),
    ['old.ts']
  );
  await render('C:/merge/wt');
  await view.settle(200);
  assert.deepEqual(
    states.a.rows.map((row) => row.path),
    ['wt.ts']
  );
  // The merge returns the session to the project folder, whose files changed
  // meanwhile: the folder's earlier counts must not flash before its new read.
  projectFiles = [];
  gate = Promise.withResolvers();
  await render('C:/merge/project');
  assert.deepEqual(states.a.rows, [], 'no stale rows while the new read runs');
  assert.equal(states.a.summary.files.size, 0);
  await view.settle(200);
  assert.deepEqual(states.a.rows, []);
  gate.resolve();
  await view.settle(200);
  assert.deepEqual(states.a.rows, []);
  assert.equal(states.a.loading, false);
  // The same cwd re-rendered later keeps what it read.
  projectFiles = [reviewFile('new.ts', 1)];
  await act(async () => states.a.refresh(true));
  await view.settle(200);
  assert.deepEqual(
    states.a.rows.map((row) => row.path),
    ['new.ts']
  );
});

test('only Git evidence refreshes: no reads on render, git-changed re-reads at the dock cadence, hidden pauses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let files = [reviewFile('a.ts')];
  let reads = 0;
  const view = mount(t, {
    gitReview: async () => {
      reads += 1;
      return { repository: true, root: 'C:/evidence', base: 'HEAD', files };
    },
  });
  let visibility = 'visible';
  Object.defineProperty(view.document, 'visibilityState', { configurable: true, get: () => visibility });
  const states = {};
  const Probe = probes(states);
  const render = (props = {}) =>
    act(async () =>
      view.root.render(h(Probe, { name: 'a', cwd: 'C:/evidence', sessionId: 's', active: true, ...props }))
    );
  await render();
  await view.settle();
  assert.equal(reads, 1);
  // Re-renders and time alone do not read (the safety lane is 30s).
  await render();
  await view.settle(20_000);
  assert.equal(reads, 1);
  files = [reviewFile('a.ts'), reviewFile('b.ts', 0, 4)];
  await act(async () => view.window.dispatchEvent(new view.window.Event('mixdog:git-changed')));
  await view.settle(124);
  assert.equal(reads, 1, 'bursts debounce');
  await view.settle(10);
  assert.equal(reads, 2);
  assert.deepEqual(
    states.a.rows.map((row) => row.path),
    ['a.ts', 'b.ts']
  );
  // Hidden: no evidence-driven or safety read.
  await act(async () => {
    visibility = 'hidden';
    view.document.dispatchEvent(new view.window.Event('visibilitychange'));
  });
  await act(async () => view.window.dispatchEvent(new view.window.Event('mixdog:git-changed')));
  await view.settle(60_000);
  assert.equal(reads, 2);
  assert.equal(await states.a.refresh(true), false, 'a hidden refresh is not adopted');
  // Visible again: it catches up at once.
  await act(async () => {
    visibility = 'visible';
    view.document.dispatchEvent(new view.window.Event('visibilitychange'));
  });
  await view.settle();
  assert.equal(reads, 3);
  // Inactive: the watch is released.
  await render({ active: false });
  await act(async () => view.window.dispatchEvent(new view.window.Event('mixdog:git-changed')));
  await view.settle(60_000);
  assert.equal(reads, 3);
});

test('staged and unstaged count lines afresh on evidence and refresh; only the safety tick reuses them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  // The main process's reused stats are keyed by status only: a growing file
  // keeps its old count there.
  let lines = 1;
  let reused = 0;
  const options = [];
  const view = mount(t, {
    gitStatus: async (cwd, request) => {
      options.push(request?.reuseLineStats);
      const additions = request?.reuseLineStats ? (reused ||= lines) : (reused = lines);
      return {
        repository: true,
        root: 'C:/fresh',
        files: [
          {
            path: 'grow.ts',
            index: ' ',
            worktree: 'M',
            untracked: false,
            stagedAdditions: 0,
            stagedDeletions: 0,
            unstagedAdditions: additions,
            unstagedDeletions: 0,
          },
        ],
      };
    },
  });
  setSessionChangesSource('unstaged');
  const states = {};
  const Probe = probes(states);
  await act(async () => view.root.render(h(Probe, { name: 'a', cwd: 'C:/fresh', sessionId: 's', active: true })));
  await view.settle();
  assert.equal(states.a.summary.additions, 1);
  lines = 3;
  await act(async () => view.window.dispatchEvent(new view.window.Event('mixdog:git-changed')));
  await view.settle(3_000);
  assert.equal(states.a.summary.additions, 3, 'Git evidence counts the grown file');
  lines = 5;
  await act(async () => states.a.refresh(true));
  await view.settle();
  assert.equal(states.a.summary.additions, 5, 'an explicit refresh counts afresh');
  assert.ok(options.length >= 3);
  assert.ok(options.every((reuse) => reuse === false));
  options.length = 0;
  await view.settle(30_000);
  assert.deepEqual(options, [true], 'the safety tick reuses');
});

/** A Git tree of `count` files (+2 −1 each) served by the batch IPC, with the
 *  per-file read only for paths the batch omits. */
function mountTree(t, root, count, { omit = () => false, patchOf: patchFor } = {}) {
  const files = Array.from({ length: count }, (_, index) =>
    reviewFile(`src/f${String(index).padStart(3, '0')}.ts`, 2, 1)
  );
  /** Per-path added text (default 'new'): content that moves without the counts. */
  const text = new Map();
  const patchOf =
    patchFor ??
    ((path) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,2 @@\n-old\n+${text.get(path) ?? 'new'}\n+more\n`);
  const calls = { reviews: 0, batches: [], singles: [] };
  const view = mount(t, {
    gitReview: async () => {
      calls.reviews += 1;
      return { repository: true, root, base: 'HEAD', files };
    },
    gitReviewDiffs: async (cwd, requested, source) => {
      calls.batches.push(requested.map((file) => file.path));
      assert.equal(source, 'uncommitted');
      const patches = [];
      const omitted = [];
      for (const { path } of requested) {
        if (omit(path)) omitted.push(path);
        else patches.push({ path, patch: patchOf(path) });
      }
      return { patches, omitted };
    },
    gitReviewDiff: async (cwd, path) => {
      calls.singles.push(path);
      return patchOf(path);
    },
  });
  setSessionChangesSource('uncommitted');
  const state = { renders: 0, drawn: [], capped: false };
  function Pane({ selectedId = '' }) {
    const changes = useSessionChanges({ cwd: root, sessionId: root, active: true });
    const { withPatch, capped } = useSessionChangePatches({
      cwd: root,
      sessionId: root,
      rows: changes.rows,
      selectedId,
    });
    state.renders += 1;
    state.capped = capped;
    state.drawn = changes.rows.map(withPatch);
    return null;
  }
  const render = (props = {}) => act(async () => view.root.render(h(Pane, props)));
  // Every queued read resolves without advancing time; landed patches are announced after 100ms.
  const drain = async () => {
    await act(async () => {
      for (let index = 0; index < 5_000; index += 1) await Promise.resolve();
    });
    await view.settle(100);
  };
  const gitChanged = async () => {
    await act(async () => view.window.dispatchEvent(new view.window.Event('mixdog:git-changed')));
    await view.settle(3_000);
    await drain();
  };
  return { view, files, text, calls, state, render, drain, gitChanged };
}

test('a file whose content moved without moving its counts re-reads by its review revision, alone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const tree = mountTree(t, 'C:/revision', 10);
  tree.files.forEach((file, index) => {
    tree.files[index] = { ...file, revision: '10:1' };
  });
  const { calls, state } = tree;
  await tree.render();
  await tree.drain();
  assert.equal(calls.batches.length, 1);
  const shown = state.drawn;
  assert.match(shown[3].parts[0].patch, /\+new\n/);
  // Same status and counts, new content: only the revision moved.
  tree.text.set('src/f003.ts', 'edited');
  tree.files[3] = { ...tree.files[3], revision: '10:2' };
  await tree.gitChanged();
  assert.deepEqual(calls.batches.slice(1), [['src/f003.ts']], 'the moved revision re-reads that file alone');
  assert.match(state.drawn[3].parts[0].patch, /\+edited\n/, 'the stale patch is replaced');
  assert.ok(state.drawn.every((row, index) => index === 3 || row === shown[index]));
  // An unchanged revision reads nothing on the next evidence.
  await tree.gitChanged();
  assert.equal(calls.batches.length, 2);
});

test('batch patches for files named __proto__, constructor and toString land on those files', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const tree = mountTree(t, 'C:/proto', 5);
  const special = ['__proto__', 'constructor', 'toString'];
  special.forEach((path, index) => {
    tree.files[index] = { ...tree.files[index], path };
  });
  await tree.render();
  await tree.drain();
  for (const path of [...special, tree.files[3].path, tree.files[4].path]) {
    const row = tree.state.drawn.find((entry) => entry.path === path);
    assert.ok(row, path);
    assert.match(row.parts[0].patch, new RegExp(`diff --git a/${path} b/${path}`), path);
  }
  assert.equal(tree.calls.singles.length, 0, 'the batch served them; no per-file fallback');
});

test('staged and unstaged carry no revision: Git evidence re-reads the drawn files, an unchanged text draws nothing new', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const text = { 'a.ts': 'one', 'b.ts': 'two' };
  const reads = [];
  const stagedFile = (path) => ({
    path,
    index: 'M',
    worktree: ' ',
    untracked: false,
    stagedAdditions: 1,
    stagedDeletions: 1,
    unstagedAdditions: 0,
    unstagedDeletions: 0,
  });
  const view = mount(t, {
    gitStatus: async () => ({ repository: true, root: 'C:/index', files: [stagedFile('a.ts'), stagedFile('b.ts')] }),
    gitDiff: async (cwd, path, staged) => {
      reads.push([path, staged]);
      return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${text[path]}\n`;
    },
  });
  setSessionChangesSource('staged');
  let drawn = [];
  function Pane() {
    const changes = useSessionChanges({ cwd: 'C:/index', sessionId: 'index', active: true });
    const { withPatch } = useSessionChangePatches({
      cwd: 'C:/index',
      sessionId: 'index',
      rows: changes.rows,
      selectedId: '',
    });
    drawn = changes.rows.map(withPatch);
    return null;
  }
  const drain = async () => {
    await act(async () => {
      for (let index = 0; index < 500; index += 1) await Promise.resolve();
    });
    await view.settle(100);
  };
  await act(async () => view.root.render(h(Pane)));
  await drain();
  assert.deepEqual(reads, [
    ['a.ts', true],
    ['b.ts', true],
  ]);
  const shown = drawn;
  // `git add` of new content with the same counts: only evidence tells.
  text['a.ts'] = 'uno';
  await act(async () => view.window.dispatchEvent(new view.window.Event('mixdog:git-changed')));
  await view.settle(3_000);
  await drain();
  assert.equal(reads.length, 4, 'evidence re-reads each drawn file once');
  assert.match(drawn[0].parts[0].patch, /\+uno\n/);
  assert.equal(drawn[1], shown[1], 'a re-read with the same text keeps the drawn row');
  // The safety tick is not evidence: no patch read.
  await view.settle(30_000);
  await drain();
  assert.equal(reads.length, 4);
});

test('the 12 MiB set limit counts UTF-8 bytes, not UTF-16 units', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  // Five files of 1,000 added lines of 1,000 '한' (3 bytes each): ~5M units,
  // ~15 MB of UTF-8; each file stays under 3 MiB and each line under 1 MiB.
  const body = `+${'한'.repeat(1_000)}\n`.repeat(1_000);
  const tree = mountTree(t, 'C:/multibyte', 5, {
    patchOf: (path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,1000 @@\n${body}`,
  });
  tree.files.forEach((file, index) => {
    tree.files[index] = reviewFile(file.path, 1_000, 0);
  });
  const { calls, state } = tree;
  await tree.render({ selectedId: 'src/f000.ts' });
  await tree.drain();
  assert.equal(calls.batches.length, 1, 'the set is uncapped by files and lines, so it reads whole');
  assert.ok(
    state.drawn.every((row) => !row.patchTooLarge && row.parts.length === 1),
    'no single file is too large'
  );
  assert.ok(body.length * 5 < 12 * 1024 * 1024, 'under the limit in UTF-16 units');
  assert.equal(state.capped, true, 'over 12 MiB in UTF-8 bytes');
});

test('an uncapped set reads every patch in ONE batch; a refresh reads only the files whose rows moved', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const tree = mountTree(t, 'C:/eager', 100, {
    omit: (path) => path === 'src/f009.ts' && tree.files[9].additions === 9,
  });
  const { calls, state } = tree;
  await tree.render();
  await tree.drain();
  assert.equal(calls.reviews, 1);
  assert.equal(state.capped, false, '100 files, 300 lines: not capped');
  assert.equal(calls.batches.length, 1, 'one batch per refresh');
  assert.equal(calls.batches[0].length, 100, 'every file at once, folded or not');
  assert.deepEqual(calls.singles, []);
  assert.ok(state.drawn.every((row) => !row.patchPending && row.parts.length === 1));
  // Our own reads are not Git evidence: nothing re-reads short of the safety lane.
  await tree.view.settle(20_000);
  assert.equal(calls.reviews, 1);
  // Evidence that moved nothing reads no patch and keeps every drawn row.
  const shown = state.drawn;
  await tree.gitChanged();
  assert.equal(calls.reviews, 2);
  assert.equal(calls.batches.length, 1, 'an unchanged refresh reads no patch');
  assert.ok(
    state.drawn.every((row, index) => row === shown[index]),
    'unchanged files keep their drawn row'
  );
  // One file's counts moved: the summary plus that file alone.
  tree.files[7] = reviewFile(tree.files[7].path, 3, 1);
  await tree.gitChanged();
  assert.equal(calls.reviews, 3);
  assert.deepEqual(calls.batches.slice(1), [['src/f007.ts']], 'a changed file re-reads only itself');
  assert.ok(state.drawn.every((row, index) => index === 7 || row === shown[index]));
  // A path the batch cannot serve is read on its own.
  tree.files[9] = reviewFile(tree.files[9].path, 9, 1);
  await tree.gitChanged();
  assert.deepEqual(calls.batches.at(-1), ['src/f009.ts']);
  assert.deepEqual(calls.singles, ['src/f009.ts']);
  assert.equal(state.drawn[9].parts.length, 1);
  // The safety tick that finds nothing new reads nothing more.
  await tree.view.settle(30_000);
  await tree.drain();
  assert.equal(calls.batches.length, 3);
  assert.equal(calls.singles.length, 1);
});

test('a capped set (over 128 files) reads only the selected file; picking another reads that one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const tree = mountTree(t, 'C:/capped', 433);
  const { calls, state } = tree;
  await tree.render({ selectedId: 'src/f000.ts' });
  await tree.drain();
  assert.equal(state.capped, true);
  assert.deepEqual(calls.batches, [['src/f000.ts']], 'only the selected file is read');
  assert.equal(state.drawn[0].parts.length, 1);
  assert.ok(
    state.drawn.slice(1).every((row) => row.patchPending),
    'the others list counts only'
  );
  await tree.render({ selectedId: 'src/f005.ts' });
  await tree.drain();
  assert.deepEqual(calls.batches.slice(1), [['src/f005.ts']]);
  // Back to a file already read, and an unchanged refresh: nothing is read.
  await tree.render({ selectedId: 'src/f000.ts' });
  await tree.gitChanged();
  assert.equal(calls.reviews, 2);
  assert.equal(calls.batches.length, 2);
});

test('a set past 9,000 changed lines is capped; a file past 15,000 lines is never read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const tree = mountTree(t, 'C:/lines', 3);
  tree.files[0] = reviewFile(tree.files[0].path, 15_001, 0);
  const { calls, state } = tree;
  await tree.render({ selectedId: 'src/f000.ts' });
  await tree.drain();
  assert.equal(state.capped, true, '15,005 changed lines in 3 files');
  assert.deepEqual(calls.batches, [], 'the selected file is past the per-file limit');
  assert.deepEqual(calls.singles, []);
});

test('a patch past 3 MiB is not kept: the file reads as too large to display', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const huge = `diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -1 +1 @@\n-a\n+${'x'.repeat(3 * 1024 * 1024)}\n`;
  const view = mount(t, {
    gitReview: async () => ({ repository: true, root: 'C:/bytes', base: 'HEAD', files: [reviewFile('big.txt', 1, 1)] }),
    gitReviewDiffs: async () => ({ patches: [{ path: 'big.txt', patch: huge }], omitted: [] }),
  });
  setSessionChangesSource('uncommitted');
  let drawn = [];
  function Pane() {
    const changes = useSessionChanges({ cwd: 'C:/bytes', sessionId: 'bytes', active: true });
    const { withPatch } = useSessionChangePatches({
      cwd: 'C:/bytes',
      sessionId: 'bytes',
      rows: changes.rows,
      selectedId: '',
    });
    drawn = changes.rows.map(withPatch);
    return null;
  }
  await act(async () => view.root.render(h(Pane)));
  await act(async () => {
    for (let index = 0; index < 2_000; index += 1) await Promise.resolve();
  });
  await view.settle(100);
  assert.equal(drawn[0].patchTooLarge, true);
  assert.equal(drawn[0].parts.length, 0);
});

test('a failed lazy file read shows a retryable failure, never "no textual differences", and the next generation retries it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n-old\n+new\n+more\n';
  let fail = true;
  let reads = 0;
  const view = mount(t, {
    gitReview: async () => ({ repository: true, root: 'C:/retry', base: 'HEAD', files: [reviewFile('a.ts', 2, 1)] }),
    gitReviewDiff: async () => {
      reads += 1;
      if (fail) throw new Error('git failed');
      return patch;
    },
  });
  setSessionChangesSource('uncommitted');
  let drawn = [];
  let refresh;
  function Pane() {
    const changes = useSessionChanges({ cwd: 'C:/retry', sessionId: 'retry', active: true });
    const { withPatch } = useSessionChangePatches({
      cwd: 'C:/retry',
      sessionId: 'retry',
      rows: changes.rows,
      selectedId: '',
    });
    drawn = changes.rows.map(withPatch);
    refresh = changes.refresh;
    return null;
  }
  const drain = () =>
    act(async () => {
      for (let index = 0; index < 2_000; index += 1) await Promise.resolve();
    });
  await act(async () => view.root.render(h(Pane)));
  await drain();
  await view.settle(200);
  assert.equal(reads, 1);
  assert.equal(drawn[0].patchFailed, true);
  assert.equal(drawn[0].parts.length, 0, 'a failure is not an empty successful diff');
  // A Refresh reads the tree again (a new generation) and asks the file again.
  fail = false;
  await act(async () => {
    await refresh(true);
  });
  await drain();
  await view.settle(200);
  assert.equal(reads, 2);
  assert.equal(drawn[0].patchFailed, undefined);
  assert.equal(drawn[0].parts.length, 1);
});

test('a lane revision on the publication envelope refreshes the session diff although the snapshot looks the same', async (t) => {
  let reads = 0;
  const view = mount(t, {
    invokeCapability: async () => {
      reads += 1;
      return { value: { supported: true, files: [], patch: '' } };
    },
  });
  const states = {};
  const Probe = probes(states);
  const snapshot = { sessionId: 'lane-rev', items: [{ id: 'last', completedAt: 1 }], busy: false };
  const publish = (contentRevision) =>
    act(async () => {
      defaultSessionLaneStore.apply({
        sessionId: 'lane-rev',
        frameSource: 'live',
        snapshot: { ...snapshot },
        contentRevision,
      });
    });
  await publish(1);
  await act(async () => view.root.render(h(Probe, { name: 'a', cwd: undefined, sessionId: 'lane-rev', active: true })));
  await view.settle();
  const wait = (ms) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  await wait(50);
  assert.equal(reads, 1);
  // A tool completes before the last transcript item: only the envelope revision moves.
  await publish(2);
  await wait(400);
  assert.equal(reads, 2);
  await publish(2);
  await wait(400);
  assert.equal(reads, 2, 'an unchanged revision reads nothing');
});

test('without a publication revision, a tool completing before the last transcript item still refreshes the session diff', async (t) => {
  let reads = 0;
  const view = mount(t, {
    invokeCapability: async () => {
      reads += 1;
      return { value: { supported: true, files: [], patch: '' } };
    },
  });
  const states = {};
  const Probe = probes(states);
  const items = (editStatus) => [
    { id: 'edit-tool', name: 'edit', status: editStatus },
    { id: 'last', completedAt: 1 },
  ];
  const publish = (editStatus) =>
    act(async () => {
      defaultSessionLaneStore.apply({
        sessionId: 'lane-no-rev',
        frameSource: 'live',
        snapshot: { sessionId: 'lane-no-rev', items: items(editStatus), busy: true },
      });
    });
  await publish('running');
  await act(async () =>
    view.root.render(h(Probe, { name: 'a', cwd: undefined, sessionId: 'lane-no-rev', active: true }))
  );
  await view.settle();
  const wait = (ms) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  await wait(50);
  assert.equal(reads, 1);
  await publish('running');
  await wait(400);
  assert.equal(reads, 1, 'an identical frame reads nothing');
  // The edit tool (not the last item) completes.
  await publish('completed');
  await wait(400);
  assert.equal(reads, 2);
});

test('with a publication revision the lane comparison never scans the transcript', async (t) => {
  const view = mount(t, { invokeCapability: async () => ({ value: { supported: true, files: [], patch: '' } }) });
  let scans = 0;
  const rows = Array.from({ length: 2_000 }, (_, index) => ({
    id: `row-${index}`,
    get streaming() {
      scans += 1;
      return false;
    },
  }));
  const states = {};
  const Probe = probes(states);
  const publish = (contentRevision) =>
    act(async () => {
      defaultSessionLaneStore.apply({
        sessionId: 'lane-scan',
        frameSource: 'live',
        snapshot: { sessionId: 'lane-scan', items: rows.map((row) => Object.create(row)), busy: false },
        ...(contentRevision === undefined ? {} : { contentRevision }),
      });
    });
  await publish(1);
  await act(async () =>
    view.root.render(h(Probe, { name: 'a', cwd: undefined, sessionId: 'lane-scan', active: true }))
  );
  await view.settle();
  const base = scans;
  await publish(2);
  const afterMove = scans;
  // Same-revision frames (deltas) are compared by revision, not by transcript.
  for (let frame = 0; frame < 5; frame += 1) await publish(2);
  await view.settle();
  assert.ok(
    scans - afterMove < rows.length,
    `a revisioned lane is not scanned per frame (saw ${scans - afterMove} field reads)`
  );
});

test('a newer-generation lazy read failure is shown beside the last good text, then clears on success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n-old\n+new\n+more\n';
  let fail = false;
  const view = mount(t, {
    gitReview: async () => ({ repository: true, root: 'C:/stale', base: 'HEAD', files: [reviewFile('a.ts', 2, 1)] }),
    gitReviewDiff: async () => {
      if (fail) throw new Error('git failed');
      return patch;
    },
  });
  setSessionChangesSource('uncommitted');
  let drawn = [];
  let refresh;
  function Pane() {
    const changes = useSessionChanges({ cwd: 'C:/stale', sessionId: 'stale', active: true });
    const { withPatch } = useSessionChangePatches({
      cwd: 'C:/stale',
      sessionId: 'stale',
      rows: changes.rows,
      selectedId: '',
    });
    drawn = changes.rows.map(withPatch);
    refresh = changes.refresh;
    return null;
  }
  const drain = () =>
    act(async () => {
      for (let index = 0; index < 2_000; index += 1) await Promise.resolve();
    });
  await act(async () => view.root.render(h(Pane)));
  await drain();
  await view.settle(200);
  assert.equal(drawn[0].parts.length, 1);
  assert.equal(drawn[0].patchFailed, undefined);
  fail = true;
  await act(async () => {
    await refresh(true);
  });
  await drain();
  await view.settle(200);
  assert.equal(drawn[0].patchFailed, true, 'the current generation failed');
  assert.equal(drawn[0].parts.length, 1, 'the last good text stays readable');
  fail = false;
  await act(async () => {
    await refresh(true);
  });
  await drain();
  await view.settle(200);
  assert.equal(drawn[0].patchFailed, undefined);
  assert.equal(drawn[0].parts.length, 1);
});

test('a root that is not a repository falls back to the session diff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let reviews = 0;
  const capabilities = [];
  const view = mount(t, {
    gitReview: async () => {
      reviews += 1;
      return { repository: false, root: '', base: '', files: [] };
    },
    invokeCapability: async (request) => {
      capabilities.push(request.capability);
      return {
        value: {
          supported: true,
          authoritative: true,
          complete: true,
          files: [{ path: 'notes.txt', status: 'A', additions: 2, deletions: 0 }],
          patch: '',
        },
      };
    },
  });
  const states = {};
  const Probe = probes(states);
  await act(async () =>
    view.root.render(h(Probe, { name: 'a', cwd: 'C:/plain-folder', sessionId: 'plain', active: true }))
  );
  await view.settle();
  assert.equal(states.a.repository, false);
  assert.deepEqual(capabilities, ['getSessionReviewDiff']);
  assert.deepEqual(
    states.a.rows.map((row) => row.path),
    ['notes.txt']
  );
  // The Git watch is gone: Git evidence no longer asks Git.
  await act(async () => view.window.dispatchEvent(new view.window.Event('mixdog:git-changed')));
  await view.settle(10_000);
  assert.equal(reviews, 1);
});
