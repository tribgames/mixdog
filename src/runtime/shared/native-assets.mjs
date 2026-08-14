import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_NATIVE_ASSETS = Object.freeze(['graph', 'spawn', 'patch', 'token']);
export const SUPPORTED_NATIVE_PLATFORM_KEYS = Object.freeze([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
]);

const SOURCE_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE_DIRECTORIES = Object.freeze({
  graph: 'mixdog-graph',
  spawn: 'mixdog-spawn',
  patch: 'mixdog-patch',
  token: 'mixdog-token',
});

function assertKind(kind) {
  if (!REQUIRED_NATIVE_ASSETS.includes(kind)) {
    throw new TypeError(`Unknown Mixdog native asset: ${kind}`);
  }
}

export function nativePlatformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function nativePackageNameForPlatformKey(platformKey) {
  const packagePlatformKey = platformKey === 'win32-x64' ? 'windows-x64' : platformKey;
  return `mixdog-native-${packagePlatformKey}`;
}

export function nativePackageName(platform = process.platform, arch = process.arch) {
  return nativePackageNameForPlatformKey(nativePlatformKey(platform, arch));
}

export function nativeAssetFileName(kind, platform = process.platform) {
  assertKind(kind);
  if (kind === 'token') return 'mixdog-token.node';
  return `mixdog-${kind}${platform === 'win32' ? '.exe' : ''}`;
}

function realFilesystemPath(candidate) {
  if (!candidate) return null;
  const unpacked = candidate.replace(/\.asar([\\/])/i, '.asar.unpacked$1');
  if (unpacked !== candidate && existsSync(unpacked)) return unpacked;
  return existsSync(candidate) ? candidate : null;
}

export function localNativeAssetPath(kind, {
  root = SOURCE_ROOT,
  platform = process.platform,
} = {}) {
  assertKind(kind);
  const candidate = join(
    root,
    'native',
    SOURCE_DIRECTORIES[kind],
    'target',
    'release',
    nativeAssetFileName(kind, platform),
  );
  return realFilesystemPath(candidate);
}

export function installedNativeAssetPath(kind, {
  platform = process.platform,
  arch = process.arch,
  packageRoot = '',
  requireFrom = import.meta.url,
} = {}) {
  assertKind(kind);
  let root = String(packageRoot || '').trim();
  if (!root) {
    try {
      const require = createRequire(requireFrom);
      root = dirname(require.resolve(`${nativePackageName(platform, arch)}/native-manifest.json`));
    } catch {
      return null;
    }
  }
  return realFilesystemPath(join(root, 'bin', nativeAssetFileName(kind, platform)));
}

export function resolveNativeAssetPath(kind, options = {}) {
  return localNativeAssetPath(kind, options)
    || installedNativeAssetPath(kind, options)
    || null;
}

export function requiredNativeAssetPath(kind, options = {}) {
  const path = resolveNativeAssetPath(kind, options);
  if (path) return path;
  const key = nativePlatformKey(options.platform, options.arch);
  const error = new Error(
    `Required Mixdog native asset "${kind}" is missing for ${key}. `
    + `Reinstall Mixdog so ${nativePackageName(options.platform, options.arch)} is present.`,
  );
  error.code = 'MIXDOG_NATIVE_ASSET_MISSING';
  throw error;
}
