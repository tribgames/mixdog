import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const STRICT_VERSION = /^\d+\.\d+\.\d+$/;

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function protocolFromSource(source, label) {
  const value = Number(source.match(/ENGINE_DAEMON_PROTOCOL\s*=\s*(\d+)/)?.[1]);
  assert.ok(Number.isInteger(value) && value > 0, `${label} has no valid engine daemon protocol`);
  return value;
}

export function assertProtocolVersionDiscipline({
  currentVersion,
  releasedVersion,
  currentProtocol,
  releasedProtocol,
}) {
  assert.ok(compareVersions(currentVersion, releasedVersion) >= 0, 'workspace version cannot go backwards');
  if (currentProtocol === releasedProtocol) return;
  assert.ok(
    compareVersions(currentVersion, releasedVersion) > 0,
    `ENGINE_DAEMON_PROTOCOL changed ${releasedProtocol} -> ${currentProtocol}; `
      + `bump every app package above ${releasedVersion} before merging`,
  );
}

test('an engine daemon protocol change requires a pre-bumped application version', () => {
  assert.throws(
    () => assertProtocolVersionDiscipline({
      currentVersion: '1.2.3',
      releasedVersion: '1.2.3',
      currentProtocol: 4,
      releasedProtocol: 3,
    }),
    /bump every app package/,
  );
  assert.doesNotThrow(() => assertProtocolVersionDiscipline({
    currentVersion: '1.2.4',
    releasedVersion: '1.2.3',
    currentProtocol: 4,
    releasedProtocol: 3,
  }));
});

test('workspace versions stay synchronized and protocol skew is versioned before release', () => {
  const manifests = [
    'package.json',
    'package-lock.json',
    'apps/desktop/package.json',
    'apps/desktop/package-lock.json',
    'apps/mobile/package.json',
    'apps/mobile/package-lock.json',
    'apps/relay/package.json',
  ].map((relativePath) => ({
    relativePath,
    value: JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8')),
  }));
  const currentVersion = manifests[0].value.version;
  assert.match(currentVersion, STRICT_VERSION);
  for (const { relativePath, value } of manifests) {
    assert.equal(value.version, currentVersion, `${relativePath} version is not synchronized`);
    if (value.packages?.['']) {
      assert.equal(
        value.packages[''].version,
        currentVersion,
        `${relativePath} root lock package version is not synchronized`,
      );
    }
  }

  const tags = execFileSync('git', ['tag', '--list', 'v[0-9]*', '--sort=-v:refname'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim().split(/\r?\n/).filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  const releasedTag = tags.find((tag) => compareVersions(currentVersion, tag.slice(1)) >= 0);
  assert.ok(releasedTag, 'no application release tag is available for protocol comparison');
  const releasedVersion = releasedTag.slice(1);
  const protocolPath = 'src/standalone/engine-daemon-protocol.mjs';
  const currentProtocol = protocolFromSource(
    readFileSync(join(ROOT, protocolPath), 'utf8'),
    protocolPath,
  );
  const releasedProtocol = protocolFromSource(
    execFileSync('git', ['show', `${releasedTag}:${protocolPath}`], {
      cwd: ROOT,
      encoding: 'utf8',
    }),
    `${releasedTag}:${protocolPath}`,
  );
  assertProtocolVersionDiscipline({
    currentVersion,
    releasedVersion,
    currentProtocol,
    releasedProtocol,
  });
});
