import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { TurnChangesCard, TurnChangesContext, TurnChangesUndo } from './TurnChangesCard.tsx';
import { allChangesVisualized, resetTurnChangesCache, unvisualizedChanges } from './turn-changes-model.ts';
import { useSessionDiffFileRequest } from './session-diff-focus.ts';

const h = React.createElement;
const ROOT = 'C:/Project/app';

const file = (path, extra = {}) => ({
  path,
  status: 'M',
  additions: 3,
  deletions: 1,
  state: 'applied',
  revertable: true,
  ...extra,
});
const ready = (files, extra = {}) => ({
  status: 'ready',
  checkpointId: 'cp',
  revision: 7,
  root: ROOT,
  files,
  canUndo: true,
  canReapply: false,
  ...extra,
});

/** Mounts one card. `reply(request)` answers every capability call. */
async function mountCard(t, { reply, surface = {}, turnChanges = {}, framed = false, visualized, undo = false }) {
  resetTurnChangesCache();
  const { dom, document, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent'],
    rootId: 'root',
  });
  const calls = [];
  const toasts = [];
  dom.window.addEventListener('mixdog:desktop-toast', (event) => toasts.push(event.detail));
  dom.window.mixdogDesktop = {
    invokeCapability: async (request) => {
      calls.push(request);
      const value = await reply(request, calls);
      if (value instanceof Error) throw value;
      return { value };
    },
  };
  const opened = [];
  const diffOpened = [];
  const requests = [];
  function RequestProbe() {
    const request = useSessionDiffFileRequest('s1');
    requests.push(request ? request.path : null);
    return null;
  }
  const value = {
    sessionId: 's1',
    busy: false,
    turnRunning: false,
    onOpenSessionDiff: () => diffOpened.push(true),
    onOpenFile: (project, rel) => opened.push([project, rel]),
    ...surface,
  };
  const ref = { checkpointId: 'cp', boundary: 'done-1', trailing: false, ...turnChanges };
  const render = (nextValue = value, nextRef = ref) =>
    act(async () => {
      root.render(
        h(
          TurnChangesContext.Provider,
          { value: nextValue },
          undo
            ? h(TurnChangesUndo, { turnChanges: nextRef, visualized })
            : framed
              ? h(TurnChangesCard, {
                  turnChanges: nextRef,
                  visualized,
                  frame: (card) => h('div', { className: 'frame' }, card),
                })
              : h(TurnChangesCard, { turnChanges: nextRef, visualized }),
          h(RequestProbe)
        )
      );
    });
  await render();
  await settle();
  const q = (selector) => document.querySelector(selector);
  const qa = (selector) => [...document.querySelectorAll(selector)];
  const click = (node, init = {}) =>
    act(async () => {
      node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ...init }));
    });
  return { dom, document, calls, toasts, opened, diffOpened, requests, q, qa, click, render, value, ref };
}

const settle = (ms = 20) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

test('none and missing replies render no card', async (t) => {
  for (const status of ['none', 'missing']) {
    await t.test(status, async (t) => {
      const view = await mountCard(t, { reply: () => ({ ...ready([]), status }) });
      assert.equal(view.q('.turn-changes-card'), null);
      assert.deepEqual(view.calls[0].args, [{ checkpointId: 'cp' }]);
      assert.equal(view.calls[0].capability, 'getTurnChanges');
      assert.equal(view.calls[0].sessionId, 's1');
    });
  }
});

test('agent mode: the same card, seated by its frame only when it shows', async (t) => {
  await t.test('the coding card, framed', async (t) => {
    const two = await mountCard(t, { framed: true, reply: () => ready([file('a.ts'), file('src/b.ts')]) });
    const card = two.q('.frame > .turn-changes-card');
    assert.ok(card);
    assert.equal(card.dataset.fileCount, '2');
    assert.equal(two.qa('.turn-changes-file').length, 2, 'the same file rows');
    assert.ok(card.querySelector('.turn-changes-view'), 'the same View changes action');
    await two.click(card.querySelector('.turn-changes-view'));
    assert.deepEqual(two.diffOpened, [true]);
  });
  await t.test('while its turn runs: no card, no frame', async (t) => {
    const running = await mountCard(t, {
      framed: true,
      reply: () => ready([file('a.ts')]),
      surface: { turnRunning: true },
      turnChanges: { trailing: true },
    });
    assert.equal(running.q('.frame'), null);
  });
  await t.test('nothing changed: no card, no frame', async (t) => {
    const none = await mountCard(t, { framed: true, reply: () => ready([]) });
    assert.equal(none.q('.frame'), null);
  });
});

// Entering a bot chat painted every bubble without its card, then each card
// landed when its read answered and the chat jumped. Until the first read
// answers the row is pending (the transcript's entry reveal waits for it).
test('an unread card marks its row pending until the first read answers', async (t) => {
  const pending = '[data-transcript-pending]';
  await t.test('a read in flight: pending, then the card in its place', async (t) => {
    let answer;
    const view = await mountCard(t, { reply: () => new Promise((resolve) => (answer = resolve)) });
    assert.ok(view.q(pending), 'pending while the read is in flight');
    assert.equal(view.q('.turn-changes-card'), null);
    await act(async () => answer(ready([file('mixdog-community-state.json', { additions: 1, deletions: 1 })])));
    await settle();
    assert.equal(view.q(pending), null);
    assert.ok(view.q('.turn-changes-card'));
  });
  await t.test('a cached reply paints the card in the first render', async (t) => {
    const first = await mountCard(t, { reply: () => ready([file('a.ts')]) });
    assert.ok(first.q('.turn-changes-card'));
    await first.render(first.value, { ...first.ref, checkpointId: 'other' });
    await first.render();
    assert.equal(first.q(pending), null, 'a remount on a cached reply is never pending');
    assert.ok(first.q('.turn-changes-card'));
  });
  for (const [name, reply] of [
    ['no change', () => ready([])],
    ['a failed read', () => new Error('offline')],
    ['a turn still recording', () => ({ ...ready([]), status: 'pending' })],
  ]) {
    await t.test(`${name}: the row is not left pending`, async (t) => {
      const view = await mountCard(t, { reply });
      assert.equal(view.q(pending), null);
      assert.equal(view.q('.turn-changes-card'), null);
    });
  }
  await t.test('a running turn is not read, so not pending', async (t) => {
    const view = await mountCard(t, {
      reply: () => new Promise(() => {}),
      surface: { turnRunning: true },
      turnChanges: { trailing: true },
    });
    assert.equal(view.q(pending), null);
  });
});

test('a visualized file is its visualize card, not a diff row', async (t) => {
  const absolute = `${ROOT}/design/mockups/app-skins/index.html`;
  await t.test('every file visualized: no changes card', async (t) => {
    const view = await mountCard(t, {
      reply: () => ready([file('design/mockups/app-skins/index.html')]),
      visualized: [absolute],
    });
    assert.equal(view.q('.turn-changes-card'), null);
  });
  await t.test('some visualized: the card lists only the rest, Undo still undoes the whole turn', async (t) => {
    const view = await mountCard(t, {
      reply: () =>
        ready([file('design/mockups/app-skins/index.html', { additions: 9, deletions: 0 }), file('src/b.ts')]),
      visualized: ['design/mockups/app-skins/index.html'],
    });
    const card = view.q('.turn-changes-card');
    assert.equal(card.dataset.fileCount, '1');
    assert.deepEqual(
      view.qa('.turn-changes-base').map((node) => node.textContent),
      ['b.ts']
    );
    assert.equal(view.q('.turn-changes-title strong').textContent, '1 file changed');
    assert.match(view.q('.turn-changes-title .diff-stats').textContent, /\+3/);
    await view.click(view.q('.turn-changes-action'));
    await settle();
    assert.deepEqual(view.calls.find((call) => call.capability === 'revertTurnChanges').args, ['cp', null, 7]);
  });
  await t.test('nothing visualized: the whole list, as before', async (t) => {
    const view = await mountCard(t, { reply: () => ready([file('a.ts'), file('b.ts')]), visualized: [] });
    assert.equal(view.q('.turn-changes-card').dataset.fileCount, '2');
  });
  await t.test('a same-named file in another folder is still listed (no suffix matching)', async (t) => {
    const view = await mountCard(t, {
      reply: () => ready([file('index.html'), file('site/index.html')]),
      visualized: [`${ROOT}/index.html`],
    });
    assert.equal(view.q('.turn-changes-card').dataset.fileCount, '1');
    assert.match(view.q('.turn-changes-card').textContent, /site\//);
  });
});

test('a visualized target names the changed file by its full path, not its tail', () => {
  const files = [file('index.html'), file('site/index.html'), file('src/a.ts')];
  const names = (visualized, root = ROOT) => unvisualizedChanges(files, visualized, root).map((f) => f.path);
  assert.deepEqual(names(['index.html']), ['site/index.html', 'src/a.ts']);
  assert.deepEqual(names([`${ROOT}/index.html`]), ['site/index.html', 'src/a.ts']);
  assert.deepEqual(names([`${ROOT}/site/index.html`]), ['index.html', 'src/a.ts']);
  assert.deepEqual(names(['site/index.html']), ['index.html', 'src/a.ts']);
  // A target outside the root is no changed file of the root.
  assert.deepEqual(names(['C:/other/index.html']), ['index.html', 'site/index.html', 'src/a.ts']);
  // Separators, `./`, `..` and drive-letter case are not identity.
  assert.deepEqual(names(['.\\site\\..\\index.html']), ['site/index.html', 'src/a.ts']);
  assert.deepEqual(names(['c:\\project\\APP\\Src\\a.ts']), ['index.html', 'site/index.html']);
  // An outside file is recorded absolute.
  assert.deepEqual(
    unvisualizedChanges([file('D:/x/index.html'), file('index.html')], ['d:\\X\\INDEX.html'], ROOT).map((f) => f.path),
    ['index.html']
  );
  assert.equal(allChangesVisualized(files, ['index.html', 'site/index.html', 'src/a.ts'], ROOT), true);
  assert.equal(allChangesVisualized(files, ['index.html'], ROOT), false);
});

test('every file visualized: the visualize card carries the whole-turn Undo', async (t) => {
  await t.test('all shown: Undo here, then Reapply', async (t) => {
    const reply = (request) =>
      request.capability === 'revertTurnChanges'
        ? ready([file('site/a.html', { state: 'reverted' })], { revision: 8, canUndo: false, canReapply: true })
        : ready([file('site/a.html')]);
    const view = await mountCard(t, { reply, undo: true, visualized: ['site/a.html'] });
    assert.equal(view.q('.turn-changes-card'), null);
    assert.equal(view.q('.turn-changes-action').textContent, 'Undo');
    await view.click(view.q('.turn-changes-action'));
    await settle();
    assert.deepEqual(view.calls.find((call) => call.capability === 'revertTurnChanges').args, ['cp', null, 7]);
    assert.equal(view.q('.turn-changes-action').textContent, 'Reapply');
  });
  await t.test('a file the cards did not show keeps Undo on the changes card instead', async (t) => {
    const view = await mountCard(t, {
      reply: () => ready([file('site/a.html'), file('b.ts')]),
      undo: true,
      visualized: ['site/a.html'],
    });
    assert.equal(view.q('.turn-changes-action'), null);
  });
});

test('pending retries with backoff and only then renders', async (t) => {
  const view = await mountCard(t, {
    reply: (_request, calls) => (calls.length === 1 ? { ...ready([]), status: 'pending' } : ready([file('a.ts')])),
  });
  assert.equal(view.q('.turn-changes-card'), null);
  assert.equal(view.calls.length, 1);
  await settle(500);
  assert.equal(view.calls.length, 2);
  assert.ok(view.q('.turn-changes-card'));
});

test('a running trailing turn shows no card and does not fetch', async (t) => {
  const view = await mountCard(t, {
    reply: () => ready([file('a.ts')]),
    surface: { turnRunning: true },
    turnChanges: { trailing: true },
  });
  assert.equal(view.q('.turn-changes-card'), null);
  assert.equal(view.calls.length, 0);
  // An earlier turn's card stays visible while a newer turn runs.
  await view.render({ ...view.value, turnRunning: true }, { ...view.ref, trailing: false });
  await settle();
  assert.ok(view.q('.turn-changes-card'));
});

test('one file: count title on one line, its row, and the whole-turn Undo in the header', async (t) => {
  const view = await mountCard(t, {
    reply: (request) =>
      request.capability === 'revertTurnChanges'
        ? ready([file('src/deep/TurnReview.tsx', { additions: 2, deletions: 2, state: 'reverted' })], {
            revision: 8,
            canUndo: false,
            canReapply: true,
          })
        : ready([file('src/deep/TurnReview.tsx', { additions: 2, deletions: 2 })]),
  });
  assert.equal(view.q('.turn-changes-title strong').textContent, '1 file changed');
  assert.match(view.q('.turn-changes-title .diff-stats').textContent, /\+2.*\u22122/);
  assert.equal(view.q('.turn-changes-sub-hover'), null);
  const rows = view.qa('.turn-changes-file');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].querySelector('.turn-changes-base').textContent, 'TurnReview.tsx');
  assert.equal(rows[0].querySelector('.turn-changes-dir'), null, 'inside the project: no location hint');
  assert.equal(view.q('.turn-changes-trail .turn-changes-action').textContent, 'Undo');
  // Whole-turn Undo, without a confirm step.
  await view.click(view.q('.turn-changes-action'));
  await settle();
  assert.deepEqual(view.calls.find((call) => call.capability === 'revertTurnChanges').args, ['cp', null, 7]);
  assert.equal(view.q('.turn-changes-action').textContent, 'Reapply');
  assert.equal(view.q('.turn-review-confirm'), null);
  assert.equal(view.q('.turn-changes-file').dataset.reverted, 'true');
  // Header click opens the session diff on the whole diff; Ctrl+click on the row opens the file.
  await view.click(view.q('.turn-changes-summary'));
  assert.equal(view.diffOpened.length, 1);
  assert.equal(view.requests.at(-1), '');
  await view.click(view.q('.turn-changes-file-main'), { ctrlKey: true });
  assert.deepEqual(view.opened, [[ROOT, 'src/deep/TurnReview.tsx']]);
  assert.equal(view.diffOpened.length, 1);
});

test('rows show a file icon and name, per-file counts without zeros, and no directory inside the project', async (t) => {
  const view = await mountCard(t, {
    reply: () => ready([file('apps/x/A.tsx'), file('apps/x/B.tsx'), file('C.md', { additions: 41, deletions: 0 })]),
  });
  assert.equal(view.q('.turn-changes-title strong').textContent, '3 files changed');
  assert.match(view.q('.turn-changes-title .diff-stats').textContent, /\+47.*\u22122/);
  const rows = view.qa('.turn-changes-file');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].querySelector('.turn-changes-base').textContent, 'A.tsx');
  assert.ok(rows[0].querySelector('.seti-icon'));
  assert.equal(rows[2].querySelector('.diff-stats').textContent, '+41');
  assert.equal(view.q('.turn-changes-more'), null);
  assert.ok(view.q('.turn-changes-action'));
});

test('a file outside the project shows its name only, with the full path in the tooltip', async (t) => {
  const dir = 'C:/Users/someone/AppData/Local/Temp/a-rather-long-folder-name';
  const view = await mountCard(t, { reply: () => ready([file('src/a.ts'), file(`${dir}/outside-note.txt`)]) });
  const [, outside] = view.qa('.turn-changes-file');
  assert.equal(outside.querySelector('.turn-changes-base').textContent, 'outside-note.txt');
  assert.equal(outside.querySelector('.turn-changes-prefix'), null);
  assert.equal(outside.querySelector('.turn-changes-file-main').title, `${dir}/outside-note.txt`);
});
test('four or more files show three rows and a Show more / Collapse toggle', async (t) => {
  const view = await mountCard(t, {
    reply: () => ready(['a', 'b', 'c', 'd', 'e'].map((name) => file(`src/${name}.ts`))),
  });
  assert.equal(view.qa('.turn-changes-file').length, 3);
  const more = view.q('.turn-changes-more');
  assert.equal(more.textContent, 'Show 2 more files');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  await view.click(more);
  assert.equal(view.qa('.turn-changes-file').length, 5);
  assert.equal(view.q('.turn-changes-more').textContent, 'Collapse files');
  await view.click(view.q('.turn-changes-more'));
  assert.equal(view.qa('.turn-changes-file').length, 3);
});

test('four files offer "Show 1 more file"', async (t) => {
  const view = await mountCard(t, { reply: () => ready(['a', 'b', 'c', 'd'].map((name) => file(`${name}.ts`))) });
  assert.equal(view.q('.turn-changes-more').textContent, 'Show 1 more file');
});

test('row click focuses the file in the session diff; Ctrl/Cmd+click opens it', async (t) => {
  const view = await mountCard(t, { reply: () => ready([file('src/a.ts'), file('src/b.ts', { status: 'D' })]) });
  const mains = view.qa('.turn-changes-file-main');
  await view.click(mains[0]);
  assert.equal(view.requests.at(-1), 'src/a.ts');
  assert.equal(view.diffOpened.length, 1);
  await view.click(mains[0], { metaKey: true });
  assert.deepEqual(view.opened, [[ROOT, 'src/a.ts']]);
  // A file the turn deleted does not exist to open.
  await view.click(mains[1], { ctrlKey: true });
  assert.deepEqual(view.opened, [[ROOT, 'src/a.ts']]);
  // The header opens the pane without targeting a file.
  await view.click(view.q('.turn-changes-summary'));
  assert.equal(view.requests.at(-1), '', 'View changes asks for the all-files list, not a cancellation');
  assert.equal(view.diffOpened.length, 2);
});

test('a file click carries the recorded root with its path', async (t) => {
  const view = await mountCard(t, { reply: () => ready([file('x.txt')]) });
  await view.click(view.q('.turn-changes-file-main'));
  const { pendingSessionDiffFileRequest } = await import('./session-diff-focus.ts');
  assert.equal(pendingSessionDiffFileRequest('s1').root, ROOT);
  assert.equal(pendingSessionDiffFileRequest('s1').path, 'x.txt');
});

test('Undo reverts the whole turn, then the header offers Reapply', async (t) => {
  const view = await mountCard(t, {
    reply: (request) => {
      if (request.capability === 'revertTurnChanges') {
        return ready([file('a.ts', { state: 'reverted' }), file('b.ts', { state: 'reverted' })], {
          revision: 8,
          canUndo: false,
          canReapply: true,
        });
      }
      if (request.capability === 'reapplyTurnChanges') return ready([file('a.ts'), file('b.ts')], { revision: 9 });
      return ready([file('a.ts'), file('b.ts')]);
    },
  });
  const action = view.q('.turn-changes-action');
  assert.equal(action.textContent, 'Undo');
  assert.equal(action.disabled, false);
  await view.click(action);
  await settle();
  const revert = view.calls.find((call) => call.capability === 'revertTurnChanges');
  assert.deepEqual(revert.args, ['cp', null, 7]);
  assert.equal(revert.sessionId, 's1');
  assert.equal(view.q('.turn-changes-action').textContent, 'Reapply');
  assert.deepEqual(
    view.qa('.turn-changes-file').map((row) => row.dataset.reverted),
    ['true', 'true']
  );
  assert.deepEqual(
    view.toasts.map((toast) => [toast.text, toast.tone]),
    [['Changes undone', 'success']]
  );
  await view.click(view.q('.turn-changes-action'));
  await settle();
  const reapply = view.calls.find((call) => call.capability === 'reapplyTurnChanges');
  assert.deepEqual(reapply.args, ['cp', null, 8]);
  assert.equal(view.q('.turn-changes-action').textContent, 'Undo');
});

test('Undo is disabled with the runtime reason', async (t) => {
  const view = await mountCard(t, {
    reply: () =>
      ready([file('a.ts'), file('b.ts')], { canUndo: false, canReapply: false, reason: 'Files changed since' }),
  });
  const action = view.q('.turn-changes-action');
  assert.equal(action.textContent, 'Undo');
  assert.equal(action.disabled, true);
  assert.equal(action.dataset.tooltip, 'Files changed since');
});

test('every action is disabled while the session is busy', async (t) => {
  const busy = await mountCard(t, { reply: () => ready([file('a.ts'), file('b.ts')]), surface: { busy: true } });
  assert.equal(busy.q('.turn-changes-action').disabled, true);
  assert.equal(busy.q('.turn-changes-action').dataset.tooltip, 'Unavailable while the session is busy');
  for (const button of busy.qa('.turn-changes-file .turn-review-revert')) assert.equal(button.disabled, true);
});

test('a refused mutation shows its message in the card', async (t) => {
  const view = await mountCard(t, {
    reply: (request) =>
      request.capability === 'revertTurnChanges' ? new Error('Worktree moved on') : ready([file('a.ts'), file('b.ts')]),
  });
  await view.click(view.q('.turn-changes-action'));
  await settle();
  assert.match(view.q('.turn-changes-error').textContent, /Worktree moved on/);
  assert.equal(view.q('.turn-changes-action').disabled, false);
});

test('a mutation refused for a stale revision rereads the checkpoint so a retry succeeds', async (t) => {
  // Another client already undid b.ts: the runtime is at revision 9.
  let revision = 7;
  const view = await mountCard(t, {
    reply: (request) => {
      if (request.capability === 'revertTurnChanges') {
        if (request.args[2] !== revision) return new Error('turn changes changed; refresh');
        return ready([file('a.ts', { state: 'reverted' }), file('b.ts', { state: 'reverted' })], {
          revision: revision + 1,
          canUndo: false,
          canReapply: true,
        });
      }
      return ready([file('a.ts'), file('b.ts', { state: revision > 7 ? 'reverted' : 'applied' })], { revision });
    },
  });
  revision = 9;
  await view.click(view.q('.turn-changes-action'));
  await settle();
  const reads = view.calls.filter((call) => call.capability === 'getTurnChanges');
  assert.equal(reads.length, 2, 'the refusal rereads the checkpoint');
  assert.match(view.q('.turn-changes-error').textContent, /turn changes changed; refresh/, 'the error stays visible');
  assert.equal(view.qa('.turn-changes-file')[1].dataset.reverted, 'true', 'the reread state is shown');
  await view.click(view.q('.turn-changes-action'));
  await settle();
  const reverts = view.calls.filter((call) => call.capability === 'revertTurnChanges');
  assert.deepEqual(
    reverts.map((call) => call.args),
    [
      ['cp', null, 7],
      ['cp', null, 9],
    ]
  );
  assert.equal(view.q('.turn-changes-error'), null);
  assert.equal(view.q('.turn-changes-action').textContent, 'Reapply');
});

test('Ctrl/Cmd+click opens a reverted rename at its old path and never a reverted added file', async (t) => {
  const view = await mountCard(t, {
    reply: () =>
      ready([
        file('src/new-name.ts', { status: 'R', oldPath: 'src/old-name.ts', state: 'reverted' }),
        file('src/added.ts', { status: 'A', state: 'reverted' }),
        file('src/renamed.ts', { status: 'R', oldPath: 'src/before.ts' }),
        file('src/created.ts', { status: 'A' }),
      ]),
    surface: { onOpenSessionDiff: undefined },
  });
  await view.click(view.q('.turn-changes-more'));
  const mains = view.qa('.turn-changes-file-main');
  for (const main of mains) await view.click(main, { ctrlKey: true });
  assert.deepEqual(view.opened, [
    [ROOT, 'src/old-name.ts'],
    [ROOT, 'src/renamed.ts'],
    [ROOT, 'src/created.ts'],
  ]);
  // Without a side dock a plain click opens the file, under the same rule.
  await view.click(mains[1]);
  assert.equal(view.opened.length, 3);
});

test('per-file revert confirms first; a reverted row is struck and offers reapply', async (t) => {
  const view = await mountCard(t, {
    reply: (request) => {
      if (request.capability === 'revertTurnChanges') {
        return ready(
          [
            file('a.ts'),
            file('src/b.ts', { state: 'reverted' }),
            file('c.ts', { revertable: false, reason: 'Edited after the turn' }),
          ],
          {
            revision: 8,
          }
        );
      }
      if (request.capability === 'reapplyTurnChanges') {
        return ready(
          [file('a.ts'), file('src/b.ts'), file('c.ts', { revertable: false, reason: 'Edited after the turn' })],
          {
            revision: 9,
          }
        );
      }
      return ready([
        file('a.ts'),
        file('src/b.ts'),
        file('c.ts', { revertable: false, reason: 'Edited after the turn' }),
      ]);
    },
  });
  const blocked = view.q('[aria-label="Revert c.ts"]');
  assert.equal(blocked.disabled, true);
  assert.equal(blocked.dataset.tooltip, 'Edited after the turn');
  await view.click(view.q('[aria-label="Revert src/b.ts"]'));
  assert.ok(view.q('.turn-review-confirm'));
  assert.equal(view.calls.filter((call) => call.capability === 'revertTurnChanges').length, 0);
  await view.click(view.q('[aria-label="Confirm revert of src/b.ts"]'));
  await settle();
  const revert = view.calls.find((call) => call.capability === 'revertTurnChanges');
  assert.deepEqual(revert.args, ['cp', 'src/b.ts', 7]);
  const row = view.qa('.turn-changes-file')[1];
  assert.equal(row.dataset.reverted, 'true');
  assert.deepEqual(
    view.toasts.map((toast) => toast.text),
    ['Reverted src/b.ts']
  );
  // Reapply confirms first too, and cancelling leaves the file reverted.
  await view.click(view.q('[aria-label="Reapply src/b.ts"]'));
  assert.ok(view.q('[aria-label="Confirm reapplying src/b.ts from this turn"]'));
  await view.click(view.q('[aria-label="Cancel reapply"]'));
  assert.equal(view.q('.turn-review-confirm'), null);
  assert.equal(view.calls.filter((call) => call.capability === 'reapplyTurnChanges').length, 0);
  await view.click(view.q('[aria-label="Reapply src/b.ts"]'));
  assert.equal(view.calls.filter((call) => call.capability === 'reapplyTurnChanges').length, 0);
  await view.click(view.q('[aria-label="Confirm reapply of src/b.ts"]'));
  await settle();
  const reapply = view.calls.find((call) => call.capability === 'reapplyTurnChanges');
  assert.deepEqual(reapply.args, ['cp', 'src/b.ts', 8]);
  assert.equal(view.qa('.turn-changes-file')[1].dataset.reverted, 'false');
});

test('a single reverted file is struck in its row and reapplied from the header as a whole turn', async (t) => {
  const view = await mountCard(t, {
    reply: (request) =>
      request.capability === 'reapplyTurnChanges'
        ? ready([file('a.ts')], { revision: 8 })
        : ready([file('a.ts', { state: 'reverted' })], { canUndo: false, canReapply: true }),
  });
  assert.equal(view.q('.turn-changes-file').dataset.reverted, 'true');
  assert.ok(view.q('[aria-label="Reapply a.ts"]'), 'the row keeps its faint per-file reapply');
  const action = view.q('.turn-changes-trail .turn-changes-action');
  assert.equal(action.textContent, 'Reapply');
  await view.click(action);
  await settle();
  assert.deepEqual(view.calls.find((call) => call.capability === 'reapplyTurnChanges').args, ['cp', null, 7]);
  assert.equal(view.q('.turn-changes-action').textContent, 'Undo');
});

test('a single-file card follows the whole-turn disabled and reason rules', async (t) => {
  await t.test('runtime reason', async (t) => {
    const blocked = await mountCard(t, {
      reply: () => ready([file('a.ts')], { canUndo: false, canReapply: false, reason: 'Files changed since' }),
    });
    assert.equal(blocked.q('.turn-changes-action').disabled, true);
    assert.equal(blocked.q('.turn-changes-action').dataset.tooltip, 'Files changed since');
  });
  await t.test('busy session', async (t) => {
    const busy = await mountCard(t, { reply: () => ready([file('a.ts')]), surface: { busy: true } });
    assert.equal(busy.q('.turn-changes-action').disabled, true);
    assert.equal(busy.q('.turn-changes-action').dataset.tooltip, 'Unavailable while the session is busy');
  });
});

test('hovering a row shows no diff popover and never fetches a patch', async (t) => {
  const view = await mountCard(t, { reply: () => ready([file('a.ts'), file('b.ts')]) });
  await act(async () => {
    view.q('.turn-changes-file-main').dispatchEvent(new view.dom.window.MouseEvent('mouseover', { bubbles: true }));
  });
  await settle(300);
  assert.equal(view.document.body.querySelector('[role="tooltip"]'), null);
  assert.equal(view.calls.filter((call) => call.args[0]?.patch).length, 0);
});
test('a newer turndone for the checkpoint refetches', async (t) => {
  let files = [file('a.ts'), file('b.ts')];
  const view = await mountCard(t, { reply: () => ready(files) });
  assert.equal(view.calls.length, 1);
  files = [file('a.ts'), file('b.ts'), file('c.ts')];
  await view.render(view.value, { ...view.ref, boundary: 'done-2' });
  await settle();
  assert.equal(view.calls.length, 2);
  assert.equal(view.q('.turn-changes-title strong').textContent, '3 files changed');
  // The same boundary answers from the cache.
  await view.render(view.value, { ...view.ref, boundary: 'done-2' });
  await settle();
  assert.equal(view.calls.length, 2);
});

test('per-file confirm moves focus in, and returns it to the row action or the header', async (t) => {
  const view = await mountCard(t, {
    reply: (request) =>
      request.capability === 'revertTurnChanges'
        ? ready([file('a.ts'), file('src/b.ts', { state: 'reverted' })], { revision: 8 })
        : ready([file('a.ts'), file('src/b.ts')]),
  });
  const active = () => view.document.activeElement;
  const trigger = () => view.q('[aria-label="Revert src/b.ts"]');
  trigger().focus();
  await view.click(trigger());
  assert.equal(active(), view.q('[aria-label="Cancel revert"]'), 'focus enters the confirm pair');
  // Cancel returns focus to the row's action.
  await view.click(view.q('[aria-label="Cancel revert"]'));
  assert.equal(active(), trigger());
  // Confirm: once the mutation settles, the row's action (now Reapply) has focus.
  await view.click(trigger());
  await view.click(view.q('[aria-label="Confirm revert of src/b.ts"]'));
  await settle();
  assert.equal(active(), view.q('[aria-label="Reapply src/b.ts"]'));
});

test('focus lands on the header button when the confirmed row disappears', async (t) => {
  const view = await mountCard(t, {
    reply: (request) =>
      request.capability === 'revertTurnChanges'
        ? ready([file('a.ts'), file('c.ts')], { revision: 8 })
        : ready([file('a.ts'), file('src/b.ts'), file('c.ts')]),
  });
  await view.click(view.q('[aria-label="Revert src/b.ts"]'));
  await view.click(view.q('[aria-label="Confirm revert of src/b.ts"]'));
  await settle();
  assert.equal(view.qa('.turn-changes-file').length, 2);
  assert.equal(view.document.activeElement, view.q('.turn-changes-summary'));
});

test('an unmeasured file takes the transcript edit counts, so the card agrees with the pane and island', async () => {
  const { withTranscriptCounts } = await import('./turn-changes-model.ts');
  const outside = 'C:/Users/me/Temp/outside/outside-note.txt';
  const files = [
    file(outside, { status: 'A', additions: 0, deletions: 0, unmeasured: true }),
    file('note.txt', { additions: 3 }),
  ];
  const items = [
    {
      id: 'w',
      kind: 'tool',
      name: 'write',
      args: { file_path: outside, content: 'Single line of text' },
      result: 'Created',
    },
  ];
  const filled = withTranscriptCounts(files, items, ROOT);
  assert.deepEqual(
    filled.map((entry) => [entry.additions, entry.deletions]),
    [
      [1, 0],
      [3, 1],
    ]
  );
  assert.equal(withTranscriptCounts(files, undefined, ROOT), files);
});
