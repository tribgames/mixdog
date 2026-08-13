import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureSpawnBinary, findCachedSpawnBinary } from './spawn-binary-fetcher.mjs';

test('spawn cache accepts only a manifest-pinned binary', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-spawn-cache-'));
  const bytes = Buffer.from('verified-spawn-fixture');
  const version = '1.2.3';
  const pkey = `${process.platform}-${process.arch}`;
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const manifest = {
    version,
    assets: {
      [pkey]: {
        url: `https://github.com/tribgames/mixdog/releases/download/spawn-v${version}/mixdog-spawn-${pkey}${suffix}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    },
  };
  try {
    const dir = join(root, 'spawn-bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `mixdog-spawn-${version}${suffix}`), bytes);
    assert.ok(findCachedSpawnBinary(root, { bundledManifest: manifest }));
    writeFileSync(join(dir, `mixdog-spawn-${version}${suffix}`), 'tampered');
    assert.equal(findCachedSpawnBinary(root, { bundledManifest: manifest }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('spawn bootstrap has no local-build or environment fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-spawn-bootstrap-'));
  try {
    await assert.rejects(
      ensureSpawnBinary(root, {
        bundledManifest: {
          version: '0.1.0',
          _comment: 'bootstrap',
          assets: {},
        },
      }),
      /No local-build or Node shell fallback is permitted/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
