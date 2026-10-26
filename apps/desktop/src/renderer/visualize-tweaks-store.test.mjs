import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './test-support/test-dom.mjs';
import {
  consumeVisualizeFeedback,
  resetVisualizeFeedback,
  setVisualizeTweakSet,
  visualizeFeedbackFor,
  visualizeFeedbackPending,
  visualizeFeedbackPrompt,
  visualizeTweaksChip,
} from './visualize-feedback-store.ts';
import {
  resetVisualizeTweakStore,
  resetVisualizeTweaks,
  setVisualizeTweakDefs,
  setVisualizeTweakValue,
  visualizePaneTweaks,
  visualizeTabHasTweaks,
  visualizeTweakValues,
  visualizeTweakVersion,
} from './visualize-tweaks-store.ts';
import { tweakChanges } from '../shared/visualize-tweaks.ts';

installTestDom(null, {
  html: '<html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['sessionStorage'],
});

const block = JSON.stringify([
  { id: 'accent', label: 'Accent', type: 'color', var: '--accent', default: '#3b82f6' },
  { id: 'size', type: 'range', var: '--size', min: 10, max: 20, step: 2, unit: 'px', default: 14 },
]);
const tab = {
  id: 'v1',
  label: 'Mockup',
  panes: [{ kind: 'html' }, { kind: 'html', version: 2 }],
  versions: [{ n: 1 }, { n: 3 }],
};

test('a page report sets or clears the pane controls; a malformed block yields its reason', () => {
  resetVisualizeTweakStore();
  assert.equal(visualizeTabHasTweaks('s1', tab), false);
  const ok = setVisualizeTweakDefs('s1', 'v1', 0, block);
  assert.equal(ok.tweaks.length, 2);
  assert.equal(visualizePaneTweaks('s1', 'v1', 0).length, 2);
  assert.equal(visualizeTabHasTweaks('s1', tab), true);
  assert.equal(visualizeTabHasTweaks('s2', tab), false, 'per session');
  assert.match(setVisualizeTweakDefs('s1', 'v1', 1, '{').error, /not valid JSON/);
  assert.deepEqual(visualizePaneTweaks('s1', 'v1', 1), [], 'a malformed block offers no controls');
  assert.equal(setVisualizeTweakDefs('s1', 'v1', 0, null), null);
  assert.equal(visualizeTabHasTweaks('s1', tab), false, 'a reloaded page without the block drops them');
});

test('values are kept per tab, pane and version, sanitized, and reset one or all', () => {
  resetVisualizeTweakStore();
  const [accent, size] = setVisualizeTweakDefs('s1', 'v1', 0, block).tweaks;
  assert.equal(visualizeTweakVersion(tab, tab.panes[0]), 3, 'live = the newest version');
  assert.equal(visualizeTweakVersion(tab, tab.panes[1]), 2, 'a kept version is its own');
  assert.equal(setVisualizeTweakValue('s1', 'v1', 0, 3, accent, '#FF0000'), true);
  assert.equal(setVisualizeTweakValue('s1', 'v1', 0, 3, accent, 'url(x)'), false);
  assert.equal(setVisualizeTweakValue('s1', 'v1', 0, 3, size, 99), true);
  assert.deepEqual(visualizeTweakValues('s1', 'v1', 0, 3), { accent: '#ff0000', size: '20' });
  assert.deepEqual(visualizeTweakValues('s1', 'v1', 0, 4), {}, 'a new version starts from the defaults');
  assert.deepEqual(visualizeTweakValues('s2', 'v1', 0, 3), {}, 'per session');
  // Setting a control back to its default stores no override.
  setVisualizeTweakValue('s1', 'v1', 0, 3, size, 14);
  assert.deepEqual(visualizeTweakValues('s1', 'v1', 0, 3), { accent: '#ff0000' });
  setVisualizeTweakValue('s1', 'v1', 0, 3, size, 18);
  resetVisualizeTweaks('s1', 'v1', 0, 3, 'accent');
  assert.deepEqual(visualizeTweakValues('s1', 'v1', 0, 3), { size: '18' });
  resetVisualizeTweaks('s1', 'v1', 0, 3);
  assert.deepEqual(visualizeTweakValues('s1', 'v1', 0, 3), {});
});

test('"Use these values" queues one chip per pane that rides with the next message', () => {
  resetVisualizeFeedback();
  const { tweaks } = setVisualizeTweakDefs('s1', 'v1', 0, block);
  const changes = tweakChanges(tweaks, { accent: '#2f6fed', size: '18' });
  const set = { tabId: 'v1', tabLabel: 'Mockup', pane: 0, file: 'design/a.html', changes };
  setVisualizeTweakSet('s1', set);
  assert.equal(visualizeFeedbackPending(visualizeFeedbackFor('s1')), true);
  assert.equal(
    visualizeTweaksChip(visualizeFeedbackFor('s1').tweaks),
    '🎚 accent: #2f6fed (was #3b82f6), size: 18px (was 14px)'
  );
  // A new set for the same pane replaces it; no changes drops it.
  setVisualizeTweakSet('s1', { ...set, changes: [changes[0]] });
  assert.equal(visualizeFeedbackFor('s1').tweaks.length, 1);
  assert.equal(visualizeFeedbackFor('s1').tweaks[0].changes.length, 1);

  const sent = visualizeFeedbackFor('s1');
  const prompt = visualizeFeedbackPrompt(sent, 1);
  assert.match(prompt.text, /tweaks \(the user adjusted these/);
  assert.match(prompt.text, /tab: v1 "Mockup" · pane 1 · file: design\/a\.html/);
  assert.match(prompt.text, /accent \(--accent\): #2f6fed \(was #3b82f6\)/);
  assert.match(prompt.display, /accent: #2f6fed \(was #3b82f6\)/);

  // Queued while the message travelled: stays for the next one.
  setVisualizeTweakSet('s1', { ...set, pane: 1 });
  consumeVisualizeFeedback('s1', sent);
  assert.deepEqual(
    visualizeFeedbackFor('s1').tweaks.map((entry) => entry.pane),
    [1]
  );
  setVisualizeTweakSet('s1', { ...set, pane: 1, changes: [] });
  assert.equal(visualizeFeedbackPending(visualizeFeedbackFor('s1')), false);
});
