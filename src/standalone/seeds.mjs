import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DEFAULT_DATA_FILES = [];
const DEFAULT_MIXDOG_MD = `# Mixdog Instructions

Use this file for Mixdog-specific user and project context.

- Keep stable preferences, workflow notes, and project conventions here.
- Mixdog loads this file as context for new sessions.
- Edit or replace this content at any time.
`;

const DEFAULT_PROJECT_MIXDOG_MD = `# Mixdog Instructions

Use this file for project-specific Mixdog context.

- Add stable project conventions, commands, and workflow notes here.
- Mixdog loads this file from the project root for new sessions.
- Edit or replace this content at any time.
`;

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasProjectSentinel(dir) {
  return existsSync(join(dir, '.git'))
    || existsSync(join(dir, 'package.json'))
    || existsSync(join(dir, 'pyproject.toml'))
    || existsSync(join(dir, 'Cargo.toml'))
    || existsSync(join(dir, 'go.mod'))
    || existsSync(join(dir, 'mixdog.md'))
    || existsSync(join(dir, 'Mixdog.md'))
    || existsSync(join(dir, 'AGENTS.md'));
}

function resolveProjectRoot(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  let cur;
  try {
    cur = resolve(cwd);
  } catch {
    return null;
  }
  if (!isDirectory(cur)) return null;
  while (true) {
    if (hasProjectSentinel(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

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
  const mixdogMdPath = join(dataDir, 'mixdog.md');
  if (!existsSync(mixdogMdPath)) {
    writeFileSync(mixdogMdPath, DEFAULT_MIXDOG_MD, { encoding: 'utf8', mode: 0o600 });
  }
  for (const file of DEFAULT_DATA_FILES) {
    const from = join(rootDir, 'defaults', file);
    const to = join(dataDir, file);
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

export function ensureProjectMixdogMd({ cwd } = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  if (!projectRoot) return null;
  const target = join(projectRoot, 'Mixdog.md');
  if (!existsSync(target)) {
    writeFileSync(target, DEFAULT_PROJECT_MIXDOG_MD, { encoding: 'utf8', mode: 0o600 });
  }
  return target;
}
