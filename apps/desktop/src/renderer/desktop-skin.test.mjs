import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';
import { contrastRatio, fitAccent, plateTones, resolvePalette } from './skin-color';
import { SKIN_MANIFEST } from './skin-manifest';
import {
  DEVICE_SETTINGS_CATEGORIES,
  categoryForSettingsItem,
  SETTINGS_CATEGORIES,
  settingsCategoriesForSurface,
  settingsCategoryForSurface,
} from './settings/settings-items';

function skinDom(t) {
  const dom = installTestDom(t, { actEnvironment: false });
  return { ...dom, root: dom.document.documentElement };
}

test('Skin is the category right after General, a device page on a remote surface', () => {
  const values = SETTINGS_CATEGORIES.map((category) => category.value);
  assert.equal(values[values.indexOf('general') + 1], 'skin');
  assert.equal(settingsCategoryForSurface('skin', false), 'skin');
  assert.equal(settingsCategoryForSurface('skin', true), 'skin');
  assert.ok(settingsCategoriesForSurface(false).some((category) => category.value === 'skin'));
  assert.ok(!settingsCategoriesForSurface(true).some((category) => category.value === 'skin'));
  assert.ok(!settingsCategoriesForSurface(true, true).some((category) => category.value === 'skin'));
  assert.deepEqual(
    DEVICE_SETTINGS_CATEGORIES.map((category) => category.value),
    ['display', 'skin']
  );
});

test('the page is labelled Theme, owns the theme item, and the retired themes-and-fonts id redirects to it', () => {
  assert.equal(SETTINGS_CATEGORIES.find((category) => category.value === 'skin').label, 'Theme');
  assert.ok(!SETTINGS_CATEGORIES.some((category) => category.value === 'appearance'));
  assert.equal(categoryForSettingsItem('theme'), 'skin');
  assert.equal(settingsCategoryForSurface('appearance', false), 'skin');
  assert.equal(settingsCategoryForSurface('appearance', true), 'skin');
});

test('choosing a skin paints its manifest focal point, accent and its own default plate', async (t) => {
  const { root } = skinDom(t);
  const skin = await import('./desktop-skin');
  skin.applyStoredSkin();
  assert.equal(skin.getSkinId(), 'none');
  for (const entry of SKIN_MANIFEST) {
    skin.setSkin(entry.id);
    assert.equal(root.dataset.mixdogSkin, entry.id);
    assert.equal(root.style.getPropertyValue('--mx-skin-pos'), entry.focal);
    assert.equal(skin.getSkinPlate(), entry.plate);
  }
  // A plate chosen for one picture does not follow the next skin.
  skin.setSkinPlate('dark');
  assert.equal(skin.getSkinPlate(), 'dark');
  skin.setSkin('glass-flow');
  assert.equal(skin.getSkinPlate(), 'light');
});

test('a device that stored a removed skin id falls back to no skin', async (t) => {
  const { root, window } = skinDom(t);
  const skin = await import('./desktop-skin');
  for (const id of ['sunset-meadow', 'city-afternoon', 'nonsense']) {
    window.localStorage.setItem('mixdog.desktop.skin.v1', JSON.stringify({ id, accent: '#e07938' }));
    skin.applyStoredSkin();
    assert.equal(skin.getSkinId(), 'none', id);
    assert.equal(skin.skinActive(), false, id);
    assert.equal(root.dataset.mixdogSkin, undefined, id);
    assert.equal(root.style.getPropertyValue('--mx-skin-image'), '', id);
    assert.equal(skin.getSkinPlate(), 'light', id);
  }
});

test('an accent override goes through the contrast guard; "from the picture" restores the manifest accent', async (t) => {
  const { root } = skinDom(t);
  const skin = await import('./desktop-skin');
  const glass = SKIN_MANIFEST.find((entry) => entry.id === 'glass-flow');
  skin.setSkin('glass-flow');
  const tint = plateTones('light', 'dark', glass.cast).tint;
  const accentVar = () => root.style.getPropertyValue('--mx-skin-accent');
  assert.equal(accentVar(), fitAccent(glass.accent, tint));
  // A pale yellow fails 3:1 against a cream plate until the guard darkens it.
  skin.setSkinAccent('#ffee88');
  assert.equal(skin.getSkinAccent(), '#ffee88');
  assert.notEqual(accentVar(), '#ffee88');
  assert.equal(accentVar(), fitAccent('#ffee88', tint));
  assert.ok(contrastRatio(accentVar(), tint) >= 3);
  assert.ok(contrastRatio(accentVar(), root.style.getPropertyValue('--mx-skin-on-accent')) >= 4.5);
  skin.setSkinAccent(null);
  assert.equal(skin.getSkinAccent(), null);
  assert.equal(accentVar(), fitAccent(glass.accent, tint));
  assert.equal(
    skin.skinVars(
      'glass-flow',
      { outerTransparency: 50, mainTransparency: 50, plate: 'light', accent: '#5bb0ff' },
      'dark'
    )['--mx-skin-accent'],
    resolvePalette({
      accent: '#5bb0ff',
      cast: glass.cast,
      plate: 'light',
      theme: 'dark',
      outerTransparency: 50,
      mainTransparency: 50,
      picture: glass.picture,
    }).accent
  );
});

test('the custom picture keeps its subject point and accent across reload and skin switches', async (t) => {
  const { root } = skinDom(t);
  const skin = await import('./desktop-skin');
  const prepared = { dataUrl: 'data:image/jpeg;base64,/9j/', accent: '#336699', cast: { hue: 210, sat: 50 } };
  skin.commitCustomSkin(prepared, { x: 0.25, y: 0.8 });
  assert.equal(skin.getSkinId(), 'custom');
  assert.equal(skin.getCustomSkinFocal(), '25% 80%');
  assert.equal(root.style.getPropertyValue('--mx-skin-pos'), '25% 80%');
  skin.setSkin('night-city');
  assert.equal(root.style.getPropertyValue('--mx-skin-pos'), '50% 80%');
  skin.setSkin('custom');
  assert.equal(root.style.getPropertyValue('--mx-skin-pos'), '25% 80%');
  // A reload re-reads everything from localStorage.
  root.removeAttribute('style');
  delete root.dataset.mixdogSkin;
  skin.applyStoredSkin();
  assert.equal(root.dataset.mixdogSkin, 'custom');
  assert.equal(root.style.getPropertyValue('--mx-skin-pos'), '25% 80%');
  assert.equal(root.style.getPropertyValue('--mx-skin-image'), `url("${prepared.dataUrl}")`);
  // Out-of-range points are clamped.
  skin.commitCustomSkin(prepared, { x: 4, y: -2 });
  assert.equal(skin.getCustomSkinFocal(), '100% 0%');
});

test('reset returns to no skin, default transparency and clears accent, plate and photo overrides', async (t) => {
  const { root } = skinDom(t);
  const skin = await import('./desktop-skin');
  skin.setSkin('spring-window');
  skin.setSkinTransparency(25);
  skin.setSkinPlate('dark');
  skin.setSkinAccent('#6fcf8e');
  skin.setSkinPhoto(false);
  assert.equal(root.dataset.mixdogSkinPhoto, 'off');
  skin.resetSkin();
  assert.equal(skin.getSkinId(), 'none');
  assert.equal(skin.getSkinOuterTransparency(), 50);
  assert.equal(skin.getSkinMainTransparency(), 50);
  assert.equal(skin.getSkinAccent(), null);
  assert.equal(skin.getSkinPhoto(), true);
  assert.equal(root.dataset.mixdogSkin, undefined);
});

/** A desktop (Electron) window with media playback, matchMedia and visibility under the test's control. */
function motionDom(t, { reduced = false, hidden = false, userAgent = 'Mozilla/5.0 Electron/41.0.0' } = {}) {
  const dom = installTestDom(t, { actEnvironment: false, globals: { navigator: { userAgent } } });
  const { window } = dom;
  window.matchMedia = (query) => ({
    matches: reduced && query === '(prefers-reduced-motion: reduce)',
    addEventListener() {},
    removeEventListener() {},
  });
  const calls = [];
  window.HTMLMediaElement.prototype.play = function play() {
    calls.push('play');
    return Promise.resolve();
  };
  window.HTMLMediaElement.prototype.pause = function pause() {
    calls.push('pause');
  };
  let hiddenNow = hidden;
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => hiddenNow });
  const setHidden = (value) => {
    hiddenNow = value;
    window.document.dispatchEvent(new window.Event('visibilitychange'));
  };
  const video = () => window.document.querySelector('video.skin-motion');
  return { ...dom, root: window.document.documentElement, calls, setHidden, video };
}

test('a built-in skin plays its loop behind the shell with the picture as poster until the first frame', async (t) => {
  const { root, video, window } = motionDom(t);
  const skin = await import('./desktop-skin');
  for (const entry of skin.BUILTIN_SKINS) {
    skin.setSkin(entry.id);
    const layer = video();
    assert.ok(layer, entry.id);
    assert.equal(layer.getAttribute('src'), entry.video);
    assert.match(entry.video, /\.webm$/);
    assert.equal(layer.getAttribute('poster'), entry.image);
    assert.match(entry.image, /\.jpg$/);
    for (const name of ['muted', 'loop', 'playsinline', 'autoplay']) assert.ok(layer.hasAttribute(name), name);
    assert.equal(layer.muted, true);
    // The picture stays painted under it.
    assert.equal(root.style.getPropertyValue('--mx-skin-image'), `url("${entry.image}")`);
    assert.equal(layer.dataset.ready, undefined, 'clear until it plays');
    layer.dispatchEvent(new window.Event('playing'));
    assert.equal(layer.dataset.ready, 'true');
  }
  assert.equal(window.document.querySelectorAll('.skin-motion').length, 1);
  // A repaint (theme flip, slider) keeps the playing element.
  const playing = video();
  skin.setSkinTransparency(30);
  assert.equal(video(), playing);
  skin.setSkinPhoto(false);
  assert.equal(video(), null, 'photo off: no video');
  skin.setSkinPhoto(true);
  assert.ok(video());
  skin.setSkin('none');
  assert.equal(video(), null);
});

test('reduced motion and the phone keep the poster: no video', async (t) => {
  const { root, video } = motionDom(t, { reduced: true });
  const skin = await import('./desktop-skin');
  skin.setSkin('night-city');
  assert.equal(video(), null);
  assert.match(root.style.getPropertyValue('--mx-skin-image'), /night-city\.jpg/);
});

test('a phone or browser on the relay shows a built-in skin as its picture', async (t) => {
  const { root, video } = motionDom(t, { userAgent: 'Mozilla/5.0 (iPhone) Safari/604.1' });
  const skin = await import('./desktop-skin');
  skin.setSkin('glass-flow');
  assert.equal(video(), null);
  assert.match(root.style.getPropertyValue('--mx-skin-image'), /glass-flow\.jpg/);
});

test('the loop pauses while the document is hidden (minimised window) and resumes when shown', async (t) => {
  const { calls, setHidden, video } = motionDom(t, { hidden: true });
  const skin = await import('./desktop-skin');
  skin.setSkin('tech-studio');
  assert.ok(video());
  assert.deepEqual(calls, ['pause'], 'a hidden window does not start it');
  setHidden(false);
  assert.equal(calls.at(-1), 'play');
  setHidden(true);
  assert.equal(calls.at(-1), 'pause');
});

test('the custom skin takes stills, GIFs and short videos up to 20 MB and 20 s', async (t) => {
  skinDom(t);
  const skin = await import('./desktop-skin');
  const MB = 1024 * 1024;
  assert.equal(skin.CUSTOM_MEDIA_MAX_BYTES, 20 * MB);
  assert.equal(skin.CUSTOM_VIDEO_MAX_SECONDS, 20);
  assert.deepEqual(skin.CUSTOM_MEDIA_ACCEPT.split(','), ['image/*', 'video/mp4', 'video/webm']);
  assert.equal(skin.customMediaKind({ type: 'image/gif', name: 'a.gif' }), 'gif');
  assert.equal(skin.customMediaKind({ type: 'video/mp4', name: 'a.mp4' }), 'video');
  assert.equal(skin.customMediaKind({ type: 'video/webm', name: 'a.webm' }), 'video');
  assert.equal(skin.customMediaKind({ type: 'image/webp', name: 'a.webp' }), 'image');
  assert.equal(skin.customMediaKind({ type: '', name: 'clip.WEBM' }), 'video');
  assert.equal(skin.customMediaKind({ type: 'video/quicktime', name: 'a.mov' }), null);
  const file = (type, size) => ({ type, name: 'f', size });
  assert.equal(skin.customMediaProblem(file('video/mp4', 20 * MB)), null);
  assert.equal(skin.customMediaProblem(file('video/mp4', 20 * MB + 1)), 'size');
  assert.equal(skin.customMediaProblem(file('image/gif', 21 * MB)), 'size');
  assert.equal(skin.customMediaProblem(file('image/png', 21 * MB)), 'size');
  assert.equal(skin.customMediaProblem(file('video/webm', MB), 20), null);
  assert.equal(skin.customMediaProblem(file('video/webm', MB), 20.5), 'duration');
  assert.equal(skin.customMediaProblem(file('video/webm', MB), Number.POSITIVE_INFINITY), 'duration');
  assert.equal(skin.customMediaProblem(file('video/quicktime', MB)), 'type');
  await assert.rejects(
    skin.prepareCustomSkin({ type: 'video/mp4', name: 'big.mp4', size: 21 * MB }),
    (error) => error instanceof skin.CustomSkinMediaError && error.problem === 'size'
  );
});

test('a theme file never carries the skin: export under a moving skin is colours only', async (t) => {
  motionDom(t);
  const skin = await import('./desktop-skin');
  const theme = await import('./appearance/user-theme');
  skin.setSkin('night-city');
  const { text } = theme.exportThemeFile();
  assert.doesNotMatch(text, /webm|jpg|skin|data:/i);
});

test('a custom picture saved before the custom-meta record keeps its colours across a skin switch', async (t) => {
  const { root, window } = skinDom(t);
  window.localStorage.setItem('mixdog.desktop.skin-custom-image.v1', 'data:image/jpeg;base64,/9j/');
  window.localStorage.setItem(
    'mixdog.desktop.skin.v1',
    JSON.stringify({ id: 'custom', accent: '#336699', cast: { hue: 210, sat: 50 } })
  );
  const skin = await import('./desktop-skin');
  skin.applyStoredSkin();
  const painted = () => [
    root.style.getPropertyValue('--mx-skin-accent'),
    root.style.getPropertyValue('--mx-skin-tint'),
  ];
  const before = painted();
  assert.equal(
    before[0],
    resolvePalette({
      accent: '#336699',
      cast: { hue: 210, sat: 50 },
      plate: 'light',
      theme: 'dark',
      outerTransparency: 50,
      mainTransparency: 50,
      picture: '#808080',
    }).accent
  );
  skin.setSkin('night-city');
  assert.notDeepEqual(painted(), before);
  skin.setSkin('custom');
  assert.deepEqual(painted(), before);
  // Re-selecting the custom skin straight from the legacy record is lossless too.
  window.localStorage.removeItem('mixdog.desktop.skin-custom-meta.v1');
  window.localStorage.setItem(
    'mixdog.desktop.skin.v1',
    JSON.stringify({ id: 'custom', accent: '#336699', cast: { hue: 210, sat: 50 } })
  );
  skin.setSkin('custom');
  assert.deepEqual(painted(), before);
});
