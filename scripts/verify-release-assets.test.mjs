import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  validateGraphManifest,
  validatePatchManifest,
  validateRuntimeManifest,
  validateSpawnManifest,
  verifyAssetDownloads,
} from './verify-release-assets.mjs';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const TOOLS = 'src/runtime/agent/orchestrator/tools';

test('the bundled patch, graph, spawn and runtime manifests are what a release may ship', async () => {
  const [patch, graph, spawn, runtime, patchCargo, spawnCargo, pkg] = await Promise.all([
    read(`${TOOLS}/patch-manifest.json`),
    read(`${TOOLS}/graph-manifest.json`),
    read(`${TOOLS}/spawn-manifest.json`),
    read('src/runtime/memory/data/runtime-manifest.json'),
    read('native/mixdog-patch/Cargo.toml'),
    read('native/mixdog-spawn/Cargo.toml'),
    read('package.json'),
  ]);
  validatePatchManifest(JSON.parse(patch), patchCargo);
  validateGraphManifest(JSON.parse(graph), JSON.parse(pkg));
  validateSpawnManifest(JSON.parse(spawn), spawnCargo);
  validateRuntimeManifest(JSON.parse(runtime));
});

test('a manifest that points an asset away from its own release is refused', async () => {
  const manifest = JSON.parse(await read(`${TOOLS}/spawn-manifest.json`));
  const cargo = await read('native/mixdog-spawn/Cargo.toml');
  manifest.assets['linux-x64'].url = 'https://example.com/mixdog-spawn-linux-x64';
  assert.throws(() => validateSpawnManifest(manifest, cargo), /linux-x64: spawn asset URL must be/);
});

const body = (text) => ({ ok: true, status: 200, body: new Response(text).body });
const sha = (text) => createHash('sha256').update(text).digest('hex');

test('an asset is accepted only when the bytes that arrive have the manifest sha256', async () => {
  const fetchImpl = async () => body('payload');
  await verifyAssetDownloads({ a: { url: 'https://x/a', sha256: sha('payload') } }, { fetchImpl, attempts: 1 });
  await assert.rejects(
    verifyAssetDownloads({ a: { url: 'https://x/a', sha256: sha('other') } }, { fetchImpl, attempts: 1 }),
    /a: verification failed after 1 attempts: sha256 mismatch/,
  );
});