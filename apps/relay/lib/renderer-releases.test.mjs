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
  oldestSupportedVersion,
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

test('selection: a reported app version must match exactly', () => {
  const index = registry(
    legacyEntry,
    entry('r100', '1.0.0', 10),
    entry('r102', '1.0.2', 20),
    entry('r110', '1.1.0', 30)
  );
  assert.equal(selectRelease(index, { appVersion: '1.0.2' }).id, 'r102');
  for (const appVersion of ['1.0.5', '9.0.0', '0.9.0', 'nightly', '1.1.0+rebuild']) {
    assert.equal(selectRelease(index, { appVersion }), null, appVersion);
  }
  assert.equal(selectRelease(index, {}).id, 'legacy');
  assert.equal(selectRelease(index).id, 'legacy');
  // Same desktop version deployed twice: the later build wins.
  const rebuilt = registry(legacyEntry, entry('a', '1.0.2', 20), entry('b', '1.0.2', 25));
  assert.equal(selectRelease(rebuilt, { appVersion: '1.0.2' }).id, 'b');
});

test('selection: a shell hash pins a rebuild but never overrides a reported version', () => {
  const pinned = 'c'.repeat(64);
  const index = registry(entry('old', '1.0.0', 10, { shellVersion: pinned }), entry('new', '1.1.0', 20));
  assert.equal(selectRelease(index, { appVersion: '1.0.0', rendererRelease: pinned }).id, 'old');
  assert.equal(selectRelease(index, { appVersion: '1.1.0', rendererRelease: pinned }).id, 'new');
  assert.equal(selectRelease(index, { appVersion: '1.2.0', rendererRelease: pinned }), null);
  assert.equal(selectRelease(index, {}).id, 'new');
  const adopted = entry('legacy', '', 1, { legacy: true, shellVersion: pinned });
  assert.equal(selectRelease(registry(adopted), { appVersion: '0.9.0', rendererRelease: pinned }).id, 'legacy');
  assert.equal(
    selectRelease(registry(adopted, ...index.releases), { appVersion: '0.9.0', rendererRelease: pinned }),
    null
  );
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

async function withRelay(run) {
  const fixture = await releaseFixture();
  const options = {
    port: 0,
    dataDir: join(fixture.root, 'data'),
    rendererDir: fixture.rendererDir,
    rendererReleasesDir: fixture.releasesDir,
  };
  const sockets = [];
  const context = { fixture, relay: await startRelay(options) };
  context.origin = () => `http://127.0.0.1:${context.relay.port}`;
  context.connect = async (version) => {
    const id = randomUUID();
    sockets.push(await connectDesktop(context.relay, id, version));
    if (version?.appVersion) await until(() => context.relay.store.deviceVersion(id).appVersion === version.appVersion);
    return id;
  };
  context.restart = async () => {
    for (const socket of sockets) socket.terminate();
    await context.relay.close();
    context.relay = await startRelay(options);
  };
  try {
    await run(context);
  } finally {
    for (const socket of sockets) socket.terminate();
    await context.relay.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
}

const pageOf = async (origin, id, path = '') => (await fetch(`${origin}/d/${id}/${path}`)).text();

test('the relay serves each device the renderer release for its reported desktop version', () =>
  withRelay(async ({ connect, origin }) => {
    const modern = await connect({ appVersion: '2.0.0' });
    const silent = await connect(null);
    assert.match(await pageOf(origin(), modern), /<body>new<\/body>/);
    // An old desktop never reports: it keeps the renderer that shipped before.
    assert.match(await pageOf(origin(), silent), /<body>legacy<\/body>/);
    assert.match(await pageOf(origin(), modern, 'icon.svg'), /<title>new<\/title>/);
    assert.match(await pageOf(origin(), silent, 'icon.svg'), /<title>legacy<\/title>/);
    assert.match(await pageOf(origin(), silent, 'assets/main-12345678.js'), /'legacy'/);
  }));

test('root asset requests follow the device cookie to the same release', () =>
  withRelay(async ({ connect, origin }) => {
    const modern = await connect({ appVersion: '2.0.0' });
    const silent = await connect(null);
    const root = await fetch(`${origin()}/sw.js`, { headers: { cookie: `mixdog_device=${modern}` } });
    assert.match(await root.text(), /worker new/);
    assert.match(root.headers.get('vary'), /Cookie/);
    const legacyRoot = await fetch(`${origin()}/sw.js`, { headers: { cookie: `mixdog_device=${silent}` } });
    assert.match(await legacyRoot.text(), /worker legacy/);
  }));

test('hashed assets are content-addressed and stay cacheable across releases', () =>
  withRelay(async ({ connect, origin }) => {
    const modern = await connect({ appVersion: '2.0.0' });
    const hashed = await fetch(`${origin()}/assets/main-12345678.js`, {
      headers: { cookie: `mixdog_device=${modern}` },
    });
    assert.doesNotMatch(hashed.headers.get('vary'), /Cookie/);
    assert.match(hashed.headers.get('cache-control'), /immutable/);
  }));

test('the service worker never shares a validator between releases', () =>
  withRelay(async ({ connect, origin }) => {
    const modern = await connect({ appVersion: '2.0.0' });
    const silent = await connect(null);
    const etagNew = (await fetch(`${origin()}/d/${modern}/sw.js`)).headers.get('etag');
    const etagOld = (await fetch(`${origin()}/d/${silent}/sw.js`)).headers.get('etag');
    assert.notEqual(etagNew, etagOld);
  }));

test('a restarted relay routes by the persisted version before the desktop redials', () =>
  withRelay(async ({ connect, origin, restart }) => {
    const modern = await connect({ appVersion: '2.0.0' });
    const silent = await connect(null);
    await restart();
    assert.match(await pageOf(origin(), modern), /<body>new<\/body>/);
    assert.match(await pageOf(origin(), silent), /<body>legacy<\/body>/);
  }));

test('a device version is learned again when its desktop upgrades', () =>
  withRelay(async ({ fixture, connect, origin }) => {
    const upgraded = await connect({ appVersion: '2.0.1', rendererRelease: fixture.shells.new });
    const pending = await fetch(`${origin()}/d/${upgraded}/`, { headers: { 'user-agent': 'MixdogApp/1.4.0' } });
    assert.equal(pending.status, 200);
    assert.equal(pending.headers.get('cache-control'), 'no-store');
    assert.match(await pending.text(), /web client for this PC version is unavailable/);
  }));

test('readiness reports every retained release', () =>
  withRelay(async ({ origin }) => {
    const ready = await (await fetch(`${origin()}/readyz`)).json();
    assert.deepEqual(
      ready.releases.map((release) => release.id),
      ['legacy', '2.0.0-new']
    );
  }));

const appUa = { 'user-agent': 'Mozilla/5.0 (iPhone) MixdogApp/1.4.0' };
const browserUa = { 'user-agent': 'Mozilla/5.0 (iPhone) Safari/605.1.15' };

test('the phone app gets the update-PC page instead of the legacy renderer for an unsupported desktop', () =>
  withRelay(async ({ connect, origin }) => {
    const stale = await connect({ appVersion: '1.0.0' });
    const update = await fetch(`${origin()}/d/${stale}/`, { headers: appUa });
    const html = await update.text();
    assert.equal(update.status, 200);
    assert.equal(update.headers.get('cache-control'), 'no-store');
    assert.match(update.headers.get('content-security-policy'), /script-src 'unsafe-inline'/);
    assert.match(html, /Update Mixdog on your PC/);
    assert.match(html, /data-current="1\.0\.0" data-min="2\.0\.0"/);
    assert.doesNotMatch(html, /<body>legacy<\/body>/);
    assert.match(html, /openHostPicker/);
    assert.match(html, /location\.reload\(\)/);
  }));

test('a PC that never reported a version is unknown, not blank', () =>
  withRelay(async ({ connect, origin }) => {
    const silent = await connect(null);
    const unknown = await (await fetch(`${origin()}/d/${silent}/`, { headers: appUa })).text();
    assert.match(unknown, /data-current="" data-min="2\.0\.0"/);
    assert.match(unknown, /PC version unknown/);
    assert.match(unknown, /PC 버전 알 수 없음/);
  }));

test('an extension-less deep link is the SPA index document too', () =>
  withRelay(async ({ connect, origin }) => {
    const stale = await connect({ appVersion: '1.0.0' });
    assert.match(
      await (await fetch(`${origin()}/d/${stale}/some/deep/link`, { headers: appUa })).text(),
      /Update Mixdog on your PC/
    );
    assert.match(
      await (await fetch(`${origin()}/d/${stale}/some/deep/link`, { headers: browserUa })).text(),
      /Web client unavailable/
    );
  }));

test('the update page is only for a top-level document', () =>
  withRelay(async ({ connect, origin }) => {
    const stale = await connect({ appVersion: '1.0.0' });
    const get = (headers) => fetch(`${origin()}/d/${stale}/`, { headers: { ...appUa, ...headers } });
    for (const dest of ['empty', 'iframe']) {
      assert.match(await (await get({ 'sec-fetch-dest': dest })).text(), /Web client unavailable/, dest);
    }
    assert.match(await (await get({ 'sec-fetch-dest': 'document' })).text(), /Update Mixdog on your PC/);
  }));

test('a supported or unidentified old PC still loads its shell, an unmatched one gets no private assets', () =>
  withRelay(async ({ connect, origin }) => {
    const stale = await connect({ appVersion: '1.0.0' });
    const silent = await connect(null);
    const modern = await connect({ appVersion: '2.0.0' });
    const get = (id, path, headers) => fetch(`${origin()}/d/${id}/${path}`, { headers });
    assert.match(await (await get(modern, '', appUa)).text(), /<body>new<\/body>/);
    assert.match(await (await get(silent, '', browserUa)).text(), /<body>legacy<\/body>/);
    assert.equal((await get(stale, 'assets/main-12345678.js', appUa)).status, 404);
  }));

test('the update page escapes the versions it prints', async () => {
  const { renderUpdatePcPage } = await import('./update-pc-page.mjs');
  const html = renderUpdatePcPage({ current: '"><script>x</script>', min: "1'&2" });
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /data-current="&#34;&#62;&#60;script&#62;x&#60;\/script&#62;"/);
  assert.match(html, /data-min="1&#39;&#38;2"/);
});

test('oldest supported version is the lowest retained non-legacy desktop version', () => {
  const index = registry(legacyEntry, entry('b', '1.10.0', 2), entry('a', '1.2.4', 1), entry('c', '1.3.2', 3));
  assert.equal(oldestSupportedVersion(index), '1.2.4');
  assert.equal(oldestSupportedVersion(registry(legacyEntry)), '');
});

test('only an absent registry enables single-renderer mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-relay-single-'));
  try {
    await writeRelease(join(root, 'renderer'), 'only');
    const catalog = createRendererCatalog({
      rendererDir: join(root, 'renderer'),
      releasesDir: join(root, 'renderer-releases'),
    });
    assert.equal(catalog.dirFor({ appVersion: '9.9.9' }), join(root, 'renderer'));
    // An incomplete retained tree must not fall back to a different release.
    await writeRegistry(join(root, 'renderer-releases'), [entry('gone', '1.0.0', 1)]);
    const stale = createRendererCatalog({
      rendererDir: join(root, 'renderer'),
      releasesDir: join(root, 'renderer-releases'),
    });
    assert.equal(stale.dirFor({ appVersion: '1.0.0' }), null);
    await writeFile(join(root, 'renderer-releases', 'index.json'), '{broken');
    const broken = createRendererCatalog({
      rendererDir: join(root, 'renderer'),
      releasesDir: join(root, 'renderer-releases'),
    });
    assert.equal(broken.dirFor({ appVersion: '1.0.0' }), null);
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
