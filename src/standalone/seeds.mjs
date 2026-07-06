import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
  seedBundledSkills({ rootDir, dataDir });
}

// Copy skills bundled in the package (src/defaults/skills/<name>/) into the
// user data skills dir, but only when the target dir does not already exist —
// never overwrite user-owned skill dirs.
export function seedBundledSkills({ rootDir, dataDir }) {
  const bundledDir = join(rootDir, 'defaults', 'skills');
  if (!existsSync(bundledDir)) return;
  const targetRoot = join(dataDir, 'skills');
  let names;
  try {
    names = readdirSync(bundledDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const dest = join(targetRoot, entry.name);
    if (existsSync(dest)) continue;
    try {
      cpSync(join(bundledDir, entry.name), dest, { recursive: true });
    } catch {
      // best-effort seeding; ignore individual copy failures
    }
  }
}
