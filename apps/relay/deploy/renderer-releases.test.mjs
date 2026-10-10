import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { readReleaseIndex } from '../lib/renderer-releases.mjs';
import { linkTree, prepareReleases, readReportingDevices, releaseIdFor } from './renderer-releases.mjs';
import { verifyRelease } from './verify-release.mjs';

const tool = fileURLToPath(new URL('./renderer-releases.mjs', import.meta.url));
const DAY = 24 * 60 * 60 * 1000;

async function stagedRenderer(dir, label) {
  const shell = label.repeat(64).slice(0, 64);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'index.html'),
    `<!doctype html><meta name="mixdog-shell-version" content="${shell}"><body>${label}</body>`
  );
  await writeFile(join(dir, 'app.js'), `// ${label}`);
  return shell;
}

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-renderer-releases-'));
  return { root, releases: join(root, 'renderer-releases'), now: Date.UTC(2026, 0, 1) };
}

test('the first deploy adopts the installed renderer as legacy and adds the new one beside it', async () => {
  const { root, releases, now } = await sandbox();
  try {
    const installedShell = await stagedRenderer(join(root, 'installed'), 'a');
    const newShell = await stagedRenderer(join(root, 'next'), 'b');
    const result = prepareReleases({
      releasesDir: releases,
      rendererDir: join(root, 'next'),
      desktopVersion: '1.5.0',
      legacyDir: join(root, 'installed'),
      now,
    });
    const id = releaseIdFor('1.5.0', newShell);
    assert.deepEqual(result, { releaseId: id, added: true, legacy: 'legacy', kept: ['legacy', id], dropped: [] });
    assert.match(await readFile(join(releases, 'legacy', 'index.html'), 'utf8'), /<body>a<\/body>/);
    assert.match(await readFile(join(releases, id, 'index.html'), 'utf8'), /<body>b<\/body>/);
    const index = readReleaseIndex(releases);
    assert.equal(index.releases.find((entry) => entry.legacy).shellVersion, installedShell);
    // Releases are hardlinks of the staged tree: no second copy on disk.
    assert.equal((await stat(join(releases, id, 'app.js'))).ino, (await stat(join(root, 'next', 'app.js'))).ino);

    // Redeploying the same build is idempotent; a relay-only deploy (no
    // desktop version) registers nothing and keeps the registry.
    assert.equal(prepareReleases({ releasesDir: releases, rendererDir: join(root, 'next'), desktopVersion: '1.5.0', now }).added, false);
    const relayOnly = prepareReleases({ releasesDir: releases, rendererDir: join(root, 'next'), now });
    assert.deepEqual(relayOnly, { releaseId: '', added: false, legacy: 'legacy', kept: ['legacy', id], dropped: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('garbage collection applies the retention rule and spares the installed tree it was linked from', async () => {
  const { root, releases, now } = await sandbox();
  try {
    await stagedRenderer(join(root, 'installed'), 'a');
    const ids = [];
    for (const [step, label] of ['b', 'c', 'd', 'e', 'f'].entries()) {
      await stagedRenderer(join(root, 'stage', label), label);
      const result = prepareReleases({
        releasesDir: releases,
        rendererDir: join(root, 'stage', label),
        desktopVersion: `1.${step}.0`,
        legacyDir: join(root, 'installed'),
        now: now + step,
      });
      ids.push(result.releaseId);
    }
    // legacy + newest 3 survive; 1.0.0 and 1.1.0 were collected.
    assert.deepEqual((await readdir(releases)).sort(), ['index.json', 'legacy', ids[2], ids[3], ids[4]].sort());

    // A device seen recently on 1.2.0 pins that release even after it falls
    // out of the newest three; one unseen for months does not.
    await stagedRenderer(join(root, 'stage', '1'), '1');
    await stagedRenderer(join(root, 'stage', '2'), '2');
    const live = join(root, 'live', 'renderer-releases');
    linkTree(releases, live);
    const devices = [
      { appVersion: '1.2.0', rendererRelease: '', seenAt: now - DAY },
      { appVersion: '1.3.0', rendererRelease: '', seenAt: now - 90 * DAY },
    ];
    const deploy = (label, desktopVersion, offset) =>
      prepareReleases({
        releasesDir: live,
        rendererDir: join(root, 'stage', label),
        desktopVersion,
        devices,
        now: now + offset,
      });
    // 1.2.0 is no longer among the newest three, but a recent device uses it.
    assert.deepEqual(deploy('1', '1.8.0', 10).dropped, []);
    const result = deploy('2', '1.9.0', 11);
    assert.deepEqual(result.dropped, [ids[3]]);
    assert.ok(result.kept.includes(ids[2]));
    // The staged copy was collected; the installed registry it was cloned
    // from (what a rollback restores) is untouched.
    await assert.rejects(stat(join(live, ids[3])), { code: 'ENOENT' });
    assert.match(await readFile(join(releases, ids[3], 'index.html'), 'utf8'), /<body>e<\/body>/);
    assert.ok(readReleaseIndex(releases).releases.some((entry) => entry.id === ids[3]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unregistered leftovers from an interrupted run are collected, and bad input is refused', async () => {
  const { root, releases, now } = await sandbox();
  try {
    await stagedRenderer(join(root, 'next'), 'b');
    await stagedRenderer(join(releases, 'orphan'), 'c');
    const result = prepareReleases({ releasesDir: releases, rendererDir: join(root, 'next'), desktopVersion: '2.0.0', now });
    assert.deepEqual((await readdir(releases)).sort(), ['index.json', result.releaseId].sort());
    assert.throws(
      () => prepareReleases({ releasesDir: releases, rendererDir: join(root, 'next'), desktopVersion: '../x', now }),
      /desktop version/
    );
    await writeFile(join(root, 'next', 'index.html'), '<html>unversioned</html>');
    assert.throws(
      () => prepareReleases({ releasesDir: releases, rendererDir: join(root, 'next'), desktopVersion: '2.0.1', now }),
      /metadata missing/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the CLI reads reporting devices from devices.json and prints one JSON result', async () => {
  const { root, releases } = await sandbox();
  try {
    const shell = await stagedRenderer(join(root, 'next'), 'b');
    await writeFile(
      join(root, 'devices.json'),
      JSON.stringify({
        one: { appVersion: '1.0.0', versionSeenAt: 5 },
        silent: { secretHash: 'x' },
        bad: { appVersion: '1.0.0', versionSeenAt: 'yesterday' },
      })
    );
    assert.deepEqual(readReportingDevices(join(root, 'devices.json')), [
      { appVersion: '1.0.0', rendererRelease: '', seenAt: 5 },
    ]);
    assert.deepEqual(readReportingDevices(join(root, 'missing.json')), []);
    const run = spawnSync(
      process.execPath,
      [
        tool,
        '--action=prepare',
        `--releases=${releases}`,
        `--renderer=${join(root, 'next')}`,
        '--desktop-version=3.1.4',
        `--devices=${join(root, 'devices.json')}`,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).releaseId, releaseIdFor('3.1.4', shell));
    const failed = spawnSync(process.execPath, [tool, '--action=nope'], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Unknown renderer-releases action/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verification requires the added release among the retained ones', async () => {
  const expectedIndex = 'a'.repeat(64);
  const releases = [{ id: '1.0.0-aaa', indexSha256: expectedIndex }];
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(
        request.url === '/healthz'
          ? { status: 'ok' }
          : { status: 'ready', indexSha256: expectedIndex, version: 'b'.repeat(64), assets: 8, releases }
      )
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    // Past the release check the WebSocket gate is what stops this stub.
    await assert.rejects(
      verifyRelease({ origin, expectedIndex, expectedRelease: '1.0.0-aaa' }),
      (error) => !/side by side/.test(error.message)
    );
    await assert.rejects(verifyRelease({ origin, expectedIndex, expectedRelease: '9.9.9-zzz' }), /not served side by side/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
