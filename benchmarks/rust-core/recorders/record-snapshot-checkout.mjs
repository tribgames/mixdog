#!/usr/bin/env node
// What Node's `createSnapshotWorktree` leaves: the REAL manager (src/runtime/shared/worktrees/manager.mjs)
// over a real git repository. Recorded: the snapshot record's kind, state, `existingBranch`,
// `disposable` and resources ledger, the lock reason git lists for its checkout (the holder's session
// id replaced by <holder>), and the owner lease it wrote; then the same call with the owner-lease
// directory made unwritable: it fails and the rollback leaves no checkout, record or branch.
// Rust `Worktrees::snapshot_held` must leave the same.
//   node benchmarks/rust-core/recorders/record-snapshot-checkout.mjs [--tree <dir>]
// Output: native/core/fixtures/snapshot-checkout/golden.json.
process.env.TZ = 'UTC';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'snapshot-checkout');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-snapshot-checkout.mjs';
const at = (path) => import(pathToFileURL(join(tree, ...path.split('/'))).href);
const support = await at('src/runtime/shared/worktrees/test-support.mjs');
const manager = await at('src/runtime/shared/worktrees/manager.mjs');
const registry = await at('src/runtime/shared/worktrees/registry.mjs');
const owner = await at('src/runtime/shared/worktrees/owner.mjs');
const contract = await at('src/runtime/shared/worktrees/contract.mjs');
const paths = await at('src/runtime/shared/worktrees/paths.mjs');
const restore = manager.configureWorktreeManager({ settings: { branchPrefix: support.TEST_BRANCH_PREFIX }, freeBytes: async () => Number.MAX_SAFE_INTEGER });

const listing = (repo) => support.git(repo, 'worktree', 'list', '--porcelain').split('\n');
const worktreeCount = (repo) => listing(repo).filter((line) => line.startsWith('worktree ')).length;

// success
let repo = support.makeRepo();
support.useTempDataDir();
let ids = support.nextIds();
const entry = await manager.createSnapshotWorktree({ projectPath: repo, commit: 'HEAD', ...ids });
const record = await registry.getRecord(entry.id);
const lockLine = listing(repo).find((line) => line.startsWith('locked')) ?? '';
const lease = await owner.readOwnerLease(entry);
const created = {
  record: {
    kind: record.kind,
    state: record.state,
    existingBranch: record.existingBranch,
    disposable: record.disposable,
    ownerSessionId: record.ownerSessionId,
    holderIsTheSession: record.holderSessionId === ids.sessionId,
    resources: { worktree: record.resources.worktree, lock: record.resources.lock, owner: record.resources.owner },
  },
  lockReason: lockLine.replace(ids.sessionId, '<holder>'),
  lease: { sessionIsTheHolder: lease.sessionId === ids.sessionId, runtimeTokenIsTheHolders: lease.runtimeToken === ids.runtimeToken },
  worktrees: worktreeCount(repo),
};

// failure: the lease directory is a file
repo = support.makeRepo();
support.useTempDataDir();
ids = support.nextIds();
const commonDir = paths.canonicalPath(join(repo, '.git'));
const root = contract.managedWorktreeRoot(commonDir);
mkdirSync(root, { recursive: true });
writeFileSync(join(root, '.owners'), 'in the way');
let threw = false;
try {
  await manager.createSnapshotWorktree({ projectPath: repo, commit: 'HEAD', ...ids });
} catch {
  threw = true;
}
const failed = { threw, registryIds: Object.keys((await registry.readRegistry()).entries), worktrees: worktreeCount(repo) };

restore();
support.cleanupTempDirs();
writeJson(join(stage, 'golden.json'), { created, failed });
writeSetManifest(stage, { set: 'snapshot-checkout', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);