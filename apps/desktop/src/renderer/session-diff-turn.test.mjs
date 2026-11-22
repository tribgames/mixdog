import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { SessionDiffPane } from './SessionDiffPane.tsx';
import {
  pendingSessionDiffFileRequest,
  requestSessionDiffFile,
  requestSessionDiffTurn,
  sessionDiffTurnTarget,
  useSessionDiffTurnLifetime,
} from './session-diff-focus.ts';
import { setSessionChangesSource } from './session-changes-store.ts';
import { bumpTurnChangesEpoch, fileIdentity, resetTurnChangesCache } from './turn-changes-model.ts';

const h = React.createElement;
const ROOT = 'C:/turn-repo';
const PLAN = 'src/rules/shared/25-plan.md';
const NOTES = 'docs/notes.md';
const patchFor = (path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
const turnPatchFor = (path) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,3 @@\n-a\n-b\n+c\n+d\n+e\n`;
const turnFile = (path, extra = {}) => ({
  path,
  status: 'M',
  additions: 3,
  deletions: 2,
  state: 'applied',
  revertable: true,
  ...extra,
});

const RECORD = { checkpointId: 'cp', boundary: 'done' };

/** A Git pane whose Changes source lists `sourceFiles`; `getTurnChanges`
 *  answers `files` (each file's patch unless it has a reason), or `answer`
 *  (given the reply, how many reads came before and what this one asks).
 *  `first` runs before the pane mounts. */
async function mountTurnPane(
  t,
  { files = [turnFile(PLAN), turnFile(NOTES)], sourceFiles = ['other.ts'], answer, props = {}, first } = {}
) {
  resetTurnChangesCache();
  const view = installTestDom(t, {
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'],
    rootId: 'root',
  });
  const reads = [];
  /** The source's own reads: its file list and each file's patch. */
  const sourceReads = [];
  view.window.mixdogDesktop = {
    gitReview: async () => {
      sourceReads.push('list');
      return {
        repository: true,
        root: ROOT,
        base: 'HEAD',
        files: sourceFiles.map((path) => ({ path, status: 'M', additions: 1, deletions: 1, untracked: false })),
      };
    },
    gitReviewDiff: async (_cwd, path) => {
      sourceReads.push(path);
      return patchFor(path);
    },
    invokeCapability: async (request) => {
      if (request.capability !== 'getTurnChanges') return { value: null };
      const [options] = request.args;
      reads.push(options);
      const reply = {
        status: 'ready',
        checkpointId: options.checkpointId,
        revision: 1,
        root: ROOT,
        files,
        patch: files
          // As the runtime: a file is named by its recorded path or an absolute one.
          .filter(
            (file) =>
              !file.reason && (!options.file || fileIdentity(ROOT, file.path) === fileIdentity(ROOT, options.file))
          )
          .map((file) => turnPatchFor(file.path))
          .join(''),
        canUndo: true,
        canReapply: false,
      };
      return { value: answer ? await answer(reply, reads.length, options) : reply };
    },
  };
  const settle = (ms = 150) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  const render = async (extra = {}) => {
    await act(async () =>
      view.root.render(
        h(SessionDiffPane, { active: true, onClose() {}, sessionId: 'turn-pane', cwd: ROOT, ...props, ...extra })
      )
    );
    await settle();
  };
  first?.();
  await render();
  const q = (selector) => view.document.querySelector(selector);
  const open = async (path, options = {}) => {
    await act(async () => requestSessionDiffTurn('turn-pane', RECORD, path, options));
    await settle();
  };
  const click = async (selector) => {
    await act(async () => q(selector).click());
    await settle();
  };
  return {
    ...view,
    reads,
    sourceReads,
    /** The reads of patches: the record's file list is read once, without one. */
    patchReads: () => reads.filter((read) => read.patch),
    settle,
    render,
    open,
    click,
    q,
    tab: (path) => q(`[data-session-diff-tab="${path}"]`),
    section: (path) => q(`.session-diff-section[data-session-diff-path="${path}"]`),
    paths: () =>
      [...view.document.querySelectorAll('.session-diff-section')].map((section) => section.dataset.sessionDiffPath),
    changesActive: () => q('[data-session-diff-changes-tab]')?.classList.contains('is-active') === true,
    back: () => click('.session-diff-turn-scope button'),
  };
}

test('a card file shows that file of the turn, read alone; View changes then shows every file of the turn', async (t) => {
  const view = await mountTurnPane(t);
  assert.deepEqual(view.paths(), ['other.ts']);
  await view.open(PLAN);
  assert.deepEqual(view.reads, [{ checkpointId: 'cp' }, { checkpointId: 'cp', patch: true, file: PLAN }]);
  assert.equal(view.patchReads().length, 1, 'only that file’s patch');
  assert.ok(view.q(`[data-session-diff-tab="${PLAN}"]`).classList.contains('is-active'));
  assert.deepEqual(view.paths(), [PLAN]);
  assert.match(view.q('.session-diff-section').textContent, /c[\s\S]*d[\s\S]*e/);
  assert.equal(view.q('.session-diff-source-select'), null);
  assert.equal(view.q('.session-diff-turn-label').textContent, 'Turn changes');
  await view.open('');
  assert.equal(view.changesActive(), true, 'Changes, not the file tab opened before');
  assert.deepEqual(view.paths(), [PLAN, NOTES]);
  assert.equal(view.document.querySelectorAll('.session-diff-section .inline-diff').length, 2);
  assert.deepEqual(view.patchReads().at(-1), { checkpointId: 'cp', patch: true });
});

test('Back from a turn file opened in a closed Changes pane lands on the source’s list', async (t) => {
  const selected = [];
  const view = await mountTurnPane(t, {
    props: {
      fileTabs: {
        tabs: [{ key: 'k1', name: 'readme.md', title: 'readme.md' }],
        onSelect: (key) => selected.push(key),
        onClose() {},
      },
    },
  });
  await act(async () => view.q('[data-session-diff-changes-tab] .browser-tab-close').click());
  assert.equal(view.q('[data-session-diff-changes-tab]'), null);
  await view.open(PLAN);
  assert.deepEqual(view.paths(), [PLAN]);
  await view.back();
  assert.equal(view.changesActive(), true);
  assert.deepEqual(view.paths(), ['other.ts']);
  assert.ok(view.q('.session-diff-source-select'));
});

test('another session or another Changes source leaves the turn', async (t) => {
  const view = await mountTurnPane(t);
  await view.open(PLAN);
  assert.ok(view.q('.session-diff-turn-label'));
  // A, B, A: the first session comes back on its source, not on the old turn.
  await view.render({ sessionId: 'turn-pane-b' });
  await view.render({ sessionId: 'turn-pane' });
  assert.equal(view.q('.session-diff-turn-label'), null);
  assert.deepEqual(view.paths(), ['other.ts']);
  await view.open(PLAN);
  assert.ok(view.q('.session-diff-turn-label'));
  // The composer's source menu changes the one shared source.
  await act(async () => setSessionChangesSource('branch'));
  await view.settle();
  assert.equal(view.q('.session-diff-turn-label'), null);
  assert.equal(view.q('.session-diff-source-select .mx-select-value').textContent, 'This branch');
  assert.equal(view.changesActive(), true);
  assert.deepEqual(view.paths(), ['other.ts']);
});

test('a read of an earlier history epoch changes nothing: an older success or failure answering late', async (t) => {
  const late = { [PLAN]: Promise.withResolvers(), [NOTES]: Promise.withResolvers() };
  let deleted = false;
  const view = await mountTurnPane(t, {
    answer: (reply, _count, options) => {
      // Every read after Delete history finds the record gone; the patches asked for before it answer late.
      if (deleted) return { ...reply, status: 'none', files: [], patch: '' };
      return options.patch ? late[options.file].promise.then(() => reply) : reply;
    },
  });
  await view.open(PLAN);
  await view.open(NOTES);
  await view.click('[data-session-diff-changes-tab] .browser-tab-select');
  deleted = true;
  await act(async () => bumpTurnChangesEpoch('turn-pane'));
  await view.settle();
  assert.equal(view.q('.utility-dock-empty').textContent, 'No changes');
  await act(async () => late[PLAN].resolve());
  await view.settle();
  assert.equal(view.q('.utility-dock-empty').textContent, 'No changes', 'the older success does not restore rows');
  await act(async () => late[NOTES].reject(new Error('older read failed')));
  await view.settle();
  assert.equal(view.q('.error-notice'), null, 'the older failure does not replace the newer answer');
  assert.equal(view.q('.utility-dock-empty').textContent, 'No changes');
});

test('each file tab keeps its own outcome: another file failing late leaves a diff already shown', async (t) => {
  const notes = Promise.withResolvers();
  const view = await mountTurnPane(t, {
    answer: (reply, _count, options) => (options.file === NOTES ? notes.promise : reply),
  });
  await view.open(PLAN);
  await view.open(NOTES);
  await view.click(`[data-session-diff-tab="${PLAN}"] .browser-tab-select`);
  await act(async () => notes.reject(new Error('notes could not be read')));
  await view.settle();
  assert.equal(view.q('.error-notice'), null, 'the selected file shows its diff');
  assert.ok(view.section(PLAN).querySelector('.inline-diff'));
  // The failure is the other file's: its own tab says so.
  await view.click(`[data-session-diff-tab="${NOTES}"] .browser-tab-select`);
  assert.match(view.q('.error-notice').textContent, /notes could not be read/);
  await view.click(`[data-session-diff-tab="${PLAN}"] .browser-tab-select`);
  assert.equal(view.q('.error-notice'), null);
  assert.ok(view.section(PLAN).querySelector('.inline-diff'));
});

test('a turn still being recorded says so, and shows its changes once the record answers', async (t) => {
  let recorded = false;
  const view = await mountTurnPane(t, {
    answer: (reply) => (recorded ? reply : { ...reply, status: 'pending', files: [], patch: '' }),
  });
  await view.open(PLAN);
  assert.equal(view.q('.utility-dock-empty').textContent, "This turn's changes are still being recorded.");
  assert.equal(view.patchReads().length, 0, 'no patch is asked of a record that is not there yet');
  assert.ok(view.tab(PLAN), 'the file keeps its tab');
  recorded = true;
  // The list is read again as the card's own read is (its wait for the record).
  await view.settle(600);
  assert.deepEqual(view.paths(), [PLAN]);
  assert.ok(view.section(PLAN).querySelector('.inline-diff'));
});

test('a file the turn’s record does not list says so the same way on every entry, and is never asked for', async (t) => {
  const view = await mountTurnPane(t);
  const GONE = `${ROOT}/src/gone.ts`;
  const shownAsUnrecorded = () => {
    assert.ok(view.tab(GONE).classList.contains('is-active'));
    assert.equal(view.q('.utility-dock-empty').textContent, 'No diff was recorded for this file.');
    assert.deepEqual(view.paths(), [], 'no other file is drawn in its place');
  };
  // Through its tool call first.
  await view.open('src/gone.ts', { cwd: ROOT });
  shownAsUnrecorded();
  // Then again after the turn's list was shown.
  await view.open('');
  assert.deepEqual(view.paths(), [PLAN, NOTES]);
  await view.open('src/gone.ts', { cwd: ROOT });
  shownAsUnrecorded();
  assert.ok(view.patchReads().every((read) => read.file === undefined), 'only the list’s patches were read');
});

test('a turn opened in a pane not shown before reads none of the source: the source reads once the turn is left', async (t) => {
  const view = await mountTurnPane(t, {
    first: () => requestSessionDiffTurn('turn-pane', RECORD, PLAN),
  });
  assert.deepEqual(view.paths(), [PLAN]);
  assert.deepEqual(view.sourceReads, [], 'neither the source’s list nor a patch of it');
  await view.back();
  assert.deepEqual(view.paths(), ['other.ts']);
  assert.ok(view.sourceReads.includes('list'));
});

test('Back lands on the source’s list also when a file of the source was still being opened', async (t) => {
  const view = await mountTurnPane(t, { sourceFiles: ['other.ts', 'more.ts'] });
  // The composer asks for a source file and, before its re-read answers, a turn file is opened.
  await act(async () => {
    requestSessionDiffFile('turn-pane', 'more.ts');
    requestSessionDiffTurn('turn-pane', RECORD, PLAN);
  });
  await view.settle();
  assert.equal(pendingSessionDiffFileRequest('turn-pane'), null, 'the later ask is the one served');
  await view.back();
  assert.equal(view.changesActive(), true);
  assert.equal(view.tab('more.ts'), null);
  assert.deepEqual(view.paths(), ['other.ts', 'more.ts']);
});

test('closing Changes while the first file is still being read leaves the turn on that file', async (t) => {
  const list = Promise.withResolvers();
  const view = await mountTurnPane(t, {
    answer: (reply, _count, options) => (options.patch ? reply : list.promise.then(() => reply)),
  });
  await view.open(PLAN);
  assert.ok(view.tab(PLAN).classList.contains('is-active'), 'the file has its tab before the record answers');
  assert.equal(view.changesActive(), false);
  await view.click('[data-session-diff-changes-tab] .browser-tab-close');
  assert.ok(view.q('.session-diff-turn-label'), 'the turn is not left');
  assert.equal(view.q('[data-session-diff-changes-tab]'), null);
  await act(async () => list.resolve());
  await view.settle();
  assert.deepEqual(view.paths(), [PLAN]);
});

test('a tool call that names no folder waits for the session’s: its file is not taken under the record’s root', async (t) => {
  const APP = 'packages/app/src/a.ts';
  const view = await mountTurnPane(t, { files: [turnFile('src/a.ts'), turnFile(APP)], props: { cwd: '' } });
  await view.open('src/a.ts', { cwd: '' });
  assert.equal(view.patchReads().length, 0, 'nothing is read while the folder is unknown');
  assert.deepEqual(view.paths(), []);
  // The session's folder arrives.
  await view.render({ cwd: `${ROOT}/packages/app` });
  assert.equal(view.patchReads()[0].file, `${ROOT}/${APP}`);
  assert.ok(view.tab(APP).classList.contains('is-active'));
  assert.deepEqual(view.paths(), [APP]);
});

test('a turn asked for and left before its pane mounted is not shown later', async (t) => {
  const view = installTestDom(t, { expose: ['HTMLElement', 'Node', 'Event'], rootId: 'root' });
  // What stands in for the pane while its module loads.
  function Host({ sessionId, active }) {
    useSessionDiffTurnLifetime(sessionId, active);
    return null;
  }
  await act(async () => view.root.render(h(Host, { sessionId: 'early', active: true })));
  await act(async () => requestSessionDiffTurn('early', RECORD, PLAN));
  assert.ok(sessionDiffTurnTarget('early'));
  await act(async () => view.root.render(h(Host, { sessionId: 'other', active: true })));
  assert.equal(sessionDiffTurnTarget('early'), null, 'another session ends it');
  await act(async () => requestSessionDiffTurn('other', RECORD, PLAN));
  await act(async () => view.root.render(h(Host, { sessionId: 'other', active: false })));
  assert.equal(sessionDiffTurnTarget('other'), null, 'and so does closing the view');
});

test('turn rows keep the record’s reason and open a file where it is now', async (t) => {
  const opened = [];
  const view = await mountTurnPane(t, {
    files: [
      turnFile('lost.md', { reason: 'The content of this file was not captured.' }),
      turnFile('b.ts', { oldPath: 'a.ts', status: 'R', state: 'reverted' }),
    ],
    props: { onOpenFile: (path) => opened.push(path) },
  });
  await view.open('');
  const section = (path) => view.q(`.session-diff-section[data-session-diff-path="${path}"]`);
  assert.match(section('lost.md').textContent, /No diff was recorded for this file\./);
  assert.doesNotMatch(section('lost.md').textContent, /No textual differences\./);
  // Undone, the rename is back at its old path.
  await act(async () => section('b.ts').querySelector('.session-diff-open').click());
  assert.deepEqual(opened, ['a.ts']);
});

test('the turn list leaves out the files the card did, as shown by visualize cards', async (t) => {
  const view = await mountTurnPane(t);
  await view.open('', { visualized: [`${ROOT}/${NOTES}`] });
  assert.deepEqual(view.paths(), [PLAN]);
});

test('a file the card left out still opens from its tool call; the list stays the card’s', async (t) => {
  const view = await mountTurnPane(t);
  await view.open(NOTES, { cwd: ROOT, visualized: [`${ROOT}/${NOTES}`] });
  assert.ok(view.tab(NOTES).classList.contains('is-active'));
  assert.deepEqual(view.paths(), [NOTES]);
  await view.click('[data-session-diff-changes-tab] .browser-tab-select');
  assert.deepEqual(view.paths(), [PLAN]);
});

test('opening the same file or the list of a turn again shows it, never a loading screen', async (t) => {
  const view = await mountTurnPane(t);
  await view.open(PLAN);
  await view.open(PLAN);
  assert.deepEqual(view.paths(), [PLAN]);
  assert.match(view.section(PLAN).textContent, /c[\s\S]*d[\s\S]*e/);
  await view.open('');
  await view.open('');
  assert.deepEqual(view.paths(), [PLAN, NOTES]);
  assert.equal(view.patchReads().length, 2, 'what is held is not read again');
  assert.equal(view.reads.length, 3, 'and the list was read once');
});

test('each file tab of a turn shows its own patch, and Refresh reads the selected file', async (t) => {
  const view = await mountTurnPane(t);
  await view.open(PLAN);
  await view.open(NOTES);
  await view.click(`[data-session-diff-tab="${PLAN}"] .browser-tab-select`);
  assert.deepEqual(view.paths(), [PLAN]);
  assert.ok(view.section(PLAN).querySelector('.inline-diff'));
  assert.doesNotMatch(view.section(PLAN).textContent, /Loading diff/);
  await view.click('.session-diff-refresh');
  assert.equal(view.patchReads().at(-1).file, PLAN);
  assert.ok(view.section(PLAN).querySelector('.inline-diff'));
});

test('Refresh reads the list again first: the patch is asked once it answers, and a list that fails says so', async (t) => {
  let gate = null;
  const view = await mountTurnPane(t, {
    answer: (reply, _count, options) => (!options.patch && gate ? gate.promise.then(() => reply) : reply),
  });
  await view.open(PLAN);
  gate = Promise.withResolvers();
  await view.click('.session-diff-refresh');
  assert.equal(view.patchReads().length, 1, 'no patch is asked of a list still being read again');
  await act(async () => gate.resolve());
  await view.settle();
  assert.equal(view.patchReads().length, 2);
  assert.ok(view.section(PLAN).querySelector('.inline-diff'));
  gate = Promise.withResolvers();
  await view.click('.session-diff-refresh');
  await act(async () => gate.reject(new Error('the record could not be read')));
  await view.settle();
  assert.match(view.q('.error-notice').textContent, /the record could not be read/);
  assert.equal(view.patchReads().length, 2);
});

test('a newer end of the same checkpoint is another record: its list and its patches are read anew', async (t) => {
  const view = await mountTurnPane(t);
  await view.open('');
  assert.equal(view.patchReads().length, 1);
  // A wake closed the checkpoint again: the card now stands on that end.
  await act(async () => requestSessionDiffTurn('turn-pane', { checkpointId: 'cp', boundary: 'done-2' }, ''));
  await view.settle();
  assert.equal(view.reads.filter((read) => !read.patch).length, 2);
  assert.equal(view.patchReads().length, 2);
  assert.equal(view.document.querySelectorAll('.session-diff-section .inline-diff').length, 2);
});

test('a session at a root folder is a known folder: a tool call’s path is taken under it', async (t) => {
  const view = await mountTurnPane(t, { files: [turnFile('/etc/hosts')], props: { cwd: '/' } });
  await view.open('etc/hosts', { cwd: '' });
  assert.equal(view.patchReads()[0].file, '/etc/hosts');
  assert.deepEqual(view.paths(), ['/etc/hosts']);
});

test('leaving a turn before its file is read opens nothing in the source later', async (t) => {
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  const view = await mountTurnPane(t, {
    sourceFiles: ['other.ts', PLAN],
    answer: (reply, count) => gates[count - 1].promise.then(() => reply),
  });
  const sourceUntouched = async (gate) => {
    await act(async () => gate.resolve());
    await view.settle();
    assert.equal(view.q('.session-diff-turn-label'), null);
    assert.equal(pendingSessionDiffFileRequest('turn-pane'), null);
    assert.equal(view.changesActive(), true);
    assert.equal(view.tab(PLAN), null, 'the turn’s file is not opened as the source’s');
    assert.deepEqual(view.paths(), ['other.ts', PLAN]);
  };
  await view.open(PLAN);
  await view.back();
  await sourceUntouched(gates[0]);
  await view.open(PLAN);
  await act(async () => setSessionChangesSource('branch'));
  await view.settle();
  await sourceUntouched(gates[1]);
});

test('the source’s file tabs open before a turn are there after it; the turn’s own are gone', async (t) => {
  const view = await mountTurnPane(t);
  await act(async () => requestSessionDiffFile('turn-pane', 'other.ts'));
  await view.settle();
  assert.ok(view.tab('other.ts'));
  await view.open(PLAN);
  assert.equal(view.tab('other.ts'), null, 'the turn’s strip is its own');
  await view.back();
  assert.ok(view.tab('other.ts'));
  assert.equal(view.tab(PLAN), null);
  assert.equal(view.changesActive(), true);
  // Entered again, the turn starts over: no tab of its earlier showing.
  await view.open('');
  assert.equal(view.tab(PLAN), null);
  assert.deepEqual(view.paths(), [PLAN, NOTES]);
  await act(async () => setSessionChangesSource('branch'));
  await view.settle();
  assert.ok(view.tab('other.ts'));
  assert.equal(view.changesActive(), true);
  assert.deepEqual(view.paths(), ['other.ts']);
});

test('a tool call’s path is taken under its folder, not the record’s root', async (t) => {
  const APP = 'packages/app/src/a.ts';
  const view = await mountTurnPane(t, {
    files: [turnFile('src/a.ts'), turnFile(APP)],
    props: { cwd: `${ROOT}/packages/app` },
  });
  // The call names no folder: the session’s.
  await view.open('src/a.ts', { cwd: '' });
  assert.equal(view.patchReads()[0].file, `${ROOT}/${APP}`);
  assert.ok(view.tab(APP).classList.contains('is-active'));
  assert.deepEqual(view.paths(), [APP]);
  await view.open('a.ts', { cwd: `${ROOT}/src` });
  assert.ok(view.tab('src/a.ts').classList.contains('is-active'));
  assert.deepEqual(view.paths(), ['src/a.ts']);
});

test('after Undo a turn file opens where it is: an undone addition is gone, an undone deletion is back', async (t) => {
  const opened = [];
  const view = await mountTurnPane(t, {
    files: [
      turnFile('added.ts', { status: 'A', deletions: 0, state: 'reverted' }),
      turnFile('removed.ts', { status: 'D', additions: 0, state: 'reverted' }),
    ],
    props: { onOpenFile: (path) => opened.push(path) },
  });
  await view.open('');
  const listed = (path) => view.section(path).querySelector('.session-diff-open');
  assert.equal(listed('added.ts').disabled, true);
  assert.equal(listed('removed.ts').disabled, false);
  await act(async () => listed('removed.ts').click());
  assert.deepEqual(opened, ['removed.ts']);
  // The file's own tab decides the same.
  await view.open('added.ts');
  assert.equal(view.q('.session-diff-toolbar .session-diff-open').disabled, true);
  await view.open('removed.ts');
  await view.click('.session-diff-toolbar .session-diff-open');
  assert.deepEqual(opened, ['removed.ts', 'removed.ts']);
});
