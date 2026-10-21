import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blend,
  contrastRatio,
  fitAccent,
  inkOn,
  minPlateAlpha,
  plateAmounts,
  plateTones,
  resolvePalette,
} from './skin-color';
import { SKIN_MANIFEST } from './skin-manifest';

const PLATES = ['light', 'dark', 'tint'];
const THEMES = ['light', 'dark'];

test('contrast ratio matches the WCAG reference values', () => {
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
  assert.equal(contrastRatio('#777777', '#777777'), 1);
  assert.ok(Math.abs(contrastRatio('#767676', '#ffffff') - 4.54) < 0.01);
});

test('inkOn picks the more readable ink', () => {
  assert.equal(inkOn('#ffffff'), '#1a1a1a');
  assert.equal(inkOn('#101010'), '#ffffff');
});

test('fitAccent leaves a good accent alone and fixes a weak one', () => {
  assert.equal(fitAccent('#1b3a8a', '#fafafa'), '#1b3a8a');
  // Mid orange on cream: ~2.6:1 against the plate, and neither ink reaches 4.5.
  const fitted = fitAccent('#df7d3a', '#fbf7ee');
  assert.notEqual(fitted, '#df7d3a');
  assert.ok(contrastRatio(fitted, '#fbf7ee') >= 3);
  assert.ok(contrastRatio(fitted, inkOn(fitted)) >= 4.5);
});

test('minPlateAlpha keeps ink readable over the worst picture pixel', () => {
  assert.equal(minPlateAlpha('#ffffff', '#000000') <= 0.55, true);
  const alpha = minPlateAlpha('#f4f0e8', '#1a1a1a');
  assert.ok(contrastRatio(blend('#f4f0e8', '#000000', alpha), '#1a1a1a') >= 4.5);
  assert.equal(minPlateAlpha('#808080', '#8a8a8a'), 1);
});

test('every built-in skin passes the guard on every plate, theme and transparency', () => {
  for (const skin of SKIN_MANIFEST) {
    for (const plate of PLATES) {
      for (const theme of THEMES) {
        for (const transparency of [0, 25, 50, 75, 100]) {
          const p = resolvePalette({
            accent: skin.accent,
            cast: skin.cast,
            plate,
            theme,
            outerTransparency: transparency,
            mainTransparency: transparency,
            picture: skin.picture,
          });
          const label = `${skin.id}/${plate}/${theme}/${transparency}`;
          assert.ok(contrastRatio(p.accent, p.onAccent) >= 4.5, `${label} accent text`);
          assert.ok(contrastRatio(p.accent, p.tint) >= 3, `${label} accent on plate`);
          const worst = luminanceOf(p.tint) > luminanceOf(p.ink) ? '#000000' : '#ffffff';
          const card = blend(p.tint, worst, p.cardAmount);
          assert.ok(contrastRatio(card, p.ink) >= 4.5, `${label} body ink over worst picture`);
          assert.ok(contrastRatio(card, p.muted) >= 4.5, `${label} muted ink`);
          assert.ok(p.cardAmount >= plateAmounts(transparency).card, `${label} never thinner than the mapped amount`);
        }
      }
    }
  }
});

test('plate tones: light glass is light, dark glass is dark, tint follows the theme', () => {
  const cast = { hue: 25, sat: 72 };
  assert.ok(contrastRatio(plateTones('light', 'dark', cast).tint, '#ffffff') < 1.2);
  assert.ok(contrastRatio(plateTones('dark', 'light', cast).tint, '#000000') < 1.4);
  assert.notEqual(plateTones('tint', 'light', cast).tint, plateTones('tint', 'dark', cast).tint);
});

function luminanceOf(hex) {
  return contrastRatio(hex, '#000000');
}
