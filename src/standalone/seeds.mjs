import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_DATA_FILES = [
  'user-workflow.json',
  'user-workflow.md',
];

export function ensureStandaloneEnvironment({ rootDir, dataDir }) {
  if (!rootDir) throw new Error('standalone rootDir is required');
  if (!dataDir) throw new Error('standalone dataDir is required');

  process.env.CLAUDE_PLUGIN_ROOT ??= rootDir;
  process.env.CLAUDE_PLUGIN_DATA ??= dataDir;
  process.env.MIXDOG_STANDALONE ??= '1';

  mkdirSync(dataDir, { recursive: true });
  for (const file of DEFAULT_DATA_FILES) {
    const from = join(rootDir, 'defaults', file);
    const to = join(dataDir, file);
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}
