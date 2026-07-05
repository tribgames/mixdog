import { mkdirSync } from 'node:fs';

export function ensureStandaloneEnvironment({ rootDir, dataDir }) {
  if (!rootDir) throw new Error('standalone rootDir is required');
  if (!dataDir) throw new Error('standalone dataDir is required');

  // Standalone owns its roots. All default state is scoped to Mixdog's resource
  // root and data dir regardless of install location.
  process.env.MIXDOG_ROOT = rootDir;
  process.env.MIXDOG_DATA_DIR = dataDir;
  process.env.MIXDOG_STANDALONE ??= '1';
  process.env.MIXDOG_EMBED_WARMUP ??= '0';
  process.env.MIXDOG_QUIET_MEMORY_LOG ??= '1';
  process.env.MIXDOG_PATCH_NATIVE_PREWARM ??= '0';

  mkdirSync(dataDir, { recursive: true });
}
