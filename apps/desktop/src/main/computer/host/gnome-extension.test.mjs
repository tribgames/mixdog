import assert from 'node:assert/strict';
import test from 'node:test';
import { GNOME_EXTENSION_UUID, syncGnomeExtension } from './gnome-extension.ts';

const BUNDLED = '/app/resources/gnome-extension/mixdog-windows@mixdog.io';
const USER_DIR = '/home/u/.local/share/gnome-shell/extensions/mixdog-windows@mixdog.io';
const SYSTEM_DIR = '/usr/share/gnome-shell/extensions/mixdog-windows@mixdog.io';

function harness({ files = {}, extensions = "['dash-to-dock@x.com']", desktop = 'ubuntu:GNOME', platform = 'linux', failRun = false } = {}) {
  const state = { files: { ...files }, extensions, copies: 0, commands: [], logs: [] };
  const deps = {
    platform,
    env: { XDG_CURRENT_DESKTOP: desktop },
    home: '/home/u',
    exists: (path) => path in state.files,
    readText(path) {
      if (!(path in state.files)) throw new Error('ENOENT');
      return state.files[path];
    },
    replaceDir(from, to) {
      assert.equal(from, BUNDLED);
      state.copies += 1;
      for (const key of Object.keys(state.files)) if (key.startsWith(to)) delete state.files[key];
      state.files[`${to}/metadata.json`] = state.files[`${from}/metadata.json`];
      state.files[`${to}/extension.js`] = '//';
    },
    async run(command, args) {
      state.commands.push([command, ...args].join(' '));
      if (failRun) throw new Error('gsettings: no schema\nmore');
      if (args[0] === 'get') return `${state.extensions}\n`;
      state.extensions = args[3];
      return '';
    },
    log: (message) => state.logs.push(message),
  };
  return { state, deps };
}
const meta = (version) => JSON.stringify({ uuid: GNOME_EXTENSION_UUID, version });

test('enabling copies the bundled extension per user and appends only our uuid', async () => {
  const { state, deps } = harness({ files: { [`${BUNDLED}/metadata.json`]: meta(1) } });
  await syncGnomeExtension(true, BUNDLED, deps);
  assert.equal(state.copies, 1);
  assert.ok(`${USER_DIR}/extension.js` in state.files);
  assert.equal(state.extensions, `['dash-to-dock@x.com', '${GNOME_EXTENSION_UUID}']`);
});

test('setup is idempotent: nothing is copied or written the second time', async () => {
  const { state, deps } = harness({ files: { [`${BUNDLED}/metadata.json`]: meta(1) } });
  await syncGnomeExtension(true, BUNDLED, deps);
  const commands = state.commands.length;
  await syncGnomeExtension(true, BUNDLED, deps);
  assert.equal(state.copies, 1);
  assert.equal(state.commands.slice(commands).filter((line) => line.includes(' set ')).length, 0);
});

test('a user copy with a different version is replaced; the same version is kept', async () => {
  const { state, deps } = harness({
    files: { [`${BUNDLED}/metadata.json`]: meta(2), [`${USER_DIR}/metadata.json`]: meta(1), [`${USER_DIR}/extension.js`]: '//' },
    extensions: `['${GNOME_EXTENSION_UUID}']`,
  });
  await syncGnomeExtension(true, BUNDLED, deps);
  assert.equal(state.copies, 1);
  assert.equal(JSON.parse(state.files[`${USER_DIR}/metadata.json`]).version, 2);
  await syncGnomeExtension(true, BUNDLED, deps);
  assert.equal(state.copies, 1);
});

test('a system-wide copy (the .deb) is never copied over; it is only enabled', async () => {
  const { state, deps } = harness({ files: { [`${BUNDLED}/metadata.json`]: meta(1), [`${SYSTEM_DIR}/metadata.json`]: meta(1) } });
  await syncGnomeExtension(true, BUNDLED, deps);
  assert.equal(state.copies, 0);
  assert.ok(state.extensions.includes(GNOME_EXTENSION_UUID));
});

test('turning Computer Use off disables only our uuid and leaves the files', async () => {
  const { state, deps } = harness({
    files: { [`${BUNDLED}/metadata.json`]: meta(1), [`${USER_DIR}/metadata.json`]: meta(1) },
    extensions: `['dash-to-dock@x.com', '${GNOME_EXTENSION_UUID}']`,
  });
  await syncGnomeExtension(false, BUNDLED, deps);
  assert.equal(state.extensions, "['dash-to-dock@x.com']");
  assert.ok(`${USER_DIR}/metadata.json` in state.files);
  await syncGnomeExtension(false, BUNDLED, deps);
  assert.equal(state.commands.filter((line) => line.includes(' set ')).length, 1);
});

test('an empty gsettings list (@as []) is handled', async () => {
  const { state, deps } = harness({ files: { [`${BUNDLED}/metadata.json`]: meta(1) }, extensions: '@as []' });
  await syncGnomeExtension(true, BUNDLED, deps);
  assert.equal(state.extensions, `['${GNOME_EXTENSION_UUID}']`);
});

test('other platforms and desktops are untouched, and failures are logged without throwing', async () => {
  for (const options of [{ platform: 'win32' }, { desktop: 'KDE' }]) {
    const { state, deps } = harness({ files: { [`${BUNDLED}/metadata.json`]: meta(1) }, ...options });
    await syncGnomeExtension(true, BUNDLED, deps);
    assert.deepEqual(state.commands, []);
    assert.equal(state.copies, 0);
  }
  const failing = harness({ files: { [`${BUNDLED}/metadata.json`]: meta(1) }, failRun: true });
  await syncGnomeExtension(true, BUNDLED, failing.deps);
  assert.deepEqual(failing.state.logs, ['setup failed: gsettings: no schema']);
  const missing = harness({});
  await syncGnomeExtension(true, BUNDLED, missing.deps);
  assert.match(missing.state.logs[0], /bundled extension not found/);
});