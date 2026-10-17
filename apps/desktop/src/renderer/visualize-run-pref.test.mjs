import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { remotePageGate } from '../shared/visualize-scripts.ts';
import {
  readVisualizeRunPages,
  setVisualizeRunPages,
  VISUALIZE_RUN_PAGES_STORAGE_KEY,
  visualizeRunPagesAction,
} from './visualize-run-pref.ts';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://relay.test/' });
globalThis.window = dom.window;
globalThis.DOMParser = dom.window.DOMParser;

test('"run agent pages immediately" is off by default and stored on this device only', () => {
  dom.window.localStorage.clear();
  assert.equal(readVisualizeRunPages(), false);
  const item = visualizeRunPagesAction();
  assert.deepEqual(
    [item.id, item.label, item.checkbox, item.checked],
    ['run-agent-pages', 'Run agent pages immediately', true, false]
  );
  item.onSelect();
  assert.equal(dom.window.localStorage.getItem(VISUALIZE_RUN_PAGES_STORAGE_KEY), 'true');
  assert.equal(readVisualizeRunPages(), true);
  assert.equal(visualizeRunPagesAction().checked, true);
  setVisualizeRunPages(false);
  assert.equal(dom.window.localStorage.getItem(VISUALIZE_RUN_PAGES_STORAGE_KEY), null);
  // Anything but the exact stored value reads as off.
  dom.window.localStorage.setItem(VISUALIZE_RUN_PAGES_STORAGE_KEY, 'yes');
  assert.equal(readVisualizeRunPages(), false);
});

test('with the setting on, a scripted page runs at once; off, the Run gate stays', () => {
  const html = '<p>x</p><script>go()</script>';
  // The pane passes `runTapped || setting` to the gate.
  const gated = remotePageGate(html, false || false);
  // (The pane draws a gated page in a frame with no `allow-scripts` at all.)
  assert.deepEqual([gated.runScripts, gated.prompt], [false, 'scripts']);
  const immediate = remotePageGate(html, false || true);
  assert.deepEqual([immediate.runScripts, immediate.prompt, immediate.srcdoc], [true, null, html]);
});
