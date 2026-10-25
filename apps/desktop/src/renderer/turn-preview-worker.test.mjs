// End to end: a mockup a sub-agent wrote after its launching turn ended
// becomes a preview tile on the card of the completion-wake turn that reports
// it. The card reads the real runtime change record (non-Git root, no model).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { TurnChangesContext } from './TurnChangesCard.tsx';
import { PreviewedTurnChangesCard, ToolVisualizeCards } from './transcript-visualize-card.tsx';
import { resetTurnChangesCache } from './turn-changes-model.ts';
import { resetTurnPreviews } from './turn-preview-model.ts';
import { resyncVisualizeStates } from './visualize-store.ts';
import {
  _resetTurnSnapshotForTest,
  beginAgentTurnReview,
  beginTurnSnapshot,
  completeAgentTurnReview,
  completeTurnSnapshot,
  getTurnChanges,
  recordTurnDiffChanges,
} from '../../../../src/runtime/shared/turn-snapshot.mjs';

const h = React.createElement;
const LEAD = 'desk-lead';
const MOCKUP = 'design/mockups/x/index.html';
// Windows briefly keeps the root busy while a worktree probe still runs in it.
const removeRoot = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });

/** T1 launches a worker and ends; the worker writes the mockup and a source
 *  file; its completion is drained as the wake turn `wake-1`. */
async function workerAfterTurnEnded() {
  _resetTurnSnapshotForTest();
  const root = mkdtempSync(join(tmpdir(), 'mixdog-preview-worker-'));
  const t1 = await beginTurnSnapshot(root, LEAD, { checkpointId: 'cp-1' });
  const worker = beginAgentTurnReview(LEAD, `${LEAD}-worker`, { agent: 'worker' });
  await completeTurnSnapshot(LEAD, t1);
  for (const [path, after] of [
    [MOCKUP, '<html>x</html>\n'],
    ['src/app.ts', 'export {};\n'],
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), after);
    recordTurnDiffChanges(`${LEAD}-worker`, [{ path: join(root, path), displayPath: path, before: null, after }]);
  }
  completeAgentTurnReview(worker);
  const wake = await beginTurnSnapshot(root, LEAD, { checkpointId: 'wake-1' });
  await completeTurnSnapshot(LEAD, wake);
  return root;
}

async function mountWakeCard(t, replyText) {
  resetTurnChangesCache();
  resetTurnPreviews();
  const { dom, document, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent'],
    rootId: 'root',
  });
  dom.window.mixdogDesktop = {
    invokeCapability: async ({ capability, args }) => {
      assert.equal(capability, 'getTurnChanges');
      return { value: await getTurnChanges(LEAD, args[0]) };
    },
    visualizeCommand: async () => {},
  };
  t.after(() => resyncVisualizeStates([]));
  const turnChanges = { checkpointId: 'wake-1', boundary: 'd-wake', trailing: false };
  await act(async () => {
    root.render(
      h(
        TurnChangesContext.Provider,
        { value: { sessionId: 's1', busy: false, turnRunning: false, onOpenSessionDiff() {}, onOpenFile() {} } },
        h(ToolVisualizeCards, { items: [], sessionId: 's1', turnChanges, replyText, endTurnKey: 'turn:wake' }),
        h(PreviewedTurnChangesCard, { turnChanges, visualized: [] })
      )
    );
  });
  // The real record loads from disk: wait until the cards have rendered it.
  for (let attempt = 0; attempt < 100 && !document.querySelector('.turn-changes-card'); attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  return {
    tiles: [...document.querySelectorAll('.transcript-visualize-tile')].map(
      (tile) => tile.querySelector('b').textContent
    ),
    changedFiles: document.querySelector('.turn-changes-card')?.dataset.fileCount,
  };
}

test('a completion-wake report linking the worker’s mockup shows it as a tile, not a changes row', async (t) => {
  const root = await workerAfterTurnEnded();
  t.after(() => removeRoot(root));
  const view = await mountWakeCard(t, `The worker built the mockup: [mockup](${MOCKUP}).`);
  // An index page's tile is named by its folder (design/mockups/x/index.html → "x").
  assert.deepEqual(view.tiles, ['x']);
  assert.equal(view.changedFiles, '1', 'the changes card keeps only src/app.ts');
});

test('c: a report that never names the mockup (never surfaced before) gets no tile', async (t) => {
  const root = await workerAfterTurnEnded();
  t.after(() => removeRoot(root));
  const view = await mountWakeCard(t, 'The worker finished.');
  assert.deepEqual(view.tiles, []);
  assert.equal(view.changedFiles, '2');
});
