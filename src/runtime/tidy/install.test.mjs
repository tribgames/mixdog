import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';

import { extractArchive, extractTarGz, extractZip, isNupkgMetadata, isSafeEntryPath, parseUstar } from './extract.mjs';
import {
  installEngine,
  installEngines,
  managedEngineBinary,
  manifestAsset,
  planInstall,
  platformAssetKey,
  readEnginesManifest,
  verifyDownloadDigest,
} from './install.mjs';

function workspace(t, prefix = 'tidy-install-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function tarEntry(name, content, { prefix = '', typeflag = '0' } = {}) {
  const body = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('000755 \0', 100, 8, 'utf8');
  header.write('0000000 \0', 108, 8, 'utf8');
  header.write('0000000 \0', 116, 8, 'utf8');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  header.write('00000000000 ', 136, 12, 'utf8');
  header.write('        ', 148, 8, 'utf8');
  header.write(typeflag, 156, 1, 'utf8');
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');
  if (prefix) header.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}

function tarball(entries) {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

function fakeFetch(buffer) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => '' },
    body: Readable.from([buffer]),
  });
}

test('sha256 verification accepts the manifest digest and rejects a tampered file', async (t) => {
  const root = workspace(t);
  const file = join(root, 'asset.bin');
  const payload = Buffer.from('managed engine payload');
  writeFileSync(file, payload);
  assert.equal(await verifyDownloadDigest(file, sha256(payload)), sha256(payload));
  await assert.rejects(() => verifyDownloadDigest(file, 'f'.repeat(64)), /sha256 mismatch/);
  await assert.rejects(() => verifyDownloadDigest(file, 'not-a-digest'), /64-hex digest/);
});

test('the ustar reader handles prefixes, long names, and rejects traversal', async (t) => {
  const root = workspace(t);
  const archive = join(root, 'engine.tar.gz');
  writeFileSync(
    archive,
    gzipSync(tarball([tarEntry('bin/engine', 'binary-bytes'), tarEntry('LICENSE', 'MIT', { prefix: 'engine-1.0.0' })]))
  );
  const written = extractTarGz(archive, join(root, 'out'));
  assert.deepEqual(written.sort(), ['bin/engine', 'engine-1.0.0/LICENSE']);
  assert.equal(readFileSync(join(root, 'out', 'bin', 'engine'), 'utf8'), 'binary-bytes');
  assert.equal(readFileSync(join(root, 'out', 'engine-1.0.0', 'LICENSE'), 'utf8'), 'MIT');

  const longNameTar = tarball([
    tarEntry('././@LongLink', 'deep/nested/engine-with-a-very-long-name\0', { typeflag: 'L' }),
    tarEntry('ignored', 'payload'),
  ]);
  const entries = parseUstar(longNameTar);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'deep/nested/engine-with-a-very-long-name');

  const evil = join(root, 'evil.tar.gz');
  writeFileSync(evil, gzipSync(tarball([tarEntry('../escaped', 'nope')])));
  assert.throws(() => extractTarGz(evil, join(root, 'out2')), /unsafe archive entry/);
  assert.equal(isSafeEntryPath('/abs'), false);
  assert.equal(isSafeEntryPath('C:/abs'), false);
  assert.equal(isSafeEntryPath('bin/engine'), true);
});

test('zip extraction round-trips through the existing jszip dependency', async (t) => {
  const root = workspace(t);
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('biome.exe', 'zip-binary-bytes');
  zip.folder('docs').file('README.md', '# readme');
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const archive = join(root, 'engine.zip');
  writeFileSync(archive, buffer);
  const written = await extractZip(archive, join(root, 'out'));
  assert.ok(written.includes('biome.exe'));
  assert.equal(readFileSync(join(root, 'out', 'biome.exe'), 'utf8'), 'zip-binary-bytes');
  assert.equal(readFileSync(join(root, 'out', 'docs', 'README.md'), 'utf8'), '# readme');
});

test('nupkg extraction strips NuGet metadata and keeps the module', async (t) => {
  const root = workspace(t);
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', 'ct');
  zip.file('_rels/.rels', 'rels');
  zip.file('package/services/metadata.psmdcp', 'meta');
  zip.file('PSScriptAnalyzer.nuspec', '<package/>');
  zip.file('.signature.p7s', 'sig');
  zip.file('PSScriptAnalyzer.psd1', '@{ ModuleVersion = "1.25.0" }');
  zip.file('PSScriptAnalyzer.psm1', 'function Invoke-Formatter {}');
  const archive = join(root, 'engine.nupkg');
  writeFileSync(archive, await zip.generateAsync({ type: 'nodebuffer' }));
  const dest = join(root, 'out');
  const written = await extractArchive({
    archive: 'nupkg',
    srcPath: archive,
    destDir: dest,
    binPath: 'PSScriptAnalyzer.psd1',
  });
  assert.ok(written.includes('PSScriptAnalyzer.psd1'));
  assert.ok(written.includes('PSScriptAnalyzer.psm1'));
  assert.ok(!written.some((name) => isNupkgMetadata(name)));
  assert.equal(existsSync(join(dest, '[Content_Types].xml')), false);
  assert.equal(existsSync(join(dest, '_rels', '.rels')), false);
  assert.equal(existsSync(join(dest, 'package', 'services', 'metadata.psmdcp')), false);
  assert.equal(existsSync(join(dest, 'PSScriptAnalyzer.nuspec')), false);
  assert.equal(readFileSync(join(dest, 'PSScriptAnalyzer.psd1'), 'utf8'), '@{ ModuleVersion = "1.25.0" }');
});

function manifestFor(id, { sha, archive = 'none', binPath = id, bytes = 0 } = {}) {
  return {
    version: 1,
    engines: {
      [id]: {
        version: '1.2.3',
        license: 'MIT',
        kind: ['format'],
        languages: ['bash'],
        source: 'mirror',
        assets: {
          [platformAssetKey()]: { url: 'https://example.invalid/asset', sha256: sha, archive, binPath, bytes },
        },
      },
    },
  };
}

test('policy gates every download decision before the network', () => {
  const manifest = manifestFor('shfmt', { sha: 'a'.repeat(64), bytes: 2048 });
  const base = { ids: ['shfmt'], manifest, pluginData: '/nowhere' };

  const ask = planInstall({ ...base, policy: 'ask' });
  assert.equal(ask.targets.length, 0);
  assert.deepEqual(ask.needsApproval.engines, [{ id: 'shfmt', version: '1.2.3', bytes: 2048, license: 'MIT' }]);
  assert.equal(ask.needsApproval.bytes, 2048);

  assert.equal(planInstall({ ...base, policy: 'ask', approveDownloads: true }).targets.length, 1);
  assert.equal(planInstall({ ...base, policy: 'auto' }).targets.length, 1);
  assert.equal(planInstall({ ...base }).targets.length, 1, 'default policy is auto');

  const never = planInstall({ ...base, policy: 'never' });
  assert.equal(never.targets.length, 0);
  assert.equal(never.needsApproval, null);
  assert.match(never.errors[0].error, /disabled by policy/);

  const toolchain = planInstall({ ids: ['rustfmt'], manifest, pluginData: '/nowhere', policy: 'auto' });
  assert.match(toolchain.errors[0].error, /toolchain engine/);
  assert.match(toolchain.errors[0].installHint, /rustup/);

  const unknown = planInstall({ ids: ['nope'], manifest, pluginData: '/nowhere', policy: 'auto' });
  assert.match(unknown.errors[0].error, /unknown engine/);

  const noAsset = planInstall({
    ids: ['shfmt'],
    manifest: { version: 1, engines: {} },
    pluginData: '/nowhere',
    policy: 'auto',
  });
  assert.match(noAsset.errors[0].error, /no .* asset in the engines manifest/);
});

test('install verifies, extracts, and lands the engine in its versioned dir', async (t) => {
  const root = workspace(t);
  const payload = Buffer.from('#!/bin/sh\necho shfmt\n');
  const manifest = manifestFor('shfmt', { sha: sha256(payload), archive: 'none', binPath: 'shfmt' });
  const target = planInstall({ ids: ['shfmt'], manifest, pluginData: root, policy: 'auto' }).targets[0];

  const installed = await installEngine(target, { pluginData: root, fetchFn: fakeFetch(payload) });
  assert.equal(installed.status, 'installed');
  assert.equal(installed.path, join(root, 'tools', 'shfmt', '1.2.3', 'shfmt'));
  assert.equal(readFileSync(installed.path, 'utf8'), payload.toString('utf8'));
  assert.equal(managedEngineBinary({ id: 'shfmt', manifest, pluginData: root }).version, '1.2.3');

  // A second install is a no-op, and no staging directory survives.
  const again = await installEngine(target, { pluginData: root, fetchFn: fakeFetch(payload) });
  assert.equal(again.status, 'present');
});

test('install reports per-engine download progress to its callback', async (t) => {
  const root = workspace(t);
  const payload = Buffer.from('#!/bin/sh\necho shfmt\n'.repeat(64));
  const manifest = manifestFor('shfmt', { sha: sha256(payload), archive: 'none', binPath: 'shfmt' });
  const progress = [];
  const outcome = await installEngines({
    ids: ['shfmt'],
    manifest,
    pluginData: root,
    policy: 'auto',
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? String(payload.length) : '') },
      body: Readable.from([payload.subarray(0, 100), payload.subarray(100)]),
    }),
    onProgress: (event) => progress.push(event),
  });
  assert.equal(outcome.installed[0].status, 'installed');
  assert.ok(progress.length > 0, 'the installer must report progress');
  for (const event of progress) {
    assert.equal(event.id, 'shfmt');
    assert.equal(event.totalBytes, payload.length);
    assert.ok(event.receivedBytes > 0 && event.receivedBytes <= payload.length);
  }
  assert.equal(progress.at(-1).receivedBytes, payload.length);
});

test('a digest mismatch aborts the install and leaves nothing behind', async (t) => {
  const root = workspace(t);
  const payload = Buffer.from('tampered');
  const manifest = manifestFor('shfmt', { sha: 'c'.repeat(64) });
  const outcome = await installEngines({
    ids: ['shfmt'],
    manifest,
    pluginData: root,
    policy: 'auto',
    fetchFn: fakeFetch(payload),
  });
  assert.deepEqual(outcome.installed, []);
  assert.match(outcome.errors[0].error, /sha256 mismatch/);
  assert.equal(existsSync(join(root, 'tools', 'shfmt', '1.2.3')), false);
});

test('an "ask" policy install returns the approval request without fetching', async (t) => {
  const root = workspace(t);
  let fetched = false;
  const manifest = manifestFor('shfmt', { sha: 'd'.repeat(64) });
  const outcome = await installEngines({
    ids: ['shfmt'],
    manifest,
    pluginData: root,
    policy: 'ask',
    fetchFn: async () => {
      fetched = true;
      throw new Error('must not fetch');
    },
  });
  assert.equal(fetched, false);
  assert.equal(outcome.needsApproval.engines[0].id, 'shfmt');
  assert.deepEqual(outcome.installed, []);
});

test('the manifest engines the catalog knows are installable by id', () => {
  const manifest = readEnginesManifest();
  for (const id of ['air', 'mago']) {
    if (!manifest.engines[id]?.assets?.[platformAssetKey()]) continue;
    const plan = planInstall({ ids: [id], manifest, pluginData: '/nowhere', policy: 'ask' });
    assert.deepEqual(plan.errors, [], `${id} must not be rejected as unknown`);
    assert.equal(plan.needsApproval.engines[0].id, id);
    assert.equal(planInstall({ ids: [id], manifest, pluginData: '/nowhere', policy: 'auto' }).targets.length, 1);
  }
});

test('the shipped engines manifest parses and keeps the documented schema', () => {
  const manifest = readEnginesManifest();
  assert.equal(manifest.version, 1);
  assert.equal(typeof manifest.engines, 'object');
  const ids = Object.keys(manifest.engines).sort();
  assert.deepEqual(ids, [
    'air',
    'biome',
    'clang-format',
    'dprint',
    'gofumpt',
    'mago',
    'psscriptanalyzer',
    'ruff',
    'shellcheck',
    'shfmt',
    'stylua',
  ]);
  assert.equal(ids.includes('ast-grep'), false);
  const pssa = manifestAsset(manifest, 'psscriptanalyzer');
  assert.equal(pssa.version, '1.25.0');
  assert.equal(pssa.pkey, 'any');
  assert.equal(pssa.asset.archive, 'nupkg');
  assert.equal(pssa.asset.binPath, 'PSScriptAnalyzer.psd1');
  assert.equal(pssa.asset.bytes, 14658674);
  assert.match(pssa.asset.url, /PSScriptAnalyzer\/1\.25\.0$/);
  for (const [id, entry] of Object.entries(manifest.engines)) {
    assert.ok(entry.version, `${id} needs a version`);
    assert.ok(Array.isArray(entry.languages), `${id} needs languages`);
    assert.ok(
      entry.assets && typeof entry.assets === 'object' && Object.keys(entry.assets).length > 0,
      `${id} needs platform assets`
    );
    for (const [pkey, asset] of Object.entries(entry.assets || {})) {
      assert.match(asset.sha256 || '', /^[a-f0-9]{64}$/i, `${id}/${pkey} needs a sha256`);
      assert.ok(asset.binPath, `${id}/${pkey} needs a binPath`);
    }
  }
  const missingDir = mkdtempSync(join(tmpdir(), 'tidy-manifest-'));
  mkdirSync(missingDir, { recursive: true });
  assert.deepEqual(readEnginesManifest(join(missingDir, 'nope.json')), { version: 1, engines: {} });
  rmSync(missingDir, { recursive: true, force: true });
});
