import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { TurnReviewBar } from './TurnReview';
import { rememberAgentReviews } from './turn-review-cache';
import { installReviewDom } from './turn-review-test-support.mjs';
import { formatAggregateDetail, summarizeToolResult } from '../../../../src/runtime/shared/tool-surface.mjs';

test('island segment accumulates across turns and survives a new turn with an empty session diff', async (t) => {
  // A non-Git folder's runtime session diff only tracks the running turn: it
  // answers authoritative-and-empty when turn 2 starts.
  const empty = { supported: true, files: [], patch: '', snapshotKind: 'session', authoritative: true };
  const { dom, root } = installReviewDom(t, {
    desktop: {
      invokeCapability: async ({ capability }) => ({
        value: capability === 'getSessionReviewDiff' ? empty : { supported: true, files: [], patch: '', agents: [] },
      }),
    },
  });
  const diff = (file) =>
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,2 @@\n a\n+b\n`;
  const edit = (id, file) => ({ kind: 'tool', id, name: 'edit', args: { file_path: file }, result: 'ok', uiDiff: diff(file) });
  const turn1 = [{ kind: 'user', id: 'u1', text: 'create' }, edit('e1', 'mx-island-check.txt'), { kind: 'turndone', id: 'd1' }];
  const turn2 = [...turn1, { kind: 'user', id: 'u2', text: 'append' }];
  // The island's Changes read the session's lane, like the Changes pane.
  const { defaultSessionLaneStore } = await import('./session-lane-store.ts');
  t.after(() => defaultSessionLaneStore.clear());
  let revision = 0;
  const render = async (items, busy) =>
    act(async () => {
      revision += 1;
      defaultSessionLaneStore.apply({
        sessionId: 'island-session',
        frameSource: 'live',
        snapshot: { sessionId: 'island-session', contentRevision: revision, busy, items },
      });
      root.render(
        React.createElement(TurnReviewBar, {
          variant: 'segment',
          items,
          sessionId: 'island-session',
          active: true,
          busy,
          cwd: 'C:\\demo\\cart-service',
        })
      );
    });
  const segment = () => dom.window.document.querySelector('.turn-review-segment');
  await render(turn1, false);
  assert.equal(segment()?.getAttribute('title'), 'Files 1');
  await render(turn2, true);
  assert.equal(segment()?.getAttribute('title'), 'Files 1', 'the segment stays while the new turn has changed nothing');
  await render([...turn2, edit('e2', 'README.md')], true);
  assert.equal(segment()?.getAttribute('title'), 'Files 2');
  assert.equal(segment()?.querySelector('.diff-stats i')?.textContent, '+2');
  await render([...turn2, edit('e2', 'README.md'), { kind: 'turndone', id: 'd2' }], false);
  assert.equal(segment()?.getAttribute('title'), 'Files 2');
  assert.equal(segment()?.querySelector('.diff-stats i')?.textContent, '+2');
});

test('turn review headlines exclude filename dates for individual and aggregated edits', async (t) => {
  const { dom, root } = installReviewDom(t);
  // The turn keeps its prompt row: rows without one are a cut-off tail, whose
  // headline shows the review's own totals instead of the edit workload.
  const prompt = { kind: 'user', id: 'line-stats-prompt', text: 'write the report' };
  rememberAgentReviews(
    'line-stats-test:line-stats-prompt',
    [],
    '',
    [{ path: 'report-20260920.md', status: 'A', additions: 292, deletions: 0 }],
    'worktree',
    ''
  );
  const created = {
    kind: 'tool',
    id: 'create-report',
    name: 'apply_patch',
    args: {},
    result: 'OK Add report-20260920.md — +292',
  };
  const modified = {
    kind: 'tool',
    id: 'modify-report',
    name: 'apply_patch',
    args: {},
    result: 'OK Modify report-20260920.md — +1/-2',
  };
  const render = async (items) =>
    act(async () => {
      root.render(
        React.createElement(TurnReviewBar, {
          items,
          sessionId: 'line-stats-test',
          active: false,
          cwd: 'C:\\Project\\owner',
        })
      );
    });
  const document = dom.window.document;
  await render([prompt, created]);
  assert.equal(document.querySelector('.turn-review-summary .diff-stats i')?.textContent, '+292');
  assert.equal(document.querySelector('.turn-review-summary .diff-stats em'), null);

  await render([prompt, created, modified]);
  assert.equal(document.querySelector('.turn-review-summary .diff-stats i')?.textContent, '+293');
  assert.equal(document.querySelector('.turn-review-summary .diff-stats em')?.textContent, '-2');

  await render([
    prompt,
    {
      ...created,
      aggregate: true,
      count: 2,
      categories: { Patch: { count: 2 } },
      result: formatAggregateDetail(
        [created, modified].map((item) => summarizeToolResult(item.name, item.args, item.result))
      ),
    },
  ]);
  assert.equal(document.querySelector('.turn-review-summary .diff-stats i')?.textContent, '+293');
  assert.equal(document.querySelector('.turn-review-summary .diff-stats em')?.textContent, '-2');
});
