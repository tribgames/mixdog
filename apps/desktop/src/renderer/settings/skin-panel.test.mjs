import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

async function mountPanel(t) {
  const dom = installTestDom(t, { rootId: 'root', expose: ['MouseEvent', 'Event', 'HTMLElement', 'MutationObserver'] });
  const { SkinPanel } = await import('./skin-panel');
  const skin = await import('../desktop-skin');
  await act(async () => dom.root.render(React.createElement(SkinPanel, {})));
  const html = dom.document.documentElement;
  const card = (id) => dom.document.querySelector(`.skin-card[data-skin="${id}"]`);
  const preview = () => dom.document.querySelector('.skin-preview');
  const hover = (id, enter) =>
    act(async () => {
      const el = card(id);
      if (enter) el.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true }));
      else
        el.dispatchEvent(new dom.window.MouseEvent('pointerout', { bubbles: true, relatedTarget: dom.document.body }));
    });
  return { ...dom, skin, html, card, preview, hover };
}

test('the skin cards are a radiogroup; clicking applies at once', async (t) => {
  const { document, card, html, skin, root } = await mountPanel(t);
  const group = document.querySelector('[role="radiogroup"]');
  assert.ok(group);
  const radios = [...group.querySelectorAll('[role="radio"]')];
  assert.deepEqual(
    radios.map((radio) => radio.dataset.skin),
    ['system', 'dark', 'white', 'glass-flow', 'spring-window', 'tech-studio', 'night-city']
  );
  // Roving tabindex: only the checked card is a tab stop.
  assert.deepEqual(
    radios.map((radio) => radio.tabIndex),
    [-1, 0, -1, -1, -1, -1, -1]
  );
  assert.equal(card('dark').getAttribute('aria-checked'), 'true', 'a fresh install runs the dark default');
  await act(async () => card('night-city').click());
  assert.equal(html.dataset.mixdogSkin, 'night-city');
  assert.equal(skin.getSkinId(), 'night-city');
  assert.equal(card('night-city').getAttribute('aria-checked'), 'true');
  assert.equal(card('night-city').tabIndex, 0);
  await act(async () => root.render(null));
});

test('hover and focus preview only inside the preview, then revert', async (t) => {
  const { document, card, html, preview, hover, skin, root } = await mountPanel(t);
  await act(async () => card('glass-flow').click());
  assert.equal(preview().dataset.skinPreview, 'glass-flow');
  assert.ok(!document.querySelector('.skin-preview-tag'));
  const accentBefore = html.style.getPropertyValue('--mx-skin-accent');

  await hover('night-city', true);
  assert.equal(preview().dataset.skinPreview, 'night-city');
  assert.ok(document.querySelector('.skin-preview-tag'));
  assert.equal(html.dataset.mixdogSkin, 'glass-flow', 'the app behind does not change');
  assert.equal(html.style.getPropertyValue('--mx-skin-accent'), accentBefore);
  // The preview takes the previewed skin's own default plate.
  assert.notEqual(
    preview().style.getPropertyValue('--mx-skin-accent'),
    html.style.getPropertyValue('--mx-skin-accent')
  );
  assert.equal(skin.getSkinId(), 'glass-flow');

  await hover('night-city', false);
  assert.equal(preview().dataset.skinPreview, 'glass-flow');
  assert.ok(!document.querySelector('.skin-preview-tag'));

  await act(async () => card('spring-window').focus());
  assert.equal(preview().dataset.skinPreview, 'spring-window');
  assert.ok(document.querySelector('.skin-preview-tag'));
  await act(async () => card('spring-window').blur());
  assert.equal(preview().dataset.skinPreview, 'glass-flow');
  await act(async () => root.render(null));
});

test('the detail rows explain themselves, and plate / accent / toggles apply live', async (t) => {
  const { document, card, html, skin, root } = await mountPanel(t);
  assert.equal(document.querySelector('[aria-label="Plate color"]'), null, 'no detail rows without a skin');
  await act(async () => card('glass-flow').click());
  const plate = document.querySelector('.skin-seg[aria-label="Plate color"]');
  assert.ok(plate, 'plate is a segmented control');
  assert.match(document.body.textContent, /Color of the sidebar and message plates/);
  assert.equal(plate.querySelector('[aria-pressed="true"]').dataset.value, 'light');
  await act(async () => plate.querySelector('[data-value="dark"]').click());
  assert.equal(html.dataset.mixdogSkinPlate, 'dark');

  const swatch = document.querySelector('.skin-swatch[data-color="#5bb0ff"]');
  await act(async () => swatch.click());
  assert.equal(skin.getSkinAccent(), '#5bb0ff');
  assert.equal(swatch.getAttribute('aria-pressed'), 'true');
  await act(async () => document.querySelector('.skin-swatch-auto').click());
  assert.equal(skin.getSkinAccent(), null);

  await act(async () => document.querySelector('input[aria-label="Background photo"]').click());
  assert.equal(html.dataset.mixdogSkinPhoto, 'off');
  // The desktop pet moved to Settings → General: no corner character here.
  assert.equal(document.querySelector('input[aria-label="Corner character"]'), null);
  assert.equal(document.querySelector('.skin-preview-buddy'), null);

  await act(async () =>
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Reset to defaults').click()
  );
  assert.equal(html.dataset.mixdogSkin, undefined);
  await act(async () => root.render(null));
});

test('Outer and main panel transparency are two accessible 0-100 sliders that repaint the app and the preview live', async (t) => {
  const { document, card, html, preview, skin, window, root } = await mountPanel(t);
  assert.equal(
    document.querySelector('[aria-label="Outer panels transparency"]'),
    null,
    'no detail rows without a skin'
  );
  await act(async () => card('spring-window').click());
  const outer = document.querySelector('input[type="range"][aria-label="Outer panels transparency"]');
  const main = document.querySelector('input[type="range"][aria-label="Main panel transparency"]');
  assert.ok(outer && main);
  for (const [slider, value] of [
    [outer, '50'],
    [main, '50'],
  ]) {
    assert.deepEqual([slider.min, slider.max, slider.step, slider.value], ['0', '100', '1', value]);
    assert.equal(slider.getAttribute('aria-valuetext'), `${value}%`);
  }
  assert.deepEqual(
    [outer, main].map((slider) => slider.parentElement.querySelector('.skin-slider-value')?.textContent),
    ['50%', '50%']
  );
  assert.doesNotMatch(document.body.textContent, /Skin strength/);
  const set = (slider, value) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(slider, String(value));
      slider.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const amount = (name) => html.style.getPropertyValue(`--mx-skin-${name}-amount`);
  const veil = amount('veil');
  await set(outer, 80);
  assert.equal(skin.getSkinOuterTransparency(), 80);
  assert.equal(skin.getSkinMainTransparency(), 50, 'the other slider is untouched');
  assert.equal(outer.getAttribute('aria-valuetext'), '80%');
  assert.equal(main.getAttribute('aria-valuetext'), '50%');
  const frame = amount('frame');
  assert.ok(parseFloat(frame) < 28, `app frame thins past the soft preset: ${frame}`);
  assert.equal(amount('veil'), veil, 'the main veil did not move');
  assert.equal(preview().style.getPropertyValue('--mx-skin-frame-amount'), frame, 'the preview follows');
  await set(main, 75);
  assert.equal(skin.getSkinMainTransparency(), 75);
  assert.equal(amount('frame'), frame, 'the outer plates did not move');
  assert.equal(preview().style.getPropertyValue('--mx-skin-veil-amount'), '14%');
  await set(outer, 25);
  assert.equal(preview().style.getPropertyValue('--mx-skin-frame-amount'), '55%');
  await act(async () => root.render(null));
});

test('selecting the current skin changes nothing (a plate chosen for it stays)', async (t) => {
  const { card, skin, root } = await mountPanel(t);
  await act(async () => card('glass-flow').click());
  skin.setSkinPlate('dark');
  await act(async () => card('glass-flow').click());
  assert.equal(skin.getSkinPlate(), 'dark');
  await act(async () => card('night-city').click());
  assert.equal(skin.getSkinPlate(), 'dark', 'Night city defaults to dark glass');
  await act(async () => root.render(null));
});

test('the tab stop follows the focused card; Tab away and Shift+Tab back lands on it', async (t) => {
  const { document, card, window, root } = await mountPanel(t);
  await act(async () => card('glass-flow').click());
  const tabStops = () =>
    [...document.querySelectorAll('.skin-radios [role="radio"]')]
      .filter((r) => r.tabIndex === 0)
      .map((r) => r.dataset.skin);
  assert.deepEqual(tabStops(), ['glass-flow']);
  await act(async () => card('glass-flow').focus());
  await act(async () =>
    card('glass-flow').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  );
  assert.equal(document.activeElement, card('spring-window'));
  assert.deepEqual(tabStops(), ['spring-window']);
  // Tab moves focus out of the group: the group keeps the arrowed-to card as its stop.
  await act(async () => card('spring-window').blur());
  assert.deepEqual(tabStops(), ['spring-window']);
  assert.equal(card('glass-flow').getAttribute('aria-checked'), 'true', 'arrowing does not select');
  await act(async () => root.render(null));
});

test('a hover preview is cancelled when the custom-picture dialog opens', async (t) => {
  const dom = await mountPanel(t);
  const { document, window, card, preview, hover, root } = dom;
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  const realImage = globalThis.Image;
  const proto = window.HTMLCanvasElement.prototype;
  const realContext = proto.getContext;
  const realDataUrl = proto.toDataURL;
  URL.createObjectURL = () => 'blob:mixdog-test';
  URL.revokeObjectURL = () => {};
  globalThis.Image = class {
    naturalWidth = 64;
    naturalHeight = 64;
    decode() {
      return Promise.resolve();
    }
  };
  proto.getContext = () => ({
    drawImage() {},
    getImageData: () => ({ data: new Uint8ClampedArray(64 * 64 * 4).fill(128) }),
  });
  proto.toDataURL = () => 'data:image/jpeg;base64,/9j/';
  t.after(() => {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
    globalThis.Image = realImage;
    proto.getContext = realContext;
    proto.toDataURL = realDataUrl;
  });
  await act(async () => card('glass-flow').click());
  await hover('night-city', true);
  assert.ok(document.querySelector('.skin-preview-tag'));
  const input = document.querySelector('input[type="file"]');
  Object.defineProperty(input, 'files', { value: [new window.File(['x'], 'a.jpg')], configurable: true });
  await act(async () => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.ok(document.querySelector('.skin-custom-dialog'), 'the dialog opened');
  assert.ok(!document.querySelector('.skin-preview-tag'));
  assert.equal(preview().dataset.skinPreview, 'glass-flow');
  await act(async () => root.render(null));
});

test('"Add my picture" takes videos and GIFs and refuses a file over 20 MB with a clear message', async (t) => {
  const { document, window, root } = await mountPanel(t);
  const input = document.querySelector('input[type="file"]');
  assert.equal(input.getAttribute('accept'), 'image/*,video/mp4,video/webm');
  const big = new window.File(['x'], 'clip.mp4', { type: 'video/mp4' });
  Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
  Object.defineProperty(input, 'files', { value: [big], configurable: true });
  await act(async () => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  assert.equal(
    document.querySelector('[role="alert"]')?.textContent,
    'This file is larger than 20 MB. Choose a smaller picture or video.'
  );
  assert.ok(!document.querySelector('.skin-custom-dialog'));
  const mov = new window.File(['x'], 'clip.mov', { type: 'video/quicktime' });
  Object.defineProperty(input, 'files', { value: [mov], configurable: true });
  await act(async () => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  assert.equal(
    document.querySelector('[role="alert"]')?.textContent,
    'Choose a picture (PNG, JPEG, WebP or GIF) or a video (MP4 or WebM).'
  );
  await act(async () => root.render(null));
});

test('the custom-picture dialog scrim closes on a tap (pointerdown + click), not on a drag out of the card', async (t) => {
  const dom = installTestDom(t, { rootId: 'root', expose: ['MouseEvent', 'Event', 'HTMLElement', 'PointerEvent'] });
  const { SkinCustomDialog } = await import('./skin-custom-dialog');
  let closed = 0;
  const prepared = {
    dataUrl: 'data:image/jpeg;base64,/9j/',
    accent: '#336699',
    cast: { hue: 210, sat: 50 },
    picture: '#808080',
    swatches: ['#336699'],
  };
  await act(async () =>
    dom.root.render(React.createElement(SkinCustomDialog, { prepared, onClose: () => closed++, onApplied() {} }))
  );
  const { document, window } = dom;
  const scrim = document.querySelector('.settings-confirm-layer');
  const card = document.querySelector('.skin-custom-dialog');
  const Pointer = window.PointerEvent ?? window.MouseEvent;
  const press = (target) =>
    act(async () => {
      target.dispatchEvent(new Pointer('pointerdown', { bubbles: true }));
    });
  const click = (target) =>
    act(async () => {
      target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
  // A mousedown alone (what iOS never sends for a tap) no longer decides anything.
  await act(async () => scrim.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
  assert.equal(closed, 0);
  // A press that starts in the card and lets go over the scrim keeps the dialog.
  await press(card);
  await click(scrim);
  assert.equal(closed, 0);
  await press(scrim);
  await click(scrim);
  assert.equal(closed, 1);
  await act(async () => dom.root.render(null));
});

test('the None preview shows the theme, not a retained accent override', async (t) => {
  const { card, preview, skin, root, html } = await mountPanel(t);
  await act(async () => card('glass-flow').click());
  skin.setSkinAccent('#e9799a');
  await act(async () => card('system').focus());
  assert.equal(preview().dataset.skinPreview, 'none');
  assert.equal(preview().style.getPropertyValue('--mx-skin-accent'), '#1967d2', 'the theme accent (--mx-accent-bg)');
  assert.notEqual(
    preview().style.getPropertyValue('--mx-skin-accent'),
    html.style.getPropertyValue('--mx-skin-accent')
  );
  assert.equal(skin.getSkinAccent(), '#e9799a', 'the override itself is kept for the next skin');
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./skin-panel.css', import.meta.url), 'utf8');
  assert.match(
    css,
    /data-mixdog-theme="light"\] \.skin-preview\[data-skin-preview="none"\] \{\s*--mx-user-bubble: var\(--mx-bg-layer-2\)/
  );
  await act(async () => root.render(null));
});

test('System / Dark / Light tiles turn the skin off and set the theme; one tile is selected at a time', async (t) => {
  const { card, skin, html, document, root } = await mountPanel(t);
  const theme = await import('../desktop-theme');
  const checked = () => [...document.querySelectorAll('.skin-radios [aria-checked="true"]')].map((r) => r.dataset.skin);
  await act(async () => card('night-city').click());
  assert.deepEqual(checked(), ['night-city']);
  assert.ok(document.querySelector('.skin-seg[aria-label="Plate color"]'), 'fine tuning shows with a skin');
  await act(async () => card('white').click());
  assert.equal(skin.getSkinId(), 'none');
  assert.equal(theme.getDesktopThemePreference(), 'white');
  assert.equal(html.dataset.mixdogTheme, 'light');
  assert.deepEqual(checked(), ['white']);
  assert.equal(document.querySelector('.skin-seg[aria-label="Plate color"]'), null, 'no fine tuning without a skin');
  await act(async () => card('system').click());
  assert.equal(theme.getDesktopThemePreference(), 'system');
  assert.deepEqual(checked(), ['system']);
  await act(async () => card('dark').click());
  assert.equal(theme.getDesktopThemePreference(), 'dark');
  assert.deepEqual(checked(), ['dark']);
  // The theme stays stored under a skin, so turning the skin off returns to it.
  await act(async () => card('glass-flow').click());
  assert.equal(theme.getDesktopThemePreference(), 'dark');
  assert.deepEqual(checked(), ['glass-flow']);
  await act(async () => root.render(null));
});

test('the page holds fonts, chat text size and theme files; no separate theme control remains', async (t) => {
  const { document, root } = await mountPanel(t);
  for (const label of [
    'UI font',
    'Code font',
    'UI size',
    'Code size',
    'Code ligatures',
    'Chat text size',
    'Color theme',
  ]) {
    assert.ok(document.querySelector(`[aria-label="${label}"]`), label);
  }
  for (const label of ['UI font', 'Code font']) {
    assert.equal(
      document.querySelector(`input[aria-label="${label}"]`),
      null,
      `${label} is a select, not a text input`
    );
    assert.ok(document.querySelector(`button[role="combobox"][aria-label="${label}"]`), label);
  }
  assert.doesNotMatch(document.body.textContent, /Themes and fonts/);
  await act(async () => root.render(null));
});
