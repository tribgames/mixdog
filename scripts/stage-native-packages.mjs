import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_NATIVE_BINARY_DOWNLOAD_BYTES,
  streamResponseToFile,
} from '../src/runtime/shared/bounded-download.mjs';
import {
  REQUIRED_NATIVE_ASSETS,
  SUPPORTED_NATIVE_PLATFORM_KEYS,
  nativeAssetFileName,
  nativePackageNameForPlatformKey,
} from '../src/runtime/shared/native-assets.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST_PATHS = Object.freeze({
  graph: join(ROOT, 'src/runtime/agent/orchestrator/tools/graph-manifest.json'),
  spawn: join(ROOT, 'src/runtime/agent/orchestrator/tools/spawn-manifest.json'),
  patch: join(ROOT, 'src/runtime/agent/orchestrator/tools/patch-manifest.json'),
  token: join(ROOT, 'src/runtime/agent/orchestrator/tools/token-manifest.json'),
});
const STRICT_VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;

function platformParts(platformKey) {
  const split = platformKey.lastIndexOf('-');
  if (split <= 0) throw new Error(`Invalid native platform key: ${platformKey}`);
  return {
    platform: platformKey.slice(0, split),
    arch: platformKey.slice(split + 1),
  };
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function downloadAsset(url, destination) {
  const parsed = new URL(url);
  if (parsed.protocol === 'file:') {
    await copyFile(fileURLToPath(parsed), destination);
    return;
  }
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await streamResponseToFile(response, destination, {
        maxBytes: MAX_NATIVE_BINARY_DOWNLOAD_BYTES,
        label: `native package asset ${url}`,
      });
      return;
    } catch (error) {
      lastError = error;
      await rm(destination, { force: true });
      if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 500));
    }
  }
  throw new Error(`Unable to download ${url}: ${lastError?.message || lastError}`);
}

async function cachedAsset(asset, cacheDir) {
  if (!asset?.url || !SHA256.test(String(asset.sha256 || ''))) {
    throw new Error(`Invalid immutable native asset: ${JSON.stringify(asset)}`);
  }
  const expected = asset.sha256.toLowerCase();
  const destination = join(cacheDir, expected);
  try {
    if (await sha256File(destination) === expected) return destination;
  } catch {}
  await mkdir(cacheDir, { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    await downloadAsset(asset.url, temporary);
    const actual = await sha256File(temporary);
    if (actual !== expected) {
      throw new Error(`sha256 mismatch: expected ${expected}, got ${actual}`);
    }
    await rm(destination, { force: true });
    await rename(temporary, destination);
    return destination;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function verifyNativePackageDirectory(packageDir, {
  expectedPlatformKey = '',
} = {}) {
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(packageDir, 'native-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !SUPPORTED_NATIVE_PLATFORM_KEYS.includes(manifest.platformKey)) {
    throw new Error(`Invalid native package manifest in ${packageDir}`);
  }
  if (expectedPlatformKey && manifest.platformKey !== expectedPlatformKey) {
    throw new Error(`Native package platform mismatch: ${manifest.platformKey} != ${expectedPlatformKey}`);
  }
  if (packageJson.name !== nativePackageNameForPlatformKey(manifest.platformKey)
      || packageJson.version !== manifest.packageVersion) {
    throw new Error(`Native package identity mismatch in ${packageDir}`);
  }
  for (const kind of REQUIRED_NATIVE_ASSETS) {
    const entry = manifest.assets?.[kind];
    if (!entry || !/^bin\/[^/]+$/.test(String(entry.file || '')) || !SHA256.test(String(entry.sha256 || ''))) {
      throw new Error(`Invalid ${kind} entry in ${packageDir}`);
    }
    const path = join(packageDir, ...entry.file.split('/'));
    const actual = await sha256File(path);
    if (actual !== entry.sha256) throw new Error(`${kind} sha256 mismatch in ${packageDir}`);
    if (process.platform !== 'win32' && manifest.platform !== 'win32' && kind !== 'token') {
      const metadata = await stat(path);
      if ((metadata.mode & 0o111) === 0) throw new Error(`${kind} is not executable in ${packageDir}`);
    }
  }
  return { packageJson, manifest };
}

export async function stageNativePackages({
  version,
  outputDir,
  cacheDir,
  platformKeys = SUPPORTED_NATIVE_PLATFORM_KEYS,
  manifestPaths = DEFAULT_MANIFEST_PATHS,
} = {}) {
  if (!STRICT_VERSION.test(String(version || ''))) throw new Error(`Invalid package version: ${version}`);
  const output = resolve(outputDir);
  const cache = resolve(cacheDir);
  if (output === ROOT || output === dirname(ROOT)) throw new Error(`Unsafe native package output: ${output}`);
  const manifests = Object.fromEntries(await Promise.all(
    REQUIRED_NATIVE_ASSETS.map(async (kind) => [
      kind,
      JSON.parse(await readFile(manifestPaths[kind], 'utf8')),
    ]),
  ));
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const packages = [];
  for (const platformKey of platformKeys) {
    if (!SUPPORTED_NATIVE_PLATFORM_KEYS.includes(platformKey)) {
      throw new Error(`Unsupported native platform key: ${platformKey}`);
    }
    const { platform, arch } = platformParts(platformKey);
    const directory = join(output, nativePackageNameForPlatformKey(platformKey));
    const binDir = join(directory, 'bin');
    await mkdir(binDir, { recursive: true });
    const assets = {};
    for (const kind of REQUIRED_NATIVE_ASSETS) {
      const sourceManifest = manifests[kind];
      const sourceAsset = sourceManifest.assets?.[platformKey];
      const cached = await cachedAsset(sourceAsset, cache);
      const file = `bin/${nativeAssetFileName(kind, platform)}`;
      const destination = join(directory, ...file.split('/'));
      await copyFile(cached, destination);
      if (platform !== 'win32' && kind !== 'token') await chmod(destination, 0o755);
      assets[kind] = {
        file,
        sha256: sourceAsset.sha256.toLowerCase(),
        componentVersion: String(sourceManifest.version),
      };
    }
    const manifest = {
      schemaVersion: 1,
      packageVersion: version,
      platformKey,
      platform,
      arch,
      assets,
    };
    const packageJson = {
      name: nativePackageNameForPlatformKey(platformKey),
      version,
      description: `Required Mixdog native runtime assets for ${platformKey}`,
      license: 'MIT',
      repository: {
        type: 'git',
        url: 'git+https://github.com/tribgames/mixdog.git',
      },
      os: [platform],
      cpu: [arch],
      files: ['bin/', 'native-manifest.json', 'LICENSE'],
      exports: {
        './native-manifest.json': './native-manifest.json',
        './package.json': './package.json',
        './graph': `./${assets.graph.file}`,
        './spawn': `./${assets.spawn.file}`,
        './patch': `./${assets.patch.file}`,
        './token': `./${assets.token.file}`,
      },
    };
    await Promise.all([
      writeFile(join(directory, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`),
      writeFile(join(directory, 'native-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
      copyFile(join(ROOT, 'LICENSE'), join(directory, 'LICENSE')),
    ]);
    await verifyNativePackageDirectory(directory, { expectedPlatformKey: platformKey });
    packages.push(directory);
  }
  return packages;
}

function valueFor(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) || '';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = valueFor('version');
  const outputDir = valueFor('output') || join(ROOT, 'dist/native-packages');
  const cacheDir = valueFor('cache') || join(ROOT, '.cache/native-packages');
  const selected = valueFor('platform-key');
  const packages = await stageNativePackages({
    version,
    outputDir,
    cacheDir,
    platformKeys: selected ? [selected] : SUPPORTED_NATIVE_PLATFORM_KEYS,
  });
  process.stdout.write(`${JSON.stringify({ version, packages })}\n`);
}
