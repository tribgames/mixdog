import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeMacFeeds, parseMacFeed } from './merge-mac-update-feed.mjs';

// The exact shape electron-builder writes for one macOS build: zip first, the
// zip carrying the blockmap size the differential updater needs.
function builderFeed(arch, { version = '1.1.1', zipSha = `zip-${arch}==` } = {}) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: mixdog-desktop-mac-${arch}.zip`,
    `    sha512: ${zipSha}`,
    '    size: 111',
    '    blockMapSize: 22',
    `  - url: mixdog-desktop-mac-${arch}.dmg`,
    `    sha512: dmg-${arch}+/==`,
    '    size: 333',
    `path: mixdog-desktop-mac-${arch}.zip`,
    `sha512: ${zipSha}`,
    `releaseDate: '2025-01-0${arch === 'x64' ? 1 : 2}T00:00:00.000Z'`,
    '',
  ].join('\n');
}

const inputs = (...feeds) => feeds.map((text, index) => ({ label: `feed${index}`, text }));

test('the merged feed lists both zips and dmgs with their checksums, whatever the input order', () => {
  for (const order of [
    ['arm64', 'x64'],
    ['x64', 'arm64'],
  ]) {
    const merged = mergeMacFeeds(inputs(...order.map((arch) => builderFeed(arch))), '1.1.1');
    const feed = parseMacFeed(merged, 'merged');
    assert.equal(feed.version, '1.1.1');
    assert.deepEqual(
      feed.files.map((file) => file.url),
      [
        'mixdog-desktop-mac-arm64.zip',
        'mixdog-desktop-mac-arm64.dmg',
        'mixdog-desktop-mac-x64.zip',
        'mixdog-desktop-mac-x64.dmg',
      ]
    );
    assert.ok(merged.includes('    sha512: zip-arm64==\n    size: 111\n    blockMapSize: 22\n'));
    assert.ok(merged.includes('    sha512: zip-x64==\n    size: 111\n    blockMapSize: 22\n'));
    assert.ok(merged.includes('\npath: mixdog-desktop-mac-x64.zip\nsha512: zip-x64==\n'));
    assert.ok(merged.endsWith("releaseDate: '2025-01-01T00:00:00.000Z'\n"));
  }
});

test('a feed missing an architecture, or from the wrong version, fails the merge', () => {
  assert.throws(() => mergeMacFeeds(inputs(builderFeed('x64')), '1.1.1'), /Expected one feed per arm64 \+ x64/);
  assert.throws(
    () => mergeMacFeeds(inputs(builderFeed('x64'), builderFeed('x64')), '1.1.1'),
    /Expected one feed per arm64 \+ x64/
  );
  assert.throws(
    () => mergeMacFeeds(inputs(builderFeed('arm64'), builderFeed('x64', { version: '1.1.0' })), '1.1.1'),
    /version 1\.1\.0 is not 1\.1\.1/
  );
  assert.throws(
    () => mergeMacFeeds(inputs(builderFeed('arm64'), builderFeed('x64', { version: '1.1.0' }))),
    /Feed versions differ/
  );
});

test('a feed whose zip lacks a checksum or has an unknown shape is rejected', () => {
  const noSha = builderFeed('arm64').replace('    sha512: zip-arm64==\n', '');
  assert.throws(() => mergeMacFeeds(inputs(noSha, builderFeed('x64'))), /has no sha512/);
  assert.throws(() => parseMacFeed('version: 1.1.1\nfiles:\n- url: a.zip\n', 'odd'), /unsupported line/);
  assert.throws(() => parseMacFeed('version: 1.1.1\nfiles:\n', 'short'), /missing path/);
});
