import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';
import {
  blend,
  contrastRatio,
  DEFAULT_TRANSPARENCY,
  MARK_TARGETS,
  minPlateAlpha,
  plateAmounts,
  plateBackdrops,
  plateTones,
  resolvePalette,
} from './skin-color';
import { SKIN_MANIFEST } from './skin-manifest';

const LEGACY = {
  soft: { frame: 0.28, veil: 0.14, panel: 0.28, card: 0.76 },
  normal: { frame: 0.4, veil: 0.22, panel: 0.4, card: 0.85 },
  strong: { frame: 0.55, veil: 0.38, panel: 0.58, card: 0.93 },
};
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("today's soft / normal / strong land exactly on three slider positions; the default is 50", () => {
  assert.equal(DEFAULT_TRANSPARENCY, 50);
  for (const [name, position] of [
    ['strong', 25],
    ['normal', 50],
    ['soft', 75],
  ]) {
    for (const [plate, amount] of Object.entries(LEGACY[name])) close(plateAmounts(position)[plate], amount);
  }
});

test('the plate amounts are monotonic (more transparent = thinner), bounded, and interpolate between presets', () => {
  let previous = plateAmounts(0);
  for (let t = 1; t <= 100; t++) {
    const now = plateAmounts(t);
    for (const plate of Object.keys(now)) {
      assert.ok(now[plate] <= previous[plate] + 1e-12, `${plate} rises at ${t}`);
      assert.ok(now[plate] > 0 && now[plate] <= 1);
    }
    previous = now;
  }
  const between = plateAmounts(38);
  assert.ok(between.frame < LEGACY.strong.frame && between.frame > LEGACY.normal.frame);
  assert.deepEqual(plateAmounts(-20), plateAmounts(0));
  assert.deepEqual(plateAmounts(400), plateAmounts(100));
});

const COMBOS = [];
for (const entry of SKIN_MANIFEST) {
  for (const plate of ['light', 'dark', 'tint']) {
    for (const theme of ['light', 'dark']) COMBOS.push({ entry, plate, theme });
  }
}
const palette = ({ entry, plate, theme }, outer, main = outer) =>
  resolvePalette({
    accent: entry.accent,
    cast: entry.cast,
    plate,
    theme,
    outerTransparency: outer,
    mainTransparency: main,
    picture: entry.picture,
  });

test('the outer slider drives frame + panel, the main slider veil + card; neither moves the other family', () => {
  const base = plateAmounts(20, 20);
  const outerMoved = plateAmounts(80, 20);
  const mainMoved = plateAmounts(20, 80);
  assert.equal(outerMoved.veil, base.veil);
  assert.equal(outerMoved.card, base.card);
  assert.ok(outerMoved.frame < base.frame && outerMoved.panel < base.panel);
  assert.equal(mainMoved.frame, base.frame);
  assert.equal(mainMoved.panel, base.panel);
  assert.ok(mainMoved.veil < base.veil && mainMoved.card < base.card);
  assert.deepEqual(plateAmounts(40), plateAmounts(40, 40), 'main defaults to outer');
  for (const combo of COMBOS) {
    const a = palette(combo, 20, 20).amounts;
    const b = palette(combo, 100, 20).amounts;
    const c = palette(combo, 20, 100).amounts;
    assert.equal(b.veil, a.veil);
    assert.equal(b.card, a.card);
    assert.equal(c.frame, a.frame);
    assert.equal(c.panel, a.panel);
  }
});

test('contrast guard holds per plate family at 0 / 20 / 100 on each slider, in every pairing', () => {
  for (const combo of COMBOS) {
    const tones = plateTones(combo.plate, combo.theme, combo.entry.cast);
    const cardFloor = minPlateAlpha(tones.tint, tones.ink, tones.muted);
    for (const outer of [0, 20, 100]) {
      for (const main of [0, 20, 40, 100]) {
        const p = palette(combo, outer, main);
        const label = `${combo.entry.id}/${combo.plate}/${combo.theme} ${outer}/${main}`;
        assert.ok(p.cardAmount >= cardFloor - 1e-12, `${label} card floor`);
        const worst =
          contrastRatio(tones.tint, '#000000') > contrastRatio(tones.tint, '#ffffff') ? '#000000' : '#ffffff';
        const card = blend(tones.tint, worst, p.cardAmount);
        assert.ok(
          contrastRatio(card, tones.ink) >= 4.5 && contrastRatio(card, tones.muted) >= 4.5,
          `${label} text on card`
        );
        for (const backdrop of plateBackdrops(p.tint, combo.entry.picture, p.amounts).slice(0, 3)) {
          assert.ok(contrastRatio(p.chromeInk, backdrop) >= 4.5, `${label} ink`);
          assert.ok(contrastRatio(p.chromeMuted, backdrop) >= 4.5, `${label} muted`);
        }
      }
    }
  }
});

test('contrast guard: the text plates are never thinner than the 4.5:1 floor, however transparent', () => {
  for (const combo of COMBOS) {
    const tones = plateTones(combo.plate, combo.theme, combo.entry.cast);
    const floor = minPlateAlpha(tones.tint, tones.ink, tones.muted);
    for (let t = 0; t <= 100; t += 5) {
      const card = palette(combo, t).cardAmount;
      assert.ok(
        card >= floor - 1e-12,
        `${combo.entry.id}/${combo.plate}/${combo.theme} card ${card} < ${floor} at ${t}`
      );
      assert.ok(card >= plateAmounts(t, t).card - 1e-12 || card === floor);
      if (t > 0) assert.ok(card <= palette(combo, t - 5).cardAmount + 1e-12, 'card never thickens with transparency');
    }
    // Where the floor binds (high transparency) the card is clamped to it.
    assert.ok(Math.abs(palette(combo, 100).cardAmount - Math.max(plateAmounts(100).card, floor)) < 1e-12);
  }
});

test('outlines, rules and fills keep their contrast over plate AND picture and only strengthen with transparency', () => {
  const caps = { rule: 0.5, edge: 0.6, edgeStrong: 0.75, fill: 0.3, fillStrong: 0.4 };
  for (const combo of COMBOS) {
    let previous = null;
    for (let t = 0; t <= 100; t += 5) {
      const p = palette(combo, t);
      const backdrops = plateBackdrops(p.tint, combo.entry.picture, p.amounts);
      for (const [name, target] of Object.entries(MARK_TARGETS)) {
        const alpha = p.marks[name];
        if (alpha < caps[name] - 1e-9) {
          for (const backdrop of backdrops) {
            assert.ok(
              contrastRatio(blend(p.chromeInk, backdrop, alpha), backdrop) >= target - 0.02,
              `${combo.entry.id}/${combo.plate}/${combo.theme} ${name} @${t}`
            );
          }
        }
        if (previous && previous.chromeInk === p.chromeInk) {
          assert.ok(alpha >= previous.marks[name] - 1e-12, `${name} weakens at ${t}`);
        }
      }
      previous = p;
    }
  }
});

test('chrome icons and labels keep 4.5:1 (icons need 3:1) against the frame, panel and veil over the picture at every transparency', () => {
  for (const combo of COMBOS) {
    for (let t = 0; t <= 100; t++) {
      const p = palette(combo, t);
      for (const backdrop of plateBackdrops(p.tint, combo.entry.picture, p.amounts).slice(0, 3)) {
        assert.ok(
          contrastRatio(p.chromeInk, backdrop) >= 4.5,
          `${combo.entry.id}/${combo.plate}/${combo.theme} ink @${t}`
        );
        assert.ok(
          contrastRatio(p.chromeMuted, backdrop) >= 4.5,
          `${combo.entry.id}/${combo.plate}/${combo.theme} muted @${t}`
        );
      }
    }
  }
});

function skinDom(t) {
  const dom = installTestDom(t, { actEnvironment: false });
  return { ...dom, root: dom.document.documentElement };
}

test('the stored transparency drives the CSS variables live', async (t) => {
  const { root } = skinDom(t);
  const skin = await import('./desktop-skin');
  skin.setSkin('night-city');
  const amounts = () =>
    ['frame', 'veil', 'panel', 'card'].map((name) => root.style.getPropertyValue(`--mx-skin-${name}-amount`));
  assert.deepEqual(amounts().slice(1, 3), ['22%', '40%'], 'a fresh device paints the 50 outer / 50 main default');
  assert.equal(skin.getSkinPlate(), 'dark');
  skin.setSkinTransparency(50);
  assert.deepEqual(amounts().slice(0, 3), ['40%', '22%', '40%']);
  skin.setSkinTransparency(25);
  assert.deepEqual(amounts().slice(0, 3), ['55%', '38%', '58%']);
  skin.setSkinTransparency(75);
  assert.deepEqual(amounts().slice(0, 3), ['28%', '14%', '28%']);
  skin.setSkinTransparency(100);
  assert.deepEqual(amounts().slice(0, 3), ['10%', '4%', '10%']);
  for (const name of ['rule', 'edge', 'edge-strong', 'fill', 'fill-strong']) {
    assert.match(root.style.getPropertyValue(`--mx-skin-${name}-amount`), /^\d+(\.\d)?%$/);
  }
  assert.match(root.style.getPropertyValue('--mx-skin-chrome-ink'), /^#[0-9a-f]{6}$/);
  assert.equal(skin.getSkinOuterTransparency(), 100);
  assert.equal(skin.getSkinMainTransparency(), 100);
  skin.setSkinTransparency(1000);
  assert.equal(skin.getSkinOuterTransparency(), 100);
  // Each slider paints only its own plates.
  skin.setSkinTransparency(50);
  skin.setSkinOuterTransparency(25);
  assert.deepEqual(amounts().slice(0, 3), ['55%', '22%', '58%']);
  skin.setSkinMainTransparency(75);
  assert.deepEqual(amounts().slice(0, 3), ['55%', '14%', '58%']);
  assert.equal(skin.getSkinOuterTransparency(), 25);
  assert.equal(skin.getSkinMainTransparency(), 75);
});

test('an old single value (or the soft / normal / strong key) gives both sliders that value; nothing stored gives 50 / 50', async (t) => {
  const { window } = skinDom(t);
  const skin = await import('./desktop-skin');
  const store = window.localStorage;
  const both = () => [skin.getSkinOuterTransparency(), skin.getSkinMainTransparency()];
  assert.deepEqual(both(), [50, 50], 'nothing stored: default');
  for (const [dim, position] of [
    ['strong', 25],
    ['soft', 75],
    ['normal', 50],
  ]) {
    store.setItem('mixdog.desktop.skin-dim.v1', dim);
    assert.deepEqual(both(), [position, position]);
    assert.equal(store.getItem('mixdog.desktop.skin-dim.v1'), dim, 'old key kept');
  }
  // The old single key wins over the soft / normal / strong one, for both sliders.
  store.setItem('mixdog.desktop.skin-dim.v1', 'strong');
  store.setItem('mixdog.desktop.skin-transparency.v1', '63');
  assert.deepEqual(both(), [63, 63]);
  assert.equal(store.getItem('mixdog.desktop.skin-transparency.v1'), '63', 'old key kept');
  // A slider's own key wins over the inherited value, and only for that slider.
  skin.setSkinOuterTransparency(10);
  assert.deepEqual(both(), [10, 63]);
  skin.setSkinMainTransparency(90);
  assert.deepEqual(both(), [10, 90]);
  store.setItem('mixdog.desktop.skin-transparency-outer.v1', 'oops');
  assert.deepEqual(both(), [63, 90], 'garbage falls back to the old single value');
  skin.resetSkin();
  assert.deepEqual(both(), [50, 50]);
});

test('the skin sheet re-declares the hairline / fill / icon tokens from the plate ink and outranks the rail theme rule', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./desktop/33-skin.css', import.meta.url), 'utf8');
  for (const token of [
    '--mx-border-muted',
    '--mx-border',
    '--mx-border-structure',
    '--mx-border-strong',
    '--mx-hover',
    '--mx-pressed',
    '--mx-surface-plate',
    '--mx-card-header-surface',
    '--mx-icon',
    '--mx-icon-muted',
    '--mx-meter-track',
    '--mx-meter-fill',
  ]) {
    assert.match(css, new RegExp(`\\n  ${token}: var\\(--mx-skin-`), `${token} comes from the skin marks`);
  }
  // 06-activity-rail.css colours the light rail with `:root[data-mixdog-theme="light"] .activity-rail`
  // (0,3,0); the skin's rail colour must be at least as specific and later.
  assert.match(css, /:root\[data-mixdog-skin\] \.activity-rail \{\s*color: var\(--mx-skin-chrome-muted\)/);
  assert.doesNotMatch(css, /data-mixdog-skin-dim|data-skin-dim/);
});
