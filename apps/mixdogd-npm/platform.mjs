// Which platform package carries `mixdogd` for a machine. npm installs only the
// optional dependency whose `os`/`cpu` match, so exactly one of these exists.
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** `<process.platform>-<process.arch>` of every platform `mixdogd` is built for. */
export const PLATFORM_KEYS = Object.freeze(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']);

export const platformPackageName = (key) => `@mixdog/mixdogd-${key}`;

export const binaryFileName = (platform) => (platform === 'win32' ? 'mixdogd.exe' : 'mixdogd');

/** The installed `mixdogd` for this machine; throws naming what is missing. */
export function resolveMixdogd({
  platform = process.platform,
  arch = process.arch,
  resolvePackageJson = (name) => createRequire(import.meta.url).resolve(`${name}/package.json`),
} = {}) {
  const key = `${platform}-${arch}`;
  if (!PLATFORM_KEYS.includes(key)) {
    throw new Error(`Mixdog has no core for ${key}; supported: ${PLATFORM_KEYS.join(', ')}.`);
  }
  const name = platformPackageName(key);
  let manifest;
  try {
    manifest = resolvePackageJson(name);
  } catch {
    throw new Error(`${name} is not installed. Reinstall @mixdog/mixdogd without --omit=optional.`);
  }
  return join(manifest, '..', 'bin', binaryFileName(platform));
}
