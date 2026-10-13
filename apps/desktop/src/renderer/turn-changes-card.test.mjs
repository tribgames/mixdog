import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { TurnChangesCard, TurnChangesContext } from './TurnChangesCard.tsx';
import { resetTurnChangesCache } from './turn-changes-model.ts';
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
async function mountCard(t, { reply, surface = {}, turnChanges = {} }) {
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
          h(TurnChangesCard, { turnChanges: nextRef }),
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

test('one file: basename title, no file list, the labeled whole-turn Undo in the header', async (t) => {
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
  assert.equal(view.q('.turn-changes-title strong').textContent, 'Edited TurnReview.tsx');
  assert.match(view.q('.turn-changes-sub-default').textContent, /\+2.*\u22122/);
  assert.match(view.q('.turn-changes-sub-hover').textContent, /View changes/);
  assert.equal(view.q('.turn-changes-files'), null);
  assert.equal(view.q('.turn-changes-trail .turn-changes-action').textContent, 'Undo');
  assert.equal(view.q('.turn-review-revert'), null, 'no separate per-file icon');
  // Whole-turn Undo, without a confirm step.
  await view.click(view.q('.turn-changes-action'));
  await settle();
  assert.deepEqual(view.calls.find((call) => call.capability === 'revertTurnChanges').args, ['cp', null, 7]);
  assert.equal(view.q('.turn-changes-action').textContent, 'Reapply');
  assert.equal(view.q('.turn-review-confirm'), null);
  // Header click opens the session diff on that file; Ctrl+click opens the file.
  await view.click(view.q('.turn-changes-summary'));
  assert.equal(view.diffOpened.length, 1);
  assert.equal(view.requests.at(-1), 'src/deep/TurnReview.tsx');
  await view.click(view.q('.turn-changes-summary'), { ctrlKey: true });
  assert.deepEqual(view.opened, [[ROOT, 'src/deep/TurnReview.tsx']]);
  assert.equal(view.diffOpened.length, 1);
});

test('three files list every row with dimmed directory and bold basename', async (t) => {
  const view = await mountCard(t, {
    reply: () => ready([file('apps/x/A.tsx'), file('apps/x/B.tsx'), file('C.md', { additions: 41, deletions: 0 })]),
  });
  assert.equal(view.q('.turn-changes-title strong').textContent, 'Edited 3 files');
  assert.match(view.q('.turn-changes-sub-default').textContent, /\+47.*\u22122/);
  const rows = view.qa('.turn-changes-file');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].querySelector('.turn-changes-dir').textContent, 'apps/x/');
  assert.equal(rows[0].querySelector('.turn-changes-base').textContent, 'A.tsx');
  assert.equal(rows[2].querySelector('.turn-changes-dir'), null);
  assert.equal(view.q('.turn-changes-more'), null);
  assert.ok(view.q('.turn-changes-action'));
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
  assert.equal(view.requests.at(-1), null);
  assert.equal(view.diffOpened.length, 2);
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

test('a single reverted file is struck in the header and reapplied there as a whole turn', async (t) => {
  const view = await mountCard(t, {
    reply: (request) =>
      request.capability === 'reapplyTurnChanges'
        ? ready([file('a.ts')], { revision: 8 })
        : ready([file('a.ts', { state: 'reverted' })], { canUndo: false, canReapply: true }),
  });
  assert.equal(view.q('.turn-changes-card').dataset.reverted, 'true');
  assert.equal(view.q('[aria-label="Reapply a.ts"]'), null);
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

test('previews without a renderable patch name their reason', async (t) => {
  const cases = [
    // Line counts never decide: only the runtime's flag or the patch itself.
    ['large.ts', '', { additions: 0, deletions: 0, patchOmitted: true }, /Too large to preview/],
    ['huge.ts', `diff --git a/huge.ts b/huge.ts\n${'+x\n'.repeat(100000)}`, {}, /Too large to preview/],
    ['counted.ts', '', { additions: 900, deletions: 40 }, /No preview available/],
    ['mode.sh', '', { additions: 0, deletions: 0 }, /No preview available/],
  ];
  for (const [name, patch, counts, expected] of cases) {
    await t.test(name, async (t) => {
      const view = await mountCard(t, {
        reply: (request) =>
          request.args[0]?.patch
            ? { ...ready([file(name, counts)]), patch }
            : ready([file(name, counts), file('other.ts')]),
      });
      await act(async () => {
        view.q('.turn-changes-file-main').dispatchEvent(new view.dom.window.MouseEvent('mouseover', { bubbles: true }));
      });
      await settle(300);
      const tip = view.document.body.querySelector('.turn-changes-preview').textContent;
      assert.match(tip, expected);
      assert.doesNotMatch(tip, /Binary file/);
    });
  }
});

test('hovering a row previews its diff; binary files show no preview', async (t) => {
  const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
  const view = await mountCard(t, {
    reply: (request) =>
      request.args[0]?.patch
        ? { ...ready([file('a.ts')]), patch }
        : ready([file('a.ts'), file('lock.bin', { binary: true })]),
  });
  const hover = (node) =>
    act(async () => {
      node.dispatchEvent(new view.dom.window.MouseEvent('mouseover', { bubbles: true }));
    });
  const [first, binary] = view.qa('.turn-changes-file-main');
  assert.match(binary.textContent, /Binary file — no preview/);
  await hover(first);
  await settle(300);
  const tip = view.document.body.querySelector('.turn-changes-preview');
  assert.ok(tip);
  assert.equal(tip.getAttribute('role'), 'tooltip');
  const previewCall = view.calls.find((call) => call.args[0]?.patch);
  assert.deepEqual(previewCall.args, [{ checkpointId: 'cp', patch: true, file: 'a.ts' }]);
  assert.equal(first.getAttribute('aria-describedby'), tip.id);
  await act(async () => {
    first.dispatchEvent(new view.dom.window.MouseEvent('mouseout', { bubbles: true }));
  });
  assert.equal(view.document.body.querySelector('.turn-changes-preview'), null);
  const callsBefore = view.calls.length;
  await hover(binary);
  await settle(300);
  assert.match(view.document.body.querySelector('.turn-changes-preview').textContent, /Binary file — no preview/);
  assert.equal(view.calls.length, callsBefore);
});

test('a newer turndone for the checkpoint refetches', async (t) => {
  let files = [file('a.ts'), file('b.ts')];
  const view = await mountCard(t, { reply: () => ready(files) });
  assert.equal(view.calls.length, 1);
  files = [file('a.ts'), file('b.ts'), file('c.ts')];
  await view.render(view.value, { ...view.ref, boundary: 'done-2' });
  await settle();
  assert.equal(view.calls.length, 2);
  assert.equal(view.q('.turn-changes-title strong').textContent, 'Edited 3 files');
  // The same boundary answers from the cache.
  await view.render(view.value, { ...view.ref, boundary: 'done-2' });
  await settle();
  assert.equal(view.calls.length, 2);
});
