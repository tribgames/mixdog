#!/usr/bin/env node
// Genuine 1.4.5 workspace actions of the thread/* SCM methods over a real fixture repository:
// Node's own createWorkspaceTransitions (getBranchMenu, requestWorktree, selectBranch,
// mergeWorkspace, getSessionWorktreeWork) and turn-snapshot (revertTurnChanges,
// reapplyTurnChanges) against real git and the real managed-worktree backend. The Rust
// ThreadScmService replays the same steps over its own fixture repository and must answer the
// same values once temp paths, commit ids, times and generated ids are masked the same way.
//
//   node benchmarks/rust-core/recorders/record-thread-scm.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/thread-scm/golden.json
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'thread-scm-')));
process.env.MIXDOG_DATA_DIR = join(base, 'data');
process.on('exit', () => rmSync(base, { recursive: true, force: true }));

const { configureWorktreeManager } = await importFrom(tree, 'src/runtime/shared/worktrees/manager.mjs');
const { samePath } = await importFrom(tree, 'src/runtime/shared/worktrees/paths.mjs');
const { createWorkspaceTransitions } = await importFrom(tree, 'src/session-runtime/workspace/transitions.mjs');
const snapshot = await importFrom(tree, 'src/runtime/shared/turn-snapshot.mjs');
const { registerEditToolUiDiff } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/patch/ui-diff.mjs');

function git(cwd, ...a) {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function seedRepo(name, files) {
  const repo = join(base, name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  appendFileSync(join(repo, '.git', 'config'), '[core]\n\tautocrlf = false\n[maintenance]\n\tauto = false\n');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  return realpathSync.native(repo);
}

// Masks: what differs between two runs of the same steps.
const masks = [];
const slash = (p) => p.replace(/\\/g, '/');
function mask(value) {
  const text = JSON.stringify(value);
  let out = slash(text.replace(/\\\\/g, '/'));
  for (const [from, to] of masks) out = out.split(slash(from)).join(to);
  out = out.replace(/"createdAt":\d{13}/g, '"createdAt":"<ms>"').replace(/worktrees-v1\/[0-9a-f]{16}\//g, 'worktrees-v1/<project>/').replace(/\b[0-9a-f]{40}\b/g, '<sha>').replace(/\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)/g, '<time>');
  return JSON.parse(out);
}
const steps = [];
async function step(name, fn) {
  let entry;
  try {
    entry = { ok: await fn() };
  } catch (error) {
    entry = { error: { code: error.code ?? null, message: String(error.message), details: error.details ?? null } };
  }
  steps.push({ name, ...mask(entry) });
  return entry;
}

const restore = configureWorktreeManager({ settings: {}, freeBytes: async () => Number.MAX_SAFE_INTEGER });
const repo = seedRepo('repo', { 'f.txt': 'a\nb\nc\n', '.gitignore': '.mixdog/\n' });
git(repo, 'branch', 'dev');
masks.push([repo, '<repo>'], [join(base, 'data'), '<data>']);
const session = { id: 'lead', cwd: repo, desktopSession: { classification: 'project', projectPath: repo }, messages: [] };
const cwdRef = { cwd: repo };
const api = createWorkspaceTransitions({
  getSession: () => session,
  getCurrentCwd: () => cwdRef.cwd,
  applyResolvedCwd: (next) => { cwdRef.cwd = next; session.cwd = next; },
  persistSession: () => {},
  refreshWorkspaceContext: async () => {},
  getActiveTurnCount: () => 0,
  agentStatusState: () => ({ agentWorkers: [], agentJobs: [] }),
  countOwnShellJobs: async () => 0,
  listLiveSessions: () => [],
  findRegisteredProject: async (path) => (samePath(path, repo) ? repo : null),
});

await step('menu: never moved', () => api.getBranchMenu());
await step('work: no ids', () => api.getSessionWorktreeWork({ sessionIds: [] }));
await step('work: nothing owned', () => api.getSessionWorktreeWork({ sessionIds: ['lead', 7, ''] }));
await step('request: armed intent', () => api.requestWorktree({ name: 'feat' }));
await step('request: bad name type', () => api.requestWorktree({ name: 5 }));
await step('request: bad carry choice', () => api.requestWorktree({ name: 'feat', carryChanges: 'maybe' }));
await step('request: stale revision', () => api.requestWorktree({ name: 'feat', expectedRevision: 3 }));
await step('menu: intent armed', () => api.getBranchMenu());
const entered = await step('request: provision', () => api.requestWorktree({ name: 'feat', provision: true, txId: 'c1' }));
const wt = entered.ok.workspace.cwd;
masks.unshift([wt, '<worktree>']);
steps.at(-1).ok = mask(entered).ok;
await step('request: bound already', () => api.requestWorktree({ name: 'feat', provision: true, txId: 'c1b' }));
await step('menu: in worktree', () => api.getBranchMenu());
await step('work: clean worktree', () => api.getSessionWorktreeWork({ sessionIds: ['lead'] }));
writeFileSync(join(wt, 'g.txt'), 'x\n');
git(wt, 'add', '.');
git(wt, 'commit', '-qm', 'work');
await step('work: unmerged commit holds', () => api.getSessionWorktreeWork({ sessionIds: ['lead', 'other'] }));
await step('merge: unconfirmed', () => api.mergeWorkspace({ confirmed: false }));
await step('merge: stale revision', () => api.mergeWorkspace({ confirmed: true, expectedRevision: 9 }));
await step('merge: confirmed with cleanup', () => api.mergeWorkspace({ confirmed: true, cleanup: true }));
await step('select: dev', () => api.selectBranch({ branch: 'dev', txId: 'c2' }));
await step('select: dev again', () => api.selectBranch({ branch: 'dev', txId: 'c2b' }));
await step('select: unknown branch', () => api.selectBranch({ branch: 'nope', txId: 'c3' }));
await step('select: stale revision', () => api.selectBranch({ branch: 'main', expectedRevision: 40 }));
await step('menu: on dev', () => api.getBranchMenu());
await step('work: merged but retained', () => api.getSessionWorktreeWork({ sessionIds: ['lead'] }));

// ---- turn changes: the same edit/undo/redo as turn-changes.slow.test.mjs
const changes = [];
const turnRepo = seedRepo('turn', { 'a.txt': 'a\n', 'b.txt': 'b\n', 'keep.txt': 'keep\n' });
masks.push([turnRepo, '<repo>']);
const edit = (sessionId, files) => {
  let n = 0;
  for (const [path, content] of Object.entries(files)) {
    const full = join(turnRepo, path);
    const before = existsSync(full) ? readFileSync(full) : null;
    if (content === null) rmSync(full, { force: true });
    else writeFileSync(full, content);
    registerEditToolUiDiff({ callId: `edit-${++n}`, sessionId, basePath: turnRepo, fullPath: full, before, after: content === null ? null : Buffer.from(content) });
  }
};
const SID = 'turn-session';
await snapshot.beginTurnSnapshot(turnRepo, SID, { checkpointId: 'cp' });
edit(SID, { 'a.txt': 'A\n', 'b.txt': null, 'new.txt': 'new\n' });
await snapshot.completeTurnSnapshot(SID);
const record = async (name, fn) => {
  let entry;
  try { entry = { ok: await fn() }; } catch (error) { entry = { error: { message: String(error.message) } }; }
  changes.push({ name, ...mask(entry) });
  return entry;
};
const read = (rev) => snapshot.getTurnChanges(SID, { checkpointId: 'cp' }).then((r) => r.revision ?? rev);
let rev = await read();
await record('revert: stale revision', () => snapshot.revertTurnChanges(SID, 'cp', null, rev + 1));
let r = await record('revert: one file', () => snapshot.revertTurnChanges(SID, 'cp', 'a.txt', rev));
await record('revert: same file again', () => snapshot.revertTurnChanges(SID, 'cp', 'a.txt', r.ok.revision));
r = await record('revert: whole turn', () => snapshot.revertTurnChanges(SID, 'cp', null, r.ok.revision));
await record('revert: nothing left', () => snapshot.revertTurnChanges(SID, 'cp', null, r.ok.revision));
await record('revert: unknown checkpoint', () => snapshot.revertTurnChanges(SID, 'cp-unknown', null, 1));
r = await record('reapply: one file', () => snapshot.reapplyTurnChanges(SID, 'cp', 'new.txt', r.ok.revision));
r = await record('reapply: whole turn', () => snapshot.reapplyTurnChanges(SID, 'cp', null, r.ok.revision));
await record('reapply: nothing left', () => snapshot.reapplyTurnChanges(SID, 'cp', null, r.ok.revision));
restore();

const finalOut = join(FIXTURES_ROOT, 'thread-scm');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'workspace steps (getBranchMenu, getSessionWorktreeWork, requestWorktree, selectBranch, mergeWorkspace) and turn-change steps (revertTurnChanges, reapplyTurnChanges) of the real 1.4.5 functions; paths, commit ids and times are masked as <repo>, <data>, <worktree>, <sha>, <time>',
  steps,
  changes,
});
writeSetManifest(out, {
  set: 'thread-scm',
  recorder: 'benchmarks/rust-core/recorders/record-thread-scm.mjs',
  command: 'node benchmarks/rust-core/recorders/record-thread-scm.mjs --tree <tree>',
  extra: { steps: steps.length, changes: changes.length },
});
commitStage(out, finalOut);
console.log(`steps=${steps.length} changes=${changes.length}`);


