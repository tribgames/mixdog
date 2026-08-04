import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ensurePatchBinary,
  findCachedPatchBinary,
} from '../src/runtime/agent/orchestrator/tools/patch-binary-fetcher.mjs';
import {
  ensureNativePatchBinaryAvailable,
  nativePatchBinPath,
} from '../src/runtime/agent/orchestrator/tools/patch/native-server.mjs';

const pkey = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`;
const suffix = process.platform === 'win32' ? '.exe' : '';

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

function makeManifest(version, body, url = `https://github.com/tribgames/mixdog/releases/download/patch-v${version}/mixdog-patch-${pkey}${suffix}`) {
  return {
    version,
    assets: { [pkey]: { url, sha256: sha256(body) } },
  };
}

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-patch-cache-'));
  const binDir = join(dataDir, 'patch-bin');
  mkdirSync(binDir, { recursive: true });
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return {
    dataDir,
    binDir,
    bin(version) {
      return join(binDir, `mixdog-patch-${version}${suffix}`);
    },
    localBin: join(dataDir, 'local-build', `mixdog-patch${suffix}`),
  };
}

function nativeOptions(f, bundledManifest, download) {
  return {
    dataDir: f.dataDir,
    defaultBin: f.localBin,
    fetcherOptions: { bundledManifest, download },
  };
}

test('stale cached manifest and binary cannot bypass native resolution', async (t) => {
  const f = fixture(t);
  const oldBody = Buffer.from('old binary');
  const bundledBody = Buffer.from('bundled binary');
  const bundledManifest = makeManifest('2.0.0', bundledBody);
  writeFileSync(join(f.binDir, 'manifest.json'), JSON.stringify(makeManifest('1.0.0', oldBody)));
  writeFileSync(f.bin('1.0.0'), oldBody);
  const options = nativeOptions(f, bundledManifest, async (_url, destination) => {
    writeFileSync(destination, bundledBody);
  });

  assert.equal(findCachedPatchBinary(f.dataDir, { bundledManifest }), null);
  assert.equal(nativePatchBinPath(options), f.localBin);
  assert.equal(await ensureNativePatchBinaryAvailable(options), f.bin('2.0.0'));
});

test('wrong-hash binary cannot bypass native resolution', async (t) => {
  const f = fixture(t);
  const expectedBody = Buffer.from('expected binary');
  const manifest = makeManifest('2.0.0', expectedBody);
  writeFileSync(f.bin('2.0.0'), 'wrong binary');
  const options = nativeOptions(f, manifest, async (_url, destination) => {
    writeFileSync(destination, expectedBody);
  });

  assert.equal(findCachedPatchBinary(f.dataDir, { bundledManifest: manifest }), null);
  assert.equal(nativePatchBinPath(options), f.localBin);
  assert.equal(await ensureNativePatchBinaryAvailable(options), f.bin('2.0.0'));
});

test('exact bundled filename with the correct hash is selected', (t) => {
  const f = fixture(t);
  const body = Buffer.from('correct binary');
  const manifest = makeManifest('2.0.0', body);
  writeFileSync(f.bin('2.0.0'), body);

  assert.equal(findCachedPatchBinary(f.dataDir, { bundledManifest: manifest }), f.bin('2.0.0'));
});

test('upgrade downloads the bundled version through the network-free seam', async (t) => {
  const f = fixture(t);
  const oldBody = Buffer.from('old binary');
  const newBody = Buffer.from('new binary');
  const oldManifest = makeManifest('1.0.0', oldBody);
  const bundledManifest = makeManifest('2.0.0', newBody);
  writeFileSync(join(f.binDir, 'manifest.json'), JSON.stringify(oldManifest));
  writeFileSync(f.bin('1.0.0'), oldBody);
  let downloads = 0;

  const selected = await ensurePatchBinary(f.dataDir, {
    bundledManifest,
    download: async (url, destination) => {
      downloads += 1;
      assert.equal(url, bundledManifest.assets[pkey].url);
      writeFileSync(destination, newBody);
    },
  });

  assert.equal(downloads, 1);
  assert.equal(selected, f.bin('2.0.0'));
  assert.equal(findCachedPatchBinary(f.dataDir, { bundledManifest }), selected);
});

test('only a trusted, strictly newer valid cached manifest may advance policy', (t) => {
  const f = fixture(t);
  const bundledBody = Buffer.from('bundled binary');
  const newerBody = Buffer.from('newer binary');
  const bundledManifest = makeManifest('2.0.0', bundledBody);
  const newerManifest = makeManifest('2.1.0', newerBody);
  writeFileSync(join(f.binDir, 'manifest.json'), JSON.stringify(newerManifest));
  writeFileSync(f.bin('2.1.0'), newerBody);
  assert.equal(findCachedPatchBinary(f.dataDir, { bundledManifest }), f.bin('2.1.0'));

  newerManifest.assets[pkey].url = 'https://example.com/untrusted';
  writeFileSync(join(f.binDir, 'manifest.json'), JSON.stringify(newerManifest));
  writeFileSync(f.bin('2.0.0'), bundledBody);
  assert.equal(findCachedPatchBinary(f.dataDir, { bundledManifest }), f.bin('2.0.0'));
});

test('equal-version cached manifest cannot replace bundled policy', (t) => {
  const f = fixture(t);
  const bundledBody = Buffer.from('bundled binary');
  const bundledManifest = makeManifest('2.0.0', bundledBody);
  const equalManifest = makeManifest('2.0.0', Buffer.from('different binary'));
  writeFileSync(join(f.binDir, 'manifest.json'), JSON.stringify(equalManifest));
  writeFileSync(f.bin('2.0.0'), bundledBody);

  assert.equal(findCachedPatchBinary(f.dataDir, { bundledManifest }), f.bin('2.0.0'));
});

for (const [label, badUrl] of [
  ['wrong release tag', `https://github.com/tribgames/mixdog/releases/download/patch-v9.9.9/mixdog-patch-${pkey}${suffix}`],
  ['wrong platform filename', `https://github.com/tribgames/mixdog/releases/download/patch-v2.1.0/mixdog-patch-wrong-platform${suffix}`],
]) {
  test(`newer cached manifest with ${label} cannot replace bundled policy`, (t) => {
    const f = fixture(t);
    const bundledBody = Buffer.from('bundled binary');
    const newerBody = Buffer.from('newer binary');
    const bundledManifest = makeManifest('2.0.0', bundledBody);
    const newerManifest = makeManifest('2.1.0', newerBody, badUrl);
    writeFileSync(join(f.binDir, 'manifest.json'), JSON.stringify(newerManifest));
    writeFileSync(f.bin('2.0.0'), bundledBody);
    writeFileSync(f.bin('2.1.0'), newerBody);

    assert.equal(findCachedPatchBinary(f.dataDir, { bundledManifest }), f.bin('2.0.0'));
  });
}

test('explicit native override and local cargo path retain precedence', (t) => {
  const f = fixture(t);
  const body = Buffer.from('cached binary');
  const bundledManifest = makeManifest('2.0.0', body);
  writeFileSync(f.bin('2.0.0'), body);
  mkdirSync(join(f.dataDir, 'local-build'), { recursive: true });
  writeFileSync(f.localBin, 'local binary');
  const options = nativeOptions(f, bundledManifest);

  assert.equal(nativePatchBinPath(options), f.localBin);
  const previous = process.env.MIXDOG_PATCH_NATIVE_BIN;
  process.env.MIXDOG_PATCH_NATIVE_BIN = join(f.dataDir, 'explicit-binary');
  try {
    assert.equal(nativePatchBinPath(options), process.env.MIXDOG_PATCH_NATIVE_BIN);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_PATCH_NATIVE_BIN;
    else process.env.MIXDOG_PATCH_NATIVE_BIN = previous;
  }
});
