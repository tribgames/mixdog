import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginVisualizeCapture,
  consumeVisualizeChoiceGesture,
  createVisualizePickGate,
  endVisualizeCapture,
  MAX_VISUALIZE_CAPTURES_IN_FLIGHT,
  proposeVisualizeChoice,
  resetVisualizeChoiceProposals,
  takeVisualizeChoiceProposal,
  VISUALIZE_PICK_TTL_MS,
  VISUALIZE_PROPOSAL_MIN_INTERVAL_MS,
  visualizeChoiceProposal,
  visualizeFreshCrop,
  visualizeProposalKey,
  visualizeSameDescription,
  visualizeSameMeasure,
} from './visualize-feedback-gate.ts';

test('a pick answer is taken only for the open request, once, and in time', () => {
  let n = 0;
  const gate = createVisualizePickGate(() => `id${++n}`);
  assert.equal(gate.accept('id1', 0), false, 'unsolicited: no trusted click opened a request');
  const first = gate.request(100);
  assert.equal(gate.accept('forged', 150), false, 'a guessed id is refused');
  assert.equal(gate.accept(first, 150), true);
  assert.equal(gate.accept(first, 160), false, 'one answer per click');
  const late = gate.request(1_000);
  assert.equal(gate.accept(late, 1_000 + VISUALIZE_PICK_TTL_MS + 1), false, 'stale answers are refused');
  const replaced = gate.request(2_000);
  const latest = gate.request(2_010);
  assert.equal(gate.accept(replaced, 2_020), false, 'a newer click supersedes');
  assert.equal(gate.accept(latest, 2_020), true);
  const cancelled = gate.request(3_000);
  gate.cancel();
  assert.equal(gate.accept(cancelled, 3_001), false);
  assert.match(createVisualizePickGate().request(0), /^[0-9a-f]{32}$/, 'real ids are unguessable');
});

test('a choice spends a gesture main saw in that pane; without main it fails closed', async () => {
  const previous = globalThis.window;
  const calls = [];
  try {
    globalThis.window = { mixdogDesktop: {} };
    assert.equal(
      await consumeVisualizeChoiceGesture({ sessionId: 's1', tabId: 'v1', pane: 0 }),
      false,
      'remote client'
    );
    globalThis.window = {
      mixdogDesktop: {
        visualizeConsumeGesture: async (target) => {
          calls.push(target);
          return calls.length === 1;
        },
      },
    };
    assert.equal(await consumeVisualizeChoiceGesture({ sessionId: 's1', tabId: 'v1', pane: 2 }), true);
    assert.equal(await consumeVisualizeChoiceGesture({ sessionId: 's1', tabId: 'v1', pane: 2 }), false);
    assert.deepEqual(calls[0], { sessionId: 's1', tabId: 'v1', pane: 2 });
    globalThis.window = {
      mixdogDesktop: {
        visualizeConsumeGesture: async () => {
          throw new Error('ipc down');
        },
      },
    };
    assert.equal(await consumeVisualizeChoiceGesture({ sessionId: 's1', tabId: 'v1', pane: 0 }), false);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test('a crop uses only a fresh, complete answer for an element that stayed put', () => {
  const view = { x: 10, y: 20, width: 100, height: 40 };
  const pinned = { selector: 'form', view };
  const fresh = (overrides = {}) => ({
    selector: 'form',
    label: 'form',
    html: '',
    styles: {},
    box: view,
    view,
    masks: [{ x: 12, y: 22, width: 50, height: 10 }],
    masksOverflow: false,
    ...overrides,
  });
  assert.deepEqual(visualizeFreshCrop(pinned, fresh()), { view, masks: [{ x: 12, y: 22, width: 50, height: 10 }] });
  // The fresh masks replace the pick-time ones, including fields added since.
  const added = [
    { x: 12, y: 22, width: 50, height: 10 },
    { x: 12, y: 40, width: 50, height: 10 },
  ];
  assert.deepEqual(visualizeFreshCrop(pinned, fresh({ masks: added })).masks, added);
  assert.equal(visualizeFreshCrop(pinned, null), null, 'no fresh answer');
  assert.equal(visualizeFreshCrop(pinned, fresh({ masksOverflow: true, masks: [] })), null, 'too many secret fields');
  assert.equal(visualizeFreshCrop(pinned, fresh({ selector: 'main' })), null, 'another element');
  assert.equal(visualizeFreshCrop(pinned, fresh({ view: { ...view, y: 30 } })), null, 'moved');
  assert.equal(visualizeFreshCrop(pinned, fresh({ view: { ...view, width: 140 } })), null, 'resized');
  assert.ok(visualizeFreshCrop(pinned, fresh({ view: { ...view, x: 10.5 } })), 'sub-pixel jitter is fine');
});

test('choice proposals: one per pane, latest replaces, rate-limited, taken once', () => {
  resetVisualizeChoiceProposals();
  const key = visualizeProposalKey('s1', 'v1', 0);
  const other = visualizeProposalKey('s1', 'v1', 1);
  const resets = [];
  const proposal = (choice) => ({
    sessionId: 's1',
    choice: { tabId: 'v1', tabLabel: 'T', pane: 0, file: 'a.html', group: '', choice, label: choice },
    reset: () => resets.push(choice),
  });
  assert.equal(proposeVisualizeChoice(key, proposal('a'), 1_000), true);
  const first = visualizeChoiceProposal(key);
  assert.equal(proposeVisualizeChoice(key, proposal('b'), 1_000 + VISUALIZE_PROPOSAL_MIN_INTERVAL_MS - 1), false);
  assert.equal(visualizeChoiceProposal(key).choice.choice, 'a', 'a flood does not move the bar');
  assert.equal(proposeVisualizeChoice(other, proposal('x'), 1_001), true, 'each pane has its own bar');
  assert.equal(proposeVisualizeChoice(key, proposal('c'), 1_000 + VISUALIZE_PROPOSAL_MIN_INTERVAL_MS), true);
  const latest = visualizeChoiceProposal(key);
  assert.equal(latest.choice.choice, 'c');
  assert.equal(takeVisualizeChoiceProposal(key, first.id), null, 'a replaced proposal cannot be confirmed');
  assert.equal(takeVisualizeChoiceProposal(key, latest.id).choice.choice, 'c');
  assert.equal(takeVisualizeChoiceProposal(key, latest.id), null, 'taken once');
  assert.equal(visualizeChoiceProposal(key), null);
  assert.deepEqual(resets, []);
  resetVisualizeChoiceProposals();
});

test('after the shot the description must match exactly', () => {
  const view = { x: 10, y: 20, width: 100, height: 40 };
  const mask = { x: 12, y: 22, width: 50, height: 10 };
  const before = {
    selector: 'form',
    label: 'form',
    html: '',
    styles: {},
    box: view,
    view,
    masks: [mask],
    masksOverflow: false,
  };
  assert.equal(
    visualizeSameDescription(before, { ...before, masks: [{ ...mask }], label: 'changed label is fine' }),
    true
  );
  assert.equal(visualizeSameDescription(before, null), false);
  assert.equal(visualizeSameDescription(before, { ...before, masks: [] }), false, 'a mask vanished');
  assert.equal(visualizeSameDescription(before, { ...before, masks: [mask, mask] }), false, 'a mask appeared');
  assert.equal(visualizeSameDescription(before, { ...before, masks: [{ ...mask, height: 11 }] }), false);
  assert.equal(
    visualizeSameDescription(before, { ...before, view: { ...view, x: 10.01 } }),
    false,
    'no drift allowed after the shot'
  );
  assert.equal(visualizeSameDescription(before, { ...before, box: { ...view, y: 0 } }), false);
  assert.equal(visualizeSameDescription(before, { ...before, selector: 'div' }), false);
  assert.equal(visualizeSameDescription(before, { ...before, masksOverflow: true }), false);
});

test('a dragged HTML area keeps its crop only if the page measures it the same after the shot', () => {
  const mask = { x: 1, y: 2, width: 3, height: 4 };
  const before = { count: 2, masks: [mask], masksOverflow: false };
  assert.equal(visualizeSameMeasure(before, { count: 2, masks: [{ ...mask }], masksOverflow: false }), true);
  assert.equal(visualizeSameMeasure(before, null), false, 'no answer');
  assert.equal(visualizeSameMeasure(before, { ...before, count: 3 }), false, 'contents changed');
  assert.equal(visualizeSameMeasure(before, { ...before, masks: [] }), false, 'a mask vanished');
  assert.equal(visualizeSameMeasure(before, { ...before, masks: [{ ...mask, x: 2 }] }), false, 'a mask moved');
  assert.equal(visualizeSameMeasure(before, { ...before, masks: [], masksOverflow: true }), false);
  assert.equal(visualizeSameMeasure({ ...before, masksOverflow: true }, before), false);
});

test('window captures run one at a time', () => {
  const claimed = [];
  for (let i = 0; i < MAX_VISUALIZE_CAPTURES_IN_FLIGHT + 2; i += 1) claimed.push(beginVisualizeCapture());
  assert.deepEqual(
    claimed,
    claimed.map((_, i) => i < MAX_VISUALIZE_CAPTURES_IN_FLIGHT)
  );
  for (let i = 0; i < MAX_VISUALIZE_CAPTURES_IN_FLIGHT; i += 1) endVisualizeCapture();
  assert.equal(beginVisualizeCapture(), true);
  endVisualizeCapture();
});
