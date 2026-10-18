import assert from 'node:assert/strict';
import test from 'node:test';

import { visualizePaneChipLabel } from './VisualizePane.tsx';
import { setVisualizeSoloPane, visualizeSoloPane, visualizeSoloStep } from './visualize-solo-pane.ts';

test('one pane of a split tab shows alone, per tab, and steps around the panes', () => {
  assert.equal(visualizeSoloPane('s', 'v1', 3), null, 'a tab starts in the split');
  setVisualizeSoloPane('s', 'v1', 1);
  assert.equal(visualizeSoloPane('s', 'v1', 3), 1);
  assert.equal(visualizeSoloPane('s', 'v2', 3), null, 'another tab keeps its split');
  assert.equal(visualizeSoloPane('t', 'v1', 3), null, 'another session too');
  assert.equal(visualizeSoloPane('s', 'v1', 1), null, 'a single pane is never "alone"');
  assert.equal(visualizeSoloPane('s', 'v1', 1 + 0), null);
  setVisualizeSoloPane('s', 'v1', 2);
  assert.equal(visualizeSoloPane('s', 'v1', 2), null, 'a pane the tab no longer has falls back to the split');
  assert.equal(visualizeSoloStep(2, 3, 1), 0, '› wraps to the first');
  assert.equal(visualizeSoloStep(0, 3, -1), 2, '‹ wraps to the last');
  assert.equal(visualizeSoloStep(0, 2, 1), 1);
  setVisualizeSoloPane('s', 'v1', null);
  assert.equal(visualizeSoloPane('s', 'v1', 3), null, 'Esc / the split button returns to the split');
});

test('a split pane names its file, behind vN for a kept version', () => {
  assert.equal(visualizePaneChipLabel({ label: 'a.png' }), 'a.png');
  assert.equal(visualizePaneChipLabel({ label: 'a.png', version: 2 }), 'v2 · a.png');
});
