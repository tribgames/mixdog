import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test as nodeTest } from 'node:test';

import { requiredReviewSource } from './git-contract.mjs';
import { killProcessTrees, killProcessTreesSync } from '../../../../src/runtime/agent/orchestrator/mcp/child-tree.mjs';
import { buildGhPrCreateArgs } from './gh-cli.ts';
import {
  GIT_RESET_DIRTY_CODE,
  gitAmend,
  gitApplyPatch,
  gitBranches,
  gitCherryPickCommit,
  gitCommitPaths,
  gitContinue,
  gitCreateTag,
  gitDeleteBranch,
  gitDeleteTag,
  gitDiff,
  gitLog,
  gitAbortOperation,
  gitFetch,
  gitIgnore,
  gitPull,
  gitRenameBranch,
  gitReview,
  gitReviewDiff,
  gitReviewDiffs,
  gitResetToCommit,
  gitRevertCommit,
  gitRevertFile,
  gitShow,
  gitShowDiff,
  gitStage,
  gitStash,
  gitStashPop,
  gitStatus,
  gitSync,
  gitUndoLastCommit,
  gitUnstage,
} from './git-cli.ts';
import { splitGitPatchHunks } from '../shared/git-patch.ts';

import {
  applyPublishMode,
  assertCommitHooksRunnable,
  assertIndexLockFree,
  cacheHookRunnerSupport,
  chmodErrorIsIgnorable,
  commit,
  commitRefreshProbe,
  createRepository,
  executableHook,
  git,
  gitWithIndex,
  hostCountsAheadBehind,
  hookRunnerSupport,
  hostRunsCommitHooks,
  indexEntries,
  indexPublishMode,
  missingHookRunner,
  modeGrantsMoreThan,
  POSIX_ONLY,
  sharedRepositoryMode,
  writeHook,
  writeIndexBytes,
} from './git-cli.test-support.mjs';

// Every case below runs in ONE concurrent suite: each builds its own throwaway
// repository, so they overlap and the file costs its longest chain instead of
// the sum of its cases. A case that touches process-wide state (the
// commitRefreshProbe / hookRunnerSupport seams, process.env, the shared temp
// directory's scratch indexes) opts out with `{ exclusive: true }`: it is not
// registered here but in a serial suite after this one, so it never overlaps
// another case.
const exclusiveCases = [];

function test(name, options, run) {
  if (typeof options === 'function') return test(name, {}, options);
  const { exclusive = false, ...rest } = options;
  if (exclusive) exclusiveCases.push([name, rest, run]);
  else nodeTest(name, rest, run);
}
test('pull request creation builds the gh payload without a browser', () => {
  assert.deepEqual(
    buildGhPrCreateArgs({
      base: 'main',
      head: 'e2e-secondary',
      title: 'E2e secondary',
      body: '- Initial commit for E2E',
      draft: true,
    }),
    [
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      'e2e-secondary',
      '--title',
      'E2e secondary',
      '--body',
      '- Initial commit for E2E',
      '--draft',
    ]
  );
  assert.throws(
    () =>
      buildGhPrCreateArgs({
        base: 'main',
        head: 'main',
        title: 'Invalid',
      }),
    /must differ/
  );
  assert.throws(
    () =>
      buildGhPrCreateArgs({
        base: 'main',
        head: 'feature',
        title: 'Invalid',
        unexpected: true,
      }),
    /unsupported field/
  );
  assert.throws(
    () =>
      buildGhPrCreateArgs({
        base: 'main',
        head: 'feature',
        title: 'Invalid',
        body: { markdown: true },
      }),
    /body must be a string/
  );
});

describe('git cli, process-wide state', () => {
  for (const [name, options, run] of exclusiveCases) nodeTest(name, options, run);
});
