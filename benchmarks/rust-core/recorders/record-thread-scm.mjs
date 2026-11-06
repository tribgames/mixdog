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
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  let out = text.replace(/\\\\/g, '/');
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

// ---- scenarios: the safety refusals and the git/disk state each step leaves behind
const gitOut = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : `exit ${r.status}`;
};
const lines = (text) => text.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
function dirFiles(dir, rel = '') {
  const out = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (rel === '' && (entry.name === '.git' || entry.name === '.mixdog')) continue;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...dirFiles(dir, path));
    else out.push({ path, content: readFileSync(join(dir, path), 'utf8') });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}
function checkoutState(dir) {
  if (!dir || !existsSync(dir)) return { exists: false };
  return {
    exists: true,
    head: gitOut(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    status: lines(gitOut(dir, 'status', '--porcelain', '--untracked-files=all')).sort(),
    branches: lines(gitOut(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).sort(),
    log: lines(gitOut(dir, 'log', '--format=%s', '-n', '20')),
    worktrees: lines(gitOut(dir, 'worktree', 'list', '--porcelain')).filter((l) => l.startsWith('branch ') || l === 'detached').sort(),
    files: dirFiles(dir),
  };
}
const call = (method, input) => ({ do: 'call', method, input });
const sh = (where, ...args) => ({ do: 'git', in: where, args });
const put = (where, path, content) => ({ do: 'write', in: where, path, content });
const rmv = (where, path) => ({ do: 'rm', in: where, path });
const commitFile = (where, path, content, message) => [put(where, path, content), sh(where, 'add', '-A'), sh(where, 'commit', '-qm', message)];
const prov = (extra = {}) => call('requestWorktree', { name: 'feat', provision: true, txId: 'tx-prov', ...extra });
const dirtyRepo = [put('repo', 'f.txt', 'dirty\n'), put('repo', 'u.txt', 'untracked\n')];
const scenarioDefs = [
  { name: 'merge: dirty worktree', actions: (sid) => [prov(), ...commitFile('wt', 'g.txt', 'x\n', 'work'), put('wt', 'f.txt', 'dirty\n'), put('wt', 'u.txt', 'untracked\n'), call('mergeWorkspace', { confirmed: true, cleanup: true }), call('getSessionWorktreeWork', { sessionIds: [sid] }), call('mergeWorkspace', { confirmed: true, cleanup: true })] },
  { name: 'merge: conflict with the project branch', actions: (sid) => [prov(), ...commitFile('wt', 'f.txt', 'wt\n', 'wt-change'), ...commitFile('repo', 'f.txt', 'main\n', 'main-change'), call('mergeWorkspace', { confirmed: false }), call('mergeWorkspace', { confirmed: true, cleanup: true }), call('getSessionWorktreeWork', { sessionIds: [sid] }), call('mergeWorkspace', { confirmed: true })] },
  { name: 'merge: stale revision then retained', actions: (sid) => [prov(), ...commitFile('wt', 'g.txt', 'x\n', 'work'), call('mergeWorkspace', { confirmed: true, expectedRevision: 99 }), call('mergeWorkspace', { confirmed: true }), call('getSessionWorktreeWork', { sessionIds: [sid] }), call('getBranchMenu'), call('mergeWorkspace', { confirmed: true })] },
  { name: 'merge: project tree dirty', actions: (sid) => [prov(), ...commitFile('wt', 'g.txt', 'x\n', 'work'), ...dirtyRepo, call('mergeWorkspace', { confirmed: true, cleanup: true }), call('getSessionWorktreeWork', { sessionIds: [sid] })] },
  { name: 'select: dirty project tree', actions: () => [sh('repo', 'branch', 'dev'), ...dirtyRepo, call('selectBranch', { branch: 'dev', txId: 'tx-1' }), call('getBranchMenu'), call('selectBranch', { branch: 'main', txId: 'tx-2' })] },
  { name: 'select: leaving unmerged work', actions: (sid) => [sh('repo', 'branch', 'dev'), prov(), ...commitFile('wt', 'g.txt', 'x\n', 'work'), call('selectBranch', { branch: 'main', txId: 'tx-1' }), call('getSessionWorktreeWork', { sessionIds: [sid] }), call('selectBranch', { branch: 'dev', txId: 'tx-2' }), call('getBranchMenu')] },
  { name: 'select: branch held by a linked worktree', actions: () => [sh('repo', 'branch', 'dev'), sh('repo', 'worktree', 'add', '-q', '-b', 'linked', '../linked-wt'), call('selectBranch', { branch: 'linked', txId: 'tx-1' }), call('selectBranch', { branch: 'linked', txId: 'tx-2' }), call('selectBranch', { branch: 'dev', txId: 'tx-3' }), call('getBranchMenu')] },
  { name: 'select: stale revision and missing branch', actions: () => [sh('repo', 'branch', 'dev'), call('selectBranch', { branch: 'dev', expectedRevision: 77 }), call('selectBranch', { branch: 'nope', txId: 'tx-1' }), sh('repo', 'branch', '-D', 'dev'), call('selectBranch', { branch: 'dev', txId: 'tx-2' }), call('getBranchMenu')] },
  { name: 'missing worktree folder', actions: (sid) => [prov(), rmv('wt', ''), call('getBranchMenu'), call('getSessionWorktreeWork', { sessionIds: [sid] }), call('mergeWorkspace', { confirmed: true }), call('selectBranch', { branch: 'main', txId: 'tx-1' }), call('getBranchMenu')] },
  { name: 'request: dirty project, carry', actions: (sid) => [...dirtyRepo, prov({ carryChanges: 'carry' }), call('getSessionWorktreeWork', { sessionIds: [sid] }), call('getBranchMenu')] },
  { name: 'request: dirty project, leave', actions: () => [...dirtyRepo, prov({ carryChanges: 'leave' }), call('getBranchMenu')] },
  { name: 'request: dirty project, ask', actions: () => [...dirtyRepo, prov({ carryChanges: 'ask' }), prov({ txId: 'tx-again' })] },
  { name: 'request: dirty project, no choice', actions: () => [...dirtyRepo, prov(), call('getBranchMenu')] },
];
const scenarios = [];
for (const [index, def] of scenarioDefs.entries()) {
  const sid = 'lead';
  const repoDir = seedRepo(`sc-${index}`, { 'f.txt': 'a\nb\nc\n' });
  const saved = masks.splice(0, masks.length);
  process.env.MIXDOG_DATA_DIR = join(base, `data-${index}`);
  masks.push([repoDir, '<repo>'], [process.env.MIXDOG_DATA_DIR, '<data>'], [base, '<base>']);
  const scSession = { id: sid, cwd: repoDir, desktopSession: { classification: 'project', projectPath: repoDir }, messages: [] };
  const scCwd = { cwd: repoDir };
  const scApi = createWorkspaceTransitions({
    getSession: () => scSession,
    getCurrentCwd: () => scCwd.cwd,
    applyResolvedCwd: (next) => { scCwd.cwd = next; scSession.cwd = next; },
    persistSession: () => {},
    refreshWorkspaceContext: async () => {},
    getActiveTurnCount: () => 0,
    agentStatusState: () => ({ agentWorkers: [], agentJobs: [] }),
    countOwnShellJobs: async () => 0,
    listLiveSessions: () => [],
    findRegisteredProject: async (path) => (samePath(path, repoDir) ? repoDir : null),
  });
  let wtDir = null;
  const where = (name) => (name === 'repo' ? repoDir : wtDir);
  const done = [];
  // Transaction ids and worktree names are global to the data folder: make them this scenario's own.
  const actions = def.actions(sid).map((a) => {
    if (!a.input) return a;
    const input = { ...a.input };
    if (input.txId) input.txId = `${input.txId}-${index}`;
    if (typeof input.name === 'string') input.name = `${input.name}${index}`;
    return { ...a, input };
  });
  for (const action of actions) {
    let result;
    if (action.do === 'call') {
      try {
        result = { ok: await (action.input === undefined ? scApi[action.method]() : scApi[action.method](action.input)) };
      } catch (error) {
        result = { error: { code: error.code ?? null, message: String(error.message), details: error.details ?? null } };
      }
      const cwd = result.ok?.workspace?.cwd;
      if (cwd && !samePath(cwd, repoDir) && cwd !== wtDir) {
        wtDir = cwd;
        masks.unshift([wtDir, '<worktree>']);
      }
    } else if (!where(action.in) && process.env.DEBUG_SC) { console.error(def.name, JSON.stringify(done.at(-1), null, 1).slice(0, 1500)); process.exit(2); } else if (action.do === 'git') git(where(action.in), ...action.args);
    else if (action.do === 'write') writeFileSync(join(where(action.in), action.path), action.content);
    else rmSync(join(where(action.in), action.path), { recursive: true, force: true });
    done.push({ action, ...(result ? { result: mask(result) } : {}), state: { repo: checkoutState(repoDir), worktree: checkoutState(wtDir) } });
  }
  masks.splice(0, masks.length, ...saved);
  scenarios.push({ name: def.name, threadId: sid, steps: done });
}
process.env.MIXDOG_DATA_DIR = join(base, 'data');

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
  try { entry = { ok: await fn() }; } catch (error) { entry = { error: { code: error.code ?? null, message: String(error.message), details: error.details ?? null } }; }
  changes.push({ name, ...mask(entry), files: dirFiles(turnRepo) });
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

// The same turn under conditions a user can create: edits made after the turn, files gone.
const turnScenarioDefs = [
  { name: 'after-turn edit of a changed file', tweak: [put('repo', 'a.txt', 'USER\n')], plan: [['revert', null], ['revert', 'a.txt'], ['reapply', null]] },
  { name: 'after-turn edit of a created file', tweak: [put('repo', 'new.txt', 'USER\n'), put('repo', 'b.txt', 'USER-B\n')], plan: [['revert', 'new.txt'], ['revert', null], ['reapply', null]] },
  { name: 'files gone', tweak: [rmv('repo', 'new.txt'), rmv('repo', 'a.txt')], plan: [['revert', null], ['reapply', 'a.txt'], ['reapply', null]] },
  { name: 'untracked neighbour', tweak: [put('repo', 'extra.txt', 'extra\n')], plan: [['revert', null], ['reapply', null], ['revert', null]] },
];
const turnScenarios = [];
for (const [index, def] of turnScenarioDefs.entries()) {
  const dir = seedRepo(`turn-sc-${index}`, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'keep.txt': 'keep\n' });
  const sid = `turn-sc-${index}`;
  const saved = masks.splice(0, masks.length);
  masks.push([dir, '<repo>']);
  await snapshot.beginTurnSnapshot(dir, sid, { checkpointId: 'cp' });
  let n = 0;
  for (const [path, content] of Object.entries({ 'a.txt': 'A\n', 'b.txt': null, 'new.txt': 'new\n' })) {
    const full = join(dir, path);
    const before = existsSync(full) ? readFileSync(full) : null;
    if (content === null) rmSync(full, { force: true });
    else writeFileSync(full, content);
    registerEditToolUiDiff({ callId: `edit-${++n}`, sessionId: sid, basePath: dir, fullPath: full, before, after: content === null ? null : Buffer.from(content) });
  }
  await snapshot.completeTurnSnapshot(sid);
  for (const action of def.tweak) {
    if (action.do === 'write') writeFileSync(join(dir, action.path), action.content);
    else rmSync(join(dir, action.path), { force: true });
  }
  let revision = (await snapshot.getTurnChanges(sid, { checkpointId: 'cp' })).revision;
  const startRevision = revision;
  const done = [];
  for (const [kind, file] of def.plan) {
    let result;
    try {
      result = { ok: await snapshot[`${kind}TurnChanges`](sid, 'cp', file, revision) };
      revision = result.ok.revision ?? revision;
    } catch (error) {
      result = { error: { code: error.code ?? null, message: String(error.message), details: error.details ?? null } };
    }
    done.push({ kind, file, ...mask(result), files: dirFiles(dir) });
  }
  masks.splice(0, masks.length, ...saved);
  turnScenarios.push({ name: def.name, threadId: sid, tweak: def.tweak, startRevision, steps: done });
}
restore();

const finalOut = join(FIXTURES_ROOT, 'thread-scm');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'workspace steps (getBranchMenu, getSessionWorktreeWork, requestWorktree, selectBranch, mergeWorkspace) and turn-change steps (revertTurnChanges, reapplyTurnChanges) of the real 1.4.5 functions; paths, commit ids and times are masked as <repo>, <data>, <worktree>, <sha>, <time>',
  steps,
  changes,
  scenarios,
  turnScenarios,
});
writeSetManifest(out, {
  set: 'thread-scm',
  recorder: 'benchmarks/rust-core/recorders/record-thread-scm.mjs',
  command: 'node benchmarks/rust-core/recorders/record-thread-scm.mjs --tree <tree>',
  extra: { steps: steps.length, changes: changes.length },
});
commitStage(out, finalOut);
console.log(`steps=${steps.length} changes=${changes.length}`);


