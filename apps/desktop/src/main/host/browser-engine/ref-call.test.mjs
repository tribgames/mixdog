import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserGuestStateStore } from '../../browser/host-state.ts';
import { engineLane } from './engine-lane.test-helper.mjs';

const page = () => ({ isDestroyed: () => false, getURL: () => 'https://a.example/' });

/** One `ref/call` on a fresh page whose function answers `answer` (or `run` decides). */
async function called(fields, run) {
  const state = new BrowserGuestStateStore();
  const guest = page();
  const lane = engineLane({ state, evaluate: async () => run(state, guest) });
  const result = await lane.refCall(guest, fields);
  return { result, record: state.for(guest) };
}

const answering = (value) => () => ({ ok: true, value });

test("a call the core marks as an edit is the agent's once it answers a change; a refusal or a no-op answer is not", async () => {
  for (const [value, edited] of [
    [{ value: 'Ada' }, true],
    [{ values: ['us'] }, true],
    [{ value: '', sensitive: true }, true],
    [{ error: 'element is readonly' }, false],
    [{ error: 'stale' }, false],
    [{ custom: true, unchanged: true }, false],
    [{ pending: true, unchanged: true }, false],
    [{ contentEditable: true, unchanged: true }, false],
  ]) {
    const { record } = await called({ edits: true }, answering(value));
    assert.equal(record.agentEdits, edited, JSON.stringify(value));
    assert.equal(record.userEdits, false, 'never the person’s');
  }
});

test('a read, a call that threw and an edit whose document was replaced meanwhile hold nothing', async () => {
  const read = await called({}, answering({ value: 'Ada' }));
  assert.equal(read.record.agentEdits, false, 'a call not marked as an edit');

  const threw = await called({ edits: true }, () => ({ ok: false, text: 'boom' }));
  assert.deepEqual(threw.result.exception, { text: 'boom' });
  assert.equal(threw.record.agentEdits, false);

  const replaced = await called({ edits: true }, (state, guest) => {
    state.beginDocument(guest);
    state.commitDocument(guest);
    return { ok: true, value: { value: 'Ada' } };
  });
  assert.equal(replaced.record.agentEdits, false, 'the edit went with the old document');
});

test('an edit on an accessibility ref counts once the function answers, not when the page throws', async () => {
  const run = async (response) => {
    const state = new BrowserGuestStateStore();
    const guest = page();
    state.for(guest).accessibilityRefs = { snapshotId: 's1', refs: new Map([['e1', { backendNodeId: 7 }]]) };
    const lane = engineLane({
      state,
      cdp: {
        call: async (_guest, method) =>
          method === 'DOM.resolveNode' ? { object: { objectId: 'o1' } } : method === 'Runtime.callFunctionOn' ? response : {},
      },
    });
    await lane.refCall(guest, { edits: true });
    return state.for(guest).agentEdits;
  };
  assert.equal(await run({ result: { value: { values: ['Blue'] } } }), true);
  assert.equal(await run({ exceptionDetails: { text: 'boom' } }), false);
});
