#!/usr/bin/env node
// The refusals of Node's `inspectRepo` (src/runtime/shared/worktrees/git.mjs), the repository facts every managed
// worktree operation starts from: the REAL function over real folders. Recorded per scenario: the error's code, its
// message (the text the window shows) and its details, the folder's path replaced by `<folder>`.
//   missing:  a folder that is gone.
//   plain:    a folder that is not a repository.
//   bare:     a bare repository.
//   noCommit: a repository with no commit yet.
// Rust `mixdog_scm::worktree::manager::Worktrees::inspect_repo` must refuse with the same code, text and details.
//   node benchmarks/rust-core/recorders/record-worktree-inspect-repo.mjs [--tree <dir>]
// Output: native/core/fixtures/worktree-inspect-repo/golden.json.
process.env.TZ = 'UTC';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'worktree-inspect-repo');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-worktree-inspect-repo.mjs';
const at = (path) => import(pathToFileURL(join(tree, ...path.split('/'))).href);

const support = await at('src/runtime/shared/worktrees/test-support.mjs');
const { inspectRepo } = await at('src/runtime/shared/worktrees/git.mjs');

async function refusal(folder) {
  try {
    await inspectRepo(folder);
  } catch (error) {
    const details = JSON.parse(JSON.stringify(error.details ?? null));
    if (details?.projectPath !== undefined) {
      if (details.projectPath !== folder) throw new Error(`details.projectPath ${details.projectPath} is not ${folder}`);
      details.projectPath = '<folder>';
    }
    return { code: error.code, message: error.message, details };
  }
  throw new Error(`inspectRepo accepted ${folder}`);
}

const bare = support.tempDir('mixdog-wt-bare-');
support.git(bare, 'init', '-q', '--bare');
const golden = {
  missing: await refusal(join(support.tempDir('mixdog-wt-gone-'), 'gone')),
  plain: await refusal(support.tempDir('mixdog-wt-plain-')),
  bare: await refusal(bare),
  noCommit: await refusal(support.makeRepo({ commit: false })),
};
support.cleanupTempDirs();
writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'worktree-inspect-repo', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);