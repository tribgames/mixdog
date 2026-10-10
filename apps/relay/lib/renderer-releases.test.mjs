import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

import { startRelay } from '../server.mjs';
import { DeviceStore } from './device-store.mjs';
import { createRendererReadiness } from './renderer-readiness.mjs';
import {
  createRendererCatalog,
  parseReleaseIndex,
  planRetention,
  selectRelease,
} from './renderer-releases.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 1);
const entry = (id, desktopVersion, addedAt, extra = {}) => ({
  id,
  desktopVersion,
  shellVersion: '',
  addedAt,
  legacy: false,
  ...extra,
});
const legacyEntry = entry('legacy', '', 1, { legacy: true });
const registry = (...releases) => parseReleaseIndex({ schemaVersion: 1, releases });

test('selection: exact version, else newest compatible, else legacy', () => {
  const index = registry(legacyEntry, entry('r100', '1.0.0', 10), entry('r102', '1.0.2', 20), entry('r110', '1.1.0', 30));
  assert.equal(selectRelease(index, { appVersion: '1.0.2' }).id, 'r102');
  // No release for 1.0.5: the newest build that is not newer than the desktop.
  assert.equal(selectRelease(index, { appVersion: '1.0.5' }).id, 'r102');
  // A desktop newer than everything retained gets the newest release.
  assert.equal(selectRelease(index, { appVersion: '9.0.0' }).id, 'r110');
  // Older than every retained release, unparsable, or silent: legacy.
  assert.equal(selectRelease(index, { appVersion: '0.9.0' }).id, 'legacy');
  assert.equal(selectRelease(index, { appVersion: 'nightly' }).id, 'legacy');
  assert.equal(selectRelease(index, {}).id, 'legacy');
  assert.equal(selectRelease(index).id, 'legacy');
  // Same desktop version deployed twice: the later build wins.
  const rebuilt = registry(legacyEntry, entry('a', '1.0.2', 20), entry('b', '1.0.2', 25));
  assert.equal(selectRelease(rebuilt, { appVersion: '1.0.2' }).id, 'b');
});

test('selection: an exact renderer release id outranks the version, and no legacy means newest', () => {
  const pinned = 'c'.repeat(64);
  const index = registry(entry('old', '1.0.0', 10, { shellVersion: pinned }), entry('new', '1.1.0', 20));
  assert.equal(selectRelease(index, { appVersion: '1.1.0', rendererRelease: pinned }).id, 'old');
  assert.equal(selectRelease(index, {}).id, 'new');
});

test('retention keeps legacy, the newest N and releases recently-seen devices still use', () => {
  const index = registry(
    legacyEntry,
    entry('v1', '1.0.0', 10),
    entry('v2', '1.1.0', 20),
    entry('v3', '1.2.0', 30),
    entry('v4', '1.3.0', 40),
    entry('v5', '1.4.0', 50)
  );
  const options = { now: NOW, keepLatest: 2, maxRetained: 3 };
  const fresh = { appVersion: '1.0.0', seenAt: NOW - DAY };
  const stale = { appVersion: '1.1.0', seenAt: NOW - 90 * DAY };
  const plan = planRetention(index, [fresh, stale], options);
  // v4/v5 newest-2; v1 is pinned by a device seen yesterday; v2's only user
  // was last seen 90 days ago; v3 is nobody's.
  assert.deepEqual(plan.keep, ['legacy', 'v1', 'v4', 'v5']);
  assert.deepEqual(plan.drop, ['v2', 'v3']);
  // The retained count is bounded even when many old releases are in use.
  const crowded = ['1.0.0', '1.1.0', '1.2.0'].map((appVersion) => ({ appVersion, seenAt: NOW }));
  const bounded = planRetention(index, crowded, options);
  assert.equal(bounded.keep.filter((id) => id !== 'legacy').length, 3);
  assert.deepEqual(bounded.keep, ['legacy', 'v3', 'v4', 'v5']);
  // Without any registry pressure the legacy release is never collected.
  assert.deepEqual(planRetention(registry(legacyEntry), [], options), { keep: ['legacy'], drop: [] });
});

test('an invalid registry is rejected', () => {
  assert.throws(() => parseReleaseIndex({ schemaVersion: 1, releases: [entry('../x', '1.0.0', 1)] }), /id/);
  assert.throws(() => parseReleaseIndex({ schemaVersion: 1, releases: [entry('a', '', 1)] }), /desktop version/);
  assert.throws(
    () => parseReleaseIndex({ schemaVersion: 1, releases: [entry('a', '1.0.0', 1), entry('a', '1.0.1', 2)] }),
    /id/
  );
  assert.throws(() => parseReleaseIndex({ releases: [] }), /incompatible/);
});

test('the device store persists the reported version across restarts and rejects junk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-relay-version-store-'));
  try {
    const store = new DeviceStore(dir);
    const id = randomUUID();
    assert.equal(store.authenticate(id, 'secret-secret'), true);
    assert.deepEqual(store.deviceVersion(id), { appVersion: '', rendererRelease: '' });
    assert.equal(store.recordDesktopVersion(id, { appVersion: '../evil path' }), false);
    assert.equal(store.recordDesktopVersion(id, {}), false);
    assert.equal(store.recordDesktopVersion('not-a-device', { appVersion: '1.2.3' }), false);
    assert.equal(store.recordDesktopVersion(id, { appVersion: '1.2.3', rendererRelease: 'zz' }), true);
    assert.deepEqual(store.deviceVersion(id), { appVersion: '1.2.3', rendererRelease: '' });
    store.save();
    const reloaded = new DeviceStore(dir);
    assert.deepEqual(reloaded.deviceVersion(id), { appVersion: '1.2.3', rendererRelease: '' });
    assert.ok(reloaded.devices.get(id).versionSeenAt > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function shellDocument(label, shell) {
  return (
    '<!doctype html><head>' +
    `<meta name="mixdog-shell-version" content="${shell}">` +
    '<meta name="mixdog-shell-assets" content="assets/main-12345678.js">' +
    '<script type="module" src="./assets/main-12345678.js"></script>' +
    `</head><body>${label}</body>`
  );
}

async function writeRelease(root, label, shell = label.padEnd(64, 'a').replace(/[^a-f0-9]/g, 'b')) {
  await mkdir(join(root, 'assets'), { recursive: true });
  const files = {
    'index.html': shellDocument(label, shell),
    'assets/main-12345678.js': `export const label = '${label}';`,
    'boot.js': 'void 0;',
    'manifest.webmanifest': JSON.stringify({ start_url: '/', icons: [{ src: './icon.svg' }] }),
    'icon.svg': `<svg xmlns="http://www.w3.org/2000/svg"><title>${label}</title></svg>`,
    'sw.js': `// worker ${label}`,
  };
  for (const [name, body] of Object.entries(files)) await writeFile(join(root, name), body);
  return shell;
}

async function writeRegistry(releasesDir, releases) {
  await mkdir(releasesDir, { recursive: true });
  await writeFile(join(releasesDir, 'index.json'), JSON.stringify({ schemaVersion: 1, releases }));
}

async function releaseFixture() {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-relay-releases-'));
  const releasesDir = join(root, 'renderer-releases');
  const shells = {
    legacy: await writeRelease(join(releasesDir, 'legacy'), 'legacy'),
    new: await writeRelease(join(releasesDir, '2.0.0-new'), 'new'),
  };
  await writeRelease(join(root, 'renderer'), 'new', shells.new);
  await writeRegistry(releasesDir, [
    entry('legacy', '', 1, { legacy: true, shellVersion: shells.legacy }),
    entry('2.0.0-new', '2.0.0', 2, { shellVersion: shells.new }),
  ]);
  return { root, releasesDir, rendererDir: join(root, 'renderer'), shells };
}

async function connectDesktop(relay, deviceId, version) {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
    headers: { Authorization: `Basic ${Buffer.from(`${deviceId}:0123456789abcdef`).toString('base64')}` },
  });
  await once(ws, 'open');
  if (version) ws.send(JSON.stringify({ type: 'desktop-version', ...version }));
  return ws;
}

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('the relay serves each device the renderer release for its reported desktop version', async () => {
  const fixture = await releaseFixture();
  const dataDir = join(fixture.root, 'data');
  let relay = await startRelay({
    port: 0,
    dataDir,
    rendererDir: fixture.rendererDir,
    rendererReleasesDir: fixture.releasesDir,
  });
  const sockets = [];
  try {
    const modern = randomUUID();
    const silent = randomUUID();
    sockets.push(await connectDesktop(relay, modern, { appVersion: '2.0.0' }));
    sockets.push(await connectDesktop(relay, silent, null));
    await until(() => relay.store.deviceVersion(modern).appVersion === '2.0.0');
    const origin = `http://127.0.0.1:${relay.port}`;
    const page = async (id, path = '') => (await fetch(`${origin}/d/${id}/${path}`)).text();
    assert.match(await page(modern), /<body>new<\/body>/);
    // An old desktop never reports: it keeps the renderer that shipped before.
    assert.match(await page(silent), /<body>legacy<\/body>/);
    assert.match(await page(modern, 'icon.svg'), /<title>new<\/title>/);
    assert.match(await page(silent, 'icon.svg'), /<title>legacy<\/title>/);
    assert.match(await page(silent, 'assets/main-12345678.js'), /'legacy'/);

    // Root asset requests follow the device cookie to the same release.
    const cookie = `mixdog_device=${modern}`;
    const root = await fetch(`${origin}/sw.js`, { headers: { cookie } });
    assert.match(await root.text(), /worker new/);
    assert.match(root.headers.get('vary'), /Cookie/);
    const legacyRoot = await fetch(`${origin}/sw.js`, { headers: { cookie: `mixdog_device=${silent}` } });
    assert.match(await legacyRoot.text(), /worker legacy/);
    // Hashed assets are content-addressed and stay cacheable across releases.
    const hashed = await fetch(`${origin}/assets/main-12345678.js`, { headers: { cookie } });
    assert.doesNotMatch(hashed.headers.get('vary'), /Cookie/);
    assert.match(hashed.headers.get('cache-control'), /immutable/);
    // Service worker and shell never share a validator between releases.
    const etagNew = (await fetch(`${origin}/d/${modern}/sw.js`)).headers.get('etag');
    const etagOld = (await fetch(`${origin}/d/${silent}/sw.js`)).headers.get('etag');
    assert.notEqual(etagNew, etagOld);

    // The reported version is on disk: a restarted relay routes before the
    // desktop has redialed.
    for (const socket of sockets) socket.terminate();
    await relay.close();
    relay = await startRelay({
      port: 0,
      dataDir,
      rendererDir: fixture.rendererDir,
      rendererReleasesDir: fixture.releasesDir,
    });
    const restarted = `http://127.0.0.1:${relay.port}`;
    assert.match(await (await fetch(`${restarted}/d/${modern}/`)).text(), /<body>new<\/body>/);
    assert.match(await (await fetch(`${restarted}/d/${silent}/`)).text(), /<body>legacy<\/body>/);
    // A device's version is learned again when its desktop upgrades.
    const upgraded = await connectDesktop(relay, silent, { appVersion: '2.0.1' });
    sockets.push(upgraded);
    await until(() => relay.store.deviceVersion(silent).appVersion === '2.0.1');
    assert.match(await (await fetch(`${restarted}/d/${silent}/`)).text(), /<body>new<\/body>/);
    // Readiness reports every retained release.
    const ready = await (await fetch(`${restarted}/readyz`)).json();
    assert.deepEqual(
      ready.releases.map((release) => release.id),
      ['legacy', '2.0.0-new']
    );
  } finally {
    for (const socket of sockets) socket.terminate();
    await relay.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('without a registry the relay serves the single renderer to everyone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-relay-single-'));
  try {
    await writeRelease(join(root, 'renderer'), 'only');
    const catalog = createRendererCatalog({
      rendererDir: join(root, 'renderer'),
      releasesDir: join(root, 'renderer-releases'),
    });
    assert.equal(catalog.dirFor({ appVersion: '9.9.9' }), join(root, 'renderer'));
    // A registry naming a release whose files are gone falls back too.
    await writeRegistry(join(root, 'renderer-releases'), [entry('gone', '1.0.0', 1)]);
    const stale = createRendererCatalog({
      rendererDir: join(root, 'renderer'),
      releasesDir: join(root, 'renderer-releases'),
    });
    assert.equal(stale.dirFor({ appVersion: '1.0.0' }), join(root, 'renderer'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readiness fails when ANY retained release is broken', async () => {
  const fixture = await releaseFixture();
  try {
    let clock = 0;
    const read = createRendererReadiness(fixture.rendererDir, {
      releasesDir: fixture.releasesDir,
      cacheMs: 10,
      now: () => clock,
    });
    const healthy = read();
    assert.equal(healthy.statusCode, 200);
    assert.equal(healthy.body.releases.length, 2);
    // The current renderer is fine; only the legacy release loses an asset.
    await rm(join(fixture.releasesDir, 'legacy', 'assets', 'main-12345678.js'));
    clock += 11;
    assert.deepEqual(read(), { statusCode: 503, body: { status: 'not-ready' } });
    await writeFile(join(fixture.releasesDir, 'legacy', 'assets', 'main-12345678.js'), 'restored');
    clock += 11;
    assert.equal(read().statusCode, 200);
    // A registry entry whose tree is a different build is not ready either.
    const index = JSON.parse(await readFile(join(fixture.releasesDir, 'index.json'), 'utf8'));
    index.releases[0].shellVersion = 'd'.repeat(64);
    await writeFile(join(fixture.releasesDir, 'index.json'), JSON.stringify(index));
    clock += 11;
    assert.equal(read().statusCode, 503);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
