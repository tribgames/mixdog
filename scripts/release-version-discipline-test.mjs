import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const STRICT_VERSION = /^\d+\.\d+\.\d+$/;

function protocolFromSource(source, label) {
  const value = Number(
    source.match(/SESSION_PROTOCOL\s*=\s*(\d+)/)?.[1],
  );
  assert.ok(Number.isInteger(value) && value > 0, `${label} has no valid session protocol`);
  return value;
}

test('workspace versions stay synchronized and the development protocol stays at 1', () => {
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

  const protocolPath = 'src/standalone/session-wire.mjs';
  const currentProtocol = protocolFromSource(
    readFileSync(join(ROOT, protocolPath), 'utf8'),
    protocolPath,
  );
  assert.equal(currentProtocol, 1);
});
