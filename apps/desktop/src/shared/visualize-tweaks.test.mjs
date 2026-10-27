import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_VISUALIZE_TWEAKS,
  parseVisualizeTweaks,
  sanitizeTweakColor,
  sanitizeTweakValue,
  tweakAppliedValue,
  tweakChanges,
  tweakColorInputValue,
  tweakOps,
} from './visualize-tweaks.ts';

const block = (...controls) => JSON.stringify(controls);
const accent = { id: 'accent', label: 'Accent', type: 'color', var: '--accent', default: '#3B82F6' };
const size = { id: 'size', type: 'range', var: '--size', min: 10, max: 20, step: 2, unit: 'px', default: 14 };
const density = {
  id: 'density',
  type: 'select',
  attr: 'data-density',
  options: [{ value: 'cozy', label: 'Cozy' }, { value: 'compact' }],
  default: 'cozy',
};
const dark = { id: 'dark', label: 'Dark', type: 'toggle', var: '--dark' };

test('a valid block parses into normalized controls', () => {
  const { tweaks } = parseVisualizeTweaks(block(accent, size, density, dark));
  assert.deepEqual(
    tweaks.map((tweak) => [tweak.id, tweak.type, tweak.default]),
    [
      ['accent', 'color', '#3b82f6'],
      ['size', 'range', '14'],
      ['density', 'select', 'cozy'],
      ['dark', 'toggle', 'false'],
    ]
  );
  assert.equal(tweaks[1].unit, 'px');
  assert.equal(tweaks[2].options[1].label, 'compact');
  assert.equal(tweaks[1].label, 'size', 'the id stands in for a missing label');
});

test('a malformed block is refused with a reason the agent can act on', () => {
  const reason = (text) => parseVisualizeTweaks(text).error;
  assert.match(reason('{'), /not valid JSON/);
  assert.match(reason('{}'), /non-empty JSON array/);
  assert.match(reason('[]'), /non-empty JSON array/);
  assert.match(
    reason(block(...Array.from({ length: MAX_VISUALIZE_TWEAKS + 1 }, (_, i) => ({ ...accent, id: `a${i}` })))),
    /at most 16/
  );
  assert.match(reason(block(3)), /not an object/);
  assert.match(reason(block({ ...accent, id: 'bad id' })), /needs an id/);
  assert.match(reason(block({ ...accent, type: 'slider' })), /type must be/);
  assert.match(reason(block({ ...accent, attr: 'data-a' })), /exactly one of/);
  assert.match(reason(block({ id: 'x', type: 'color', default: '#fff' })), /exactly one of/);
  assert.match(reason(block({ ...accent, var: 'accent' })), /var must look like/);
  assert.match(reason(block({ ...accent, var: '--Accent' })), /var must look like/);
  assert.match(reason(block({ ...density, attr: 'onclick' })), /attr must look like/);
  assert.match(reason(block({ ...accent, default: 'url(x)' })), /no valid default/);
  assert.match(reason(block({ ...accent, default: undefined })), /no valid default/);
  assert.match(reason(block({ ...size, min: 5, max: 5 })), /min < max/);
  assert.match(reason(block({ ...size, step: 0 })), /positive/);
  assert.match(reason(block({ ...size, unit: 'px;x' })), /unit/);
  assert.match(reason(block({ ...density, options: [] })), /options/);
  assert.match(reason(block({ ...density, options: [{ value: 'a;b' }] })), /option values/);
  assert.match(reason(block({ ...density, default: 'airy' })), /no valid default/);
  assert.match(reason(block({ ...accent, label: 'x'.repeat(41) })), /label/);
  assert.match(reason(block(accent, accent)), /duplicate id "accent"/);
});

test('values are sanitized before they are applied', () => {
  const [color, range, select, toggle] = parseVisualizeTweaks(block(accent, size, density, dark)).tweaks;
  assert.equal(sanitizeTweakColor('#ABC'), '#abc');
  assert.equal(sanitizeTweakColor('rgb(1, 2, 3)'), 'rgb(1,2,3)');
  assert.equal(sanitizeTweakColor('rgba(1,2,3,.5)'), 'rgba(1,2,3,.5)');
  for (const bad of ['red', 'url(javascript:1)', 'rgb(256,0,0)', '#12', 'expression(1)', '#fff;x:y', 3, null]) {
    assert.equal(sanitizeTweakColor(bad), null, String(bad));
  }
  assert.equal(sanitizeTweakValue(color, '#00FF00'), '#00ff00');
  assert.equal(sanitizeTweakValue(color, 'blue'), null);
  // Numbers clamp into the range and snap to the step.
  assert.equal(sanitizeTweakValue(range, 99), '20');
  assert.equal(sanitizeTweakValue(range, -5), '10');
  assert.equal(sanitizeTweakValue(range, '13'), '14');
  assert.equal(sanitizeTweakValue(range, 'abc'), null);
  assert.equal(sanitizeTweakValue(range, Number.POSITIVE_INFINITY), null);
  assert.equal(sanitizeTweakValue(select, 'compact'), 'compact');
  assert.equal(sanitizeTweakValue(select, 'x;y'), null);
  assert.equal(sanitizeTweakValue(toggle, true), 'true');
  assert.equal(sanitizeTweakValue(toggle, 'false'), 'false');
  assert.equal(sanitizeTweakValue(toggle, 'yes'), null);
  assert.equal(tweakColorInputValue('#abc'), '#aabbcc');
  assert.equal(tweakColorInputValue('rgb(255, 0, 16)'), '#ff0010');
  assert.equal(tweakColorInputValue('#11223344'), '#112233');
});

test('overrides apply as CSS values, and a default removes the override', () => {
  const { tweaks } = parseVisualizeTweaks(block(accent, size, density, dark));
  assert.deepEqual(tweakOps(tweaks, {}), [
    { var: '--accent', value: null },
    { var: '--size', value: null },
    { attr: 'data-density', value: null },
    { var: '--dark', value: null },
  ]);
  assert.deepEqual(tweakOps(tweaks, { accent: '#2f6fed', size: '18', density: 'compact', dark: 'true' }), [
    { var: '--accent', value: '#2f6fed' },
    { var: '--size', value: '18px' },
    { attr: 'data-density', value: 'compact' },
    { var: '--dark', value: '1' },
  ]);
  // An unacceptable stored value falls back to the default.
  assert.equal(tweakOps(tweaks, { accent: 'javascript:1' })[0].value, null);
  const attrToggle = parseVisualizeTweaks(block({ ...dark, var: undefined, attr: 'data-dark' })).tweaks[0];
  assert.equal(tweakAppliedValue(attrToggle, 'true'), 'true');
});

test('changed values list as chip lines with the value they replace', () => {
  const { tweaks } = parseVisualizeTweaks(block(accent, size, density));
  assert.deepEqual(tweakChanges(tweaks, {}), []);
  assert.deepEqual(tweakChanges(tweaks, { accent: '#2f6fed', size: '18', density: 'cozy' }), [
    { id: 'accent', target: '--accent', value: '#2f6fed', was: '#3b82f6' },
    { id: 'size', target: '--size', value: '18px', was: '14px' },
  ]);
});
