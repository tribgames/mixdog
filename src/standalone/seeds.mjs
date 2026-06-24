import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_DATA_FILES = [
  'user-workflow.json',
  'user-workflow.md',
];

const COMPACT_USER_WORKFLOW = `Default roles:
- worker: clear, scoped implementation.
- heavy-worker: vague, broad, or multi-file implementation.
- reviewer: verify diffs, behavior, regressions, and missing checks.
- debugger: diagnose unclear bugs; return cause, evidence, and fix scope.

Delegation:
- Lead handles small edits, config, git, and final integration directly.
- Use bridge workers for scoped implementation, review, or debugging when it
  reduces risk or parallelizes useful work.
- Review high-risk or cross-file changes before reporting done.
- If review changes the plan or scope, pause and ask the user.
`;

function maybeMigrateUserWorkflow(path) {
  if (!existsSync(path)) return;
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  const looksLikeOldDefault =
    text.includes('Who edits') &&
    text.includes('Cross-verification loop') &&
    text.includes('Fan-out (dispatching N agents');
  if (!looksLikeOldDefault || text === COMPACT_USER_WORKFLOW) return;
  writeFileSync(path, COMPACT_USER_WORKFLOW, 'utf8');
}

export function ensureStandaloneEnvironment({ rootDir, dataDir }) {
  if (!rootDir) throw new Error('standalone rootDir is required');
  if (!dataDir) throw new Error('standalone dataDir is required');

  process.env.CLAUDE_PLUGIN_ROOT ??= rootDir;
  process.env.CLAUDE_PLUGIN_DATA ??= dataDir;
  process.env.MIXDOG_STANDALONE ??= '1';
  process.env.MIXDOG_EMBED_WARMUP ??= '0';
  process.env.MIXDOG_QUIET_MEMORY_LOG ??= '1';

  mkdirSync(dataDir, { recursive: true });
  for (const file of DEFAULT_DATA_FILES) {
    const from = join(rootDir, 'defaults', file);
    const to = join(dataDir, file);
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  maybeMigrateUserWorkflow(join(dataDir, 'user-workflow.md'));
}
