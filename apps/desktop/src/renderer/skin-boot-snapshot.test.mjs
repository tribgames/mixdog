import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';
import { THEME_SCHEMA_URL } from './appearance/theme-file';

const BOOT = readFileSync(new URL('./public/boot.js', import.meta.url), 'utf8');
const KEY = 'mixdog.desktop.skin-boot.v1';
const CUSTOM_KEY = 'mixdog.desktop.skin-custom-image.v1';
const THEME = JSON.stringify({
  $schema: THEME_SCHEMA_URL,
  name: 'Harbor',
  roles: { background: '#0f1720', text: '#e6edf3', 'accent-fill': '#e0662b' },
});
const PICTURE = 'data:image/jpeg;base64,/9j/AAAA';

/** A jsdom window that runs the real public/boot.js (timers inert, observers released on close). */
function bootWindow(t, entries = {}) {
  const dom = installTestDom(t, { actEnvironment: false, jsdom: { runScripts: 'outside-only' } });
  const { window } = dom;
  const observers = [];
  const Native = window.MutationObserver;
  window.MutationObserver = class extends Native {
    constructor(callback) {
      super(callback);
      observers.push(this);
    }
  };
  const close = window.close.bind(window);
  window.close = () => {
    for (const observer of observers) observer.disconnect();
    close();
  };
  for (const [key, value] of Object.entries(entries)) window.localStorage.setItem(key, value);
  window.setTimeout = () => 0;
  return { ...dom, run: () => window.eval(BOOT), root: window.document.documentElement };
}

function storedEntries(window) {
  const out = {};
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    out[key] = window.localStorage.getItem(key);
  }
  return out;
}

function painted(window) {
  const root = window.document.documentElement;
  const attributes = Object.fromEntries(
    [...root.attributes].filter((a) => a.name.startsWith('data-mixdog-')).map((a) => [a.name, a.value])
  );
  const vars = {};
  for (let index = 0; index < root.style.length; index += 1) {
    const name = root.style[index];
    if (name.startsWith('--mx-skin-')) vars[name] = root.style.getPropertyValue(name);
  }
  return { attributes, vars, sheet: window.document.getElementById('mixdog-user-theme')?.textContent ?? null };
}

/** A first run: boot.js, then the bundle paints a skin / theme, which records the snapshot. */
async function firstRun(preference, paint) {
  const first = bootWindow(null);
  first.run();
  const desktopTheme = await import('./desktop-theme');
  const userTheme = await import('./appearance/user-theme');
  const skin = await import('./desktop-skin');
  desktopTheme.setDesktopThemePreference(preference);
  userTheme.applyStoredUserTheme();
  paint({ skin, userTheme });
  const result = { entries: storedEntries(first.window), painted: painted(first.window) };
  first.restore();
  return result;
}

test('painting a skin records its attributes and exact values; the custom picture is never copied', async (t) => {
  const first = bootWindow(t);
  first.run();
  const desktopTheme = await import('./desktop-theme');
  const skin = await import('./desktop-skin');
  desktopTheme.setDesktopThemePreference('dark');
  const record = () => JSON.parse(first.window.localStorage.getItem(KEY));
  assert.equal(record(), null, 'no skin: nothing recorded');

  skin.setSkin('spring-window');
  const snapshot = record();
  assert.equal(snapshot.v, 1);
  assert.equal(snapshot.themeId, 'basic');
  assert.equal(snapshot.skin.attributes['data-mixdog-skin'], 'spring-window');
  assert.equal(snapshot.skin.attributes['data-mixdog-skin-plate'], first.root.dataset.mixdogSkinPlate);
  assert.equal(snapshot.skin.image.url, first.root.style.getPropertyValue('--mx-skin-image'));
  assert.equal(snapshot.skin.vars['--mx-skin-tint'], first.root.style.getPropertyValue('--mx-skin-tint'));
  assert.equal(snapshot.skin.vars['--mx-skin-image'], undefined);
  assert.equal(snapshot.userTheme, null);

  skin.setSkinPhoto(false);
  assert.equal(record().skin.attributes['data-mixdog-skin-photo'], 'off');

  skin.commitCustomSkin({ dataUrl: PICTURE, accent: '#336699', cast: { hue: 210, sat: 50 } }, { x: 0.5, y: 0.5 });
  assert.deepEqual(record().skin.image, { custom: CUSTOM_KEY });
  assert.ok(!first.window.localStorage.getItem(KEY).includes(PICTURE), 'the data URL stays under its own key');

  skin.setSkin('none');
  assert.equal(first.window.localStorage.getItem(KEY), null, 'skin off clears the snapshot');
});

test('a user theme records its sheet text and clears with the theme', async (t) => {
  const first = bootWindow(t);
  first.run();
  const desktopTheme = await import('./desktop-theme');
  const userTheme = await import('./appearance/user-theme');
  desktopTheme.setDesktopThemePreference('dark');
  userTheme.applyStoredUserTheme();
  const record = () => JSON.parse(first.window.localStorage.getItem(KEY));
  assert.equal(record(), null);
  const imported = userTheme.importUserTheme(THEME);
  assert.ok(imported.ok);
  const sheet = first.window.document.getElementById('mixdog-user-theme').textContent;
  assert.deepEqual(record().userTheme, { id: imported.id, css: sheet });
  assert.equal(record().skin, null);
  userTheme.setActiveUserTheme(null);
  assert.equal(first.window.localStorage.getItem(KEY), null);
});

for (const preference of ['dark', 'white']) {
  test(`boot.js replays the snapshot synchronously and the bundle's paint changes nothing (${preference})`, async (t) => {
    const run = await firstRun(preference, ({ skin, userTheme }) => {
      assert.ok(userTheme.importUserTheme(THEME).ok);
      skin.commitCustomSkin({ dataUrl: PICTURE, accent: '#336699', cast: { hue: 210, sat: 50 } }, { x: 0.3, y: 0.6 });
    });
    assert.equal(run.painted.attributes['data-mixdog-skin'], 'custom');
    const second = bootWindow(t, run.entries);
    // Nothing of the app has run: boot.js alone must have painted everything.
    second.run();
    assert.deepEqual(painted(second.window), run.painted);
    assert.equal(second.root.dataset.mixdogTheme, preference === 'white' ? 'light' : 'basic');
    assert.equal(second.root.style.colorScheme, preference === 'white' ? 'light' : 'dark');
    assert.equal(second.window.mixdogBootPictureImage.src, PICTURE);
    assert.ok(second.window.document.getElementById('mixdog-boot-skin'), 'wash over the picture until the app mounts');
    // The bundle's later paint writes the identical values.
    const skin = await import('./desktop-skin');
    const userTheme = await import('./appearance/user-theme');
    const sheetBefore = second.window.document.getElementById('mixdog-user-theme');
    userTheme.applyStoredUserTheme();
    skin.applyStoredSkin();
    assert.deepEqual(painted(second.window), run.painted);
    assert.equal(second.window.document.getElementById('mixdog-user-theme'), sheetBefore);
    assert.equal(second.window.document.querySelectorAll('#mixdog-user-theme').length, 1);
  });
}

test('a built-in skin replays its picture URL and starts decoding it', async (t) => {
  const run = await firstRun('dark', ({ skin }) => skin.setSkin('night-city'));
  const second = bootWindow(t, run.entries);
  second.run();
  assert.deepEqual(painted(second.window), run.painted);
  const url = run.painted.vars['--mx-skin-image'].slice(5, -2);
  assert.equal(second.window.mixdogBootPictureImage.src, new URL(url, second.window.document.baseURI).href);
  assert.equal(second.root.dataset.mixdogUserTheme, undefined);
});

test('a removed skin id (sunset-meadow, city-afternoon) falls back to no skin and clears its recorded snapshot', async (t) => {
  const run = await firstRun('dark', ({ skin }) => skin.setSkin('spring-window'));
  for (const removed of ['sunset-meadow', 'city-afternoon']) {
    const record = JSON.parse(run.entries[KEY]);
    record.skin.attributes['data-mixdog-skin'] = removed;
    const second = bootWindow(t, {
      ...run.entries,
      [KEY]: JSON.stringify(record),
      'mixdog.desktop.skin.v1': JSON.stringify({ id: removed, accent: '#e07938' }),
    });
    second.run();
    const skin = await import('./desktop-skin');
    skin.applyStoredSkin();
    assert.equal(skin.getSkinId(), 'none', removed);
    assert.equal(second.root.dataset.mixdogSkin, undefined, removed);
    assert.equal(second.window.localStorage.getItem(KEY), null, `${removed}: the snapshot is cleared`);
    second.restore();
  }
});

test('a stale, foreign or corrupt snapshot is ignored without breaking boot', async (t) => {
  const run = await firstRun('dark', ({ skin }) =>
    skin.commitCustomSkin({ dataUrl: PICTURE, accent: '#336699', cast: { hue: 210, sat: 50 } }, { x: 0.5, y: 0.5 })
  );
  const record = JSON.parse(run.entries[KEY]);
  const variants = {
    'corrupt JSON': () => '{"v":1,"skin":',
    'not an object': () => '7',
    'another version': () => JSON.stringify({ ...record, v: 2 }),
    'another build': () => JSON.stringify({ ...record, sig: 'other-build' }),
    'another appearance input': () => JSON.stringify({ ...record, inputs: 'white|0|' }),
    'unknown variable': () =>
      JSON.stringify({ ...record, skin: { ...record.skin, vars: { ...record.skin.vars, '--evil': '1' } } }),
    'unknown attribute': () =>
      JSON.stringify({ ...record, skin: { ...record.skin, attributes: { ...record.skin.attributes, onclick: 'x' } } }),
    'foreign picture key': () =>
      JSON.stringify({ ...record, skin: { ...record.skin, image: { custom: 'mixdog.other' } } }),
    'picture URL that breaks out': () =>
      JSON.stringify({ ...record, skin: { ...record.skin, image: { url: 'url("x") ; color:red' } } }),
    'empty skin and theme': () => JSON.stringify({ ...record, skin: null, userTheme: null }),
    'theme without sheet': () => JSON.stringify({ ...record, skin: null, userTheme: { id: 'x' } }),
  };
  for (const [name, make] of Object.entries(variants)) {
    const second = bootWindow(t, { ...run.entries, [KEY]: make() });
    second.run();
    assert.equal(typeof second.window.bootT, 'function', `${name}: boot continued`);
    assert.deepEqual(painted(second.window), { attributes: {}, vars: {}, sheet: null }, name);
    second.restore();
  }
  // The custom picture removed from storage: the record names nothing it can show.
  const gone = { ...run.entries };
  delete gone[CUSTOM_KEY];
  const third = bootWindow(t, gone);
  third.run();
  assert.deepEqual(painted(third.window), { attributes: {}, vars: {}, sheet: null });
});

test('the picture key boot.js and the snapshot share is the one desktop-skin.ts stores the custom picture under', () => {
  assert.match(
    readFileSync(new URL('./desktop-skin.ts', import.meta.url), 'utf8'),
    new RegExp(`'${CUSTOM_KEY.replaceAll('.', '\\.')}'`)
  );
  assert.ok(BOOT.includes(`'${CUSTOM_KEY}'`));
});
