import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function canonicalCheckoutRoot(checkoutRoot, platform = process.platform) {
  let root = resolve(String(checkoutRoot || '.'));
  try {
    root = realpathSync.native?.(root) || realpathSync(root);
  } catch {
    // A missing checkout marker falls back to the installed runtime root.
  }
  root = root.replaceAll('\\', '/');
  return platform === 'win32' ? root.toLowerCase() : root;
}

/**
 * Development checkouts must not claim the installed app's machine-global
 * daemon. A stable checkout hash lets its CLI and unpackaged desktop share one
 * backend while keeping packaged/npm installations on the public root.
 */
export function resolveCheckoutRuntimeRoot(checkoutRoot, {
  env = process.env,
  tempRoot = tmpdir(),
  platform = process.platform,
} = {}) {
  const configured = String(env.MIXDOG_RUNTIME_ROOT || '').trim();
  if (configured) return resolve(configured);

  const stableRoot = join(tempRoot, 'mixdog');
  const canonicalRoot = canonicalCheckoutRoot(checkoutRoot, platform);
  if (!existsSync(join(canonicalRoot, '.git'))) return stableRoot;

  const checkoutId = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 12);
  return join(tempRoot, `mixdog-dev-${checkoutId}`);
}

export function configureCheckoutRuntimeRoot(checkoutRoot, options = {}) {
  const env = options.env || process.env;
  const configuredRuntimeRoot = String(env.MIXDOG_RUNTIME_ROOT || '').trim();
  const runtimeRoot = resolveCheckoutRuntimeRoot(checkoutRoot, { ...options, env });
  const installedRuntimeRoot = join(
    options.tempRoot || tmpdir(),
    'mixdog',
  );
  if (!configuredRuntimeRoot && runtimeRoot !== installedRuntimeRoot) {
    env.MIXDOG_RUNTIME_ROOT = runtimeRoot;
    // A second backend must never write the installed daemon's sessions,
    // memory database, or singleton owner records. Keep checkout state durable
    // but local; explicit data roots still win for controlled dev/test setups.
    if (!String(env.MIXDOG_DATA_DIR || '').trim()) {
      env.MIXDOG_DATA_DIR = join(resolve(String(checkoutRoot || '.')), '.mixdog', 'dev-data');
    }
  }
  return runtimeRoot;
}
