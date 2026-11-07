#!/usr/bin/env node
// What Node's `createManagedWorktree` does when git's checkout add finds the worktree folder taken
// after the name was reserved: the REAL manager (src/runtime/shared/worktrees/manager.mjs) over a
// real git repository, with the registry's atomic rename hooked so a folder appears at the reserved
// path of the first N reserved records (another process taking the name). Recorded per scenario: the
// outcome (id, branch, or that it threw and git's "already exists"), the repository's `mixdog/*`
// branches, the registry's ids, and the number of worktrees git lists.
//   retry:        1 clash, a free-name request: reserves the next free name once and succeeds.
//   twice:        2 clashes: the retry fails too and the creation fails, rolled back.
//   exact-branch: 1 clash, a branch asked for by name: no retry, the creation fails.
// Rust `mixdog_scm::worktree::manager::Worktrees::create_full` must do the same.
//   node benchmarks/rust-core/recorders/record-worktree-add-retry.mjs [--tree <dir>]
// Output: native/core/fixtures/worktree-add-retry/golden.json.
process.env.TZ = 'UTC';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'worktree-add-retry');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-worktree-add-retry.mjs';
const at = (path) => import(pathToFileURL(join(tree, ...path.split('/'))).href);

let clashes = 0;
const taken = new Set();
const realRename = fsp.rename;
fsp.rename = async (from, to, ...rest) => {
  const done = await realRename(from, to, ...rest);
  if (clashes > 0 && basename(String(to)) === 'registry.json') {
    const doc = JSON.parse(readFileSync(to, 'utf8'));
    for (const record of Object.values(doc.entries ?? {})) {
      if (clashes > 0 && record.state === 'creating' && !taken.has(record.id)) {
        clashes -= 1;
        taken.add(record.id);
        mkdirSync(record.path, { recursive: true });
        writeFileSync(join(record.path, 'taken-by-another-process.txt'), 'x');
      }
    }
  }
  return done;
};
syncBuiltinESMExports();

const support = await at('src/runtime/shared/worktrees/test-support.mjs');
const manager = await at('src/runtime/shared/worktrees/manager.mjs');
const registry = await at('src/runtime/shared/worktrees/registry.mjs');
const restore = manager.configureWorktreeManager({ settings: { branchPrefix: support.TEST_BRANCH_PREFIX }, freeBytes: async () => Number.MAX_SAFE_INTEGER });

async function scenario(clash, extra) {
  const repo = support.makeRepo();
  support.useTempDataDir();
  taken.clear();
  clashes = clash;
  const ids = support.nextIds();
  let outcome;
  try {
    const entry = await manager.createManagedWorktree({ projectPath: repo, nameHint: 'Fix the login page', ...ids, ...extra });
    outcome = { created: true, id: entry.id, branch: entry.branch, state: entry.state };
  } catch (error) {
    outcome = { created: false, alreadyExists: /already exists|exists; cannot create/i.test(`${error?.stderr || ''}${error?.message || ''}`) };
  }
  clashes = 0;
  const doc = await registry.readRegistry();
  const heads = (prefix) => support.git(repo, 'for-each-ref', '--format=%(refname:short)', prefix).split('\n').filter(Boolean);
  return {
    outcome,
    branches: [...heads('refs/heads/mixdog/'), ...heads('refs/heads/feature/')].sort(),
    registryIds: Object.keys(doc.entries).sort(),
    worktrees: support.git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length,
  };
}

const golden = {
  retry: await scenario(1, {}),
  twice: await scenario(2, {}),
  exactBranch: await scenario(1, { branch: 'feature/login' }),
};
restore();
support.cleanupTempDirs();
writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'worktree-add-retry', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);