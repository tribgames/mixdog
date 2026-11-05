#!/usr/bin/env node
// `git` tool goldens (T §8.2) for staging by id, the worktree actions and the command surface,
// recorded from the Node tool into native/core/fixtures/tools/git/. Each case is
// self-describing — { setup, host?, steps:[{input, cwd?, text, requests?}] } — so the Rust
// tests replay the same repository, the same scripted worktree host and the same inputs.
//
//   node benchmarks/rust-core/recorders/record-tools-git.mjs --tree <dir>
//
// Setup ops: {write:[path, text]} | {git:[args…]}. In an input, the string "<DIFF_ID>" stands
// for the diff_id the most recent step printed. A host case registers a scripted worktree host
// (the session runtime's seam, shared/worktrees/tool-host.mjs); every request it receives is
// recorded beside the step's text.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, refreshSetManifest, resolveTree, writeJson } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const work = mkdtempSync(join(tmpdir(), 'mixdog-git-golden-'));
process.env.MIXDOG_DATA_DIR = join(work, 'data');
process.env.MIXDOG_TOOL_FAILURE_LOG_PATH = join(work, 'failures.jsonl');
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Golden',
  GIT_AUTHOR_EMAIL: 'golden@example.com',
  GIT_COMMITTER_NAME: 'Golden',
  GIT_COMMITTER_EMAIL: 'golden@example.com',
  GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z',
  GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
});
const { executeGitTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin/git-command-tool.mjs');
const { registerWorktreeToolHost } = await importFrom(tree, 'src/runtime/shared/worktrees/tool-host.mjs');

const BASE = [
  { git: ['init', '-q', '-b', 'main'] },
  { git: ['config', 'core.autocrlf', 'false'] },
  { write: ['f.txt', 'a\nb\nc\n'] },
  { write: ['g.txt', 'x\ny\n'] },
  { git: ['add', '.'] },
  { git: ['commit', '-q', '-m', 'init'] },
];
const DIRTY = [
  { write: ['f.txt', 'a\nB\nc\nd\n'] },
  { write: ['g.txt', 'x\nY\n'] },
  { write: ['u.txt', 'new\n'] },
];
const setup = [...BASE, ...DIRTY];
const ID = '<DIFF_ID>';
const DIFF = { command: 'git diff', include_stage_ids: true };
const stage = (...ids) => ({ action: 'stage', diff_id: ID, change_ids: ids });

const lead = (script) => ({ sessionId: 'lead', toolCallId: 'call1', script });
const WS = { cwd: '<ROOT>/wt', branch: 'feat', mergeTarget: 'main', revision: 7, worktreeId: 'wt1' };
const ROWS = [
  { id: 'wt1', path: '<ROOT>/.mixdog-wt/feat', branch: 'feat', ownerSessionId: 'lead', mergeTarget: 'main', state: 'ready', ownerLive: true, removable: false, kind: 'worktree', repoCommonDir: '<ROOT>/.git' },
  { id: 'snap1', path: '<ROOT>/.mixdog-wt/snap', branch: null, kind: 'snapshot', baseCommit: 'abc', holderSessionId: 'lead', state: 'ready', removable: true, repoCommonDir: '<ROOT>/.git' },
];

const cases = {
  // ---- staging ----
  'stage-diff-ids': { setup, steps: [{ input: DIFF }] },
  'stage-partial': {
    setup,
    steps: [{ input: DIFF }, { input: stage('c1') }, { input: { command: 'git diff --cached' } }, { input: { command: 'git status --short' } }],
  },
  'stage-multiple-and-new-file': {
    setup,
    steps: [{ input: DIFF }, { input: stage('c2', 'c3', 'c4') }, { input: { command: 'git status --short' } }, { input: { command: 'git diff --cached --stat' } }],
  },
  'stage-paths-diff': {
    setup,
    steps: [{ input: { command: 'git diff -- g.txt', include_stage_ids: true } }, { input: stage('c1') }, { input: { command: 'git diff --cached' } }],
  },
  'stage-refusals': {
    setup,
    steps: [
      { input: { action: 'stage', diff_id: 'diff_nope', change_ids: ['c1'] } },
      { input: { action: 'stage', change_ids: ['c1'] } },
      { input: { action: 'stage', diff_id: 'diff_x' } },
      { input: { action: 'stage', diff_id: 'diff_x', change_ids: Array.from({ length: 51 }, (_, i) => `c${i + 1}`) } },
      { input: { action: 'stage', diff_id: 'diff_x', change_ids: ['c1'], command: 'git status' } },
      { input: { action: 'stage', diff_id: 'diff_x', change_ids: ['c1'], include_stage_ids: true } },
      { input: { command: 'git status', diff_id: 'diff_x' } },
      { input: { command: 'git status', change_ids: ['c1'] } },
      { input: DIFF },
      { input: stage('c99') },
      { input: stage('c1', 'c98') },
      { input: { action: 'sideways' } },
      { input: { include_stage_ids: true } },
    ],
  },
  'stage-stale': {
    setup,
    steps: [{ input: DIFF }, { write: ['f.txt', 'a\nB\nc\nd\ne\n'] }, { input: stage('c1') }],
  },
  'stage-scope-mismatch': {
    setup: [...setup, { write: ['sub/s.txt', 's\n'] }],
    steps: [{ input: DIFF }, { input: stage('c1'), cwd: 'sub' }],
  },
  'stage-stringified-ids': {
    setup,
    steps: [{ input: DIFF }, { input: { action: 'stage', diff_id: ID, change_ids: '["c1","c3"]' } }, { input: { command: 'git status --short' } }],
  },
  // ---- command surface ----
  'command-basics': {
    setup,
    steps: [
      { input: { command: 'git status --short' } },
      { input: { command: 'status -s' } },
      { input: { command: ['git log --format=%s', 'git branch --list'] } },
      { input: { command: 'git add f.txt && git status --short' } },
      { input: { command: '["git log --format=%s","git diff --cached --name-only"]' } },
      { input: { command: ['git status --short', 'git not-a-command', 'git log'] } },
      { input: { command: 'git diff --exit-code' } },
      { input: { command: 'git grep nomatch' } },
      { input: { command: 'git config user.name' } },
      { input: { command: 'git config --global user.name x' } },
      { input: { command: 'git log | head' } },
      { input: { command: 'git log --format=%h|%s -n 1' } },
      { input: { command: 'npm test' } },
      { input: { command: 'git gui' } },
      { input: { command: 'git archive HEAD' } },
      { input: { command: 'git -C' } },
      { input: { command: 'git --version' } },
      { input: { command: [] } },
      { input: {} },
      { input: { command: 'git status', output_limit: 1 } },
      { input: { command: 'git log --format=%s', output_limit: 'x' } },
      { input: { command: 'git show HEAD --stat' } },
    ],
  },
  'command-write': {
    setup,
    steps: [
      { input: { command: 'git add -A' } },
      { input: { command: 'git commit -q -m second' } },
      { input: { command: 'git log --format=%s' } },
      { input: { command: 'git branch topic' } },
      { input: { command: 'git branch --list' } },
      { input: { command: 'git tag -a v1 -m x' } },
    ],
  },
  'command-outside-repo': { setup: [{ write: ['plain/x.txt', 'x\n'] }], steps: [{ input: { command: 'git status' }, cwd: 'plain' }] },
  // ---- worktrees: no host ----
  'worktree-no-host': {
    setup: BASE,
    steps: [
      { input: { action: 'worktree', worktree_action: 'list' } },
      { input: { command: 'git worktree list' } },
      { input: { command: 'git worktree list --porcelain' } },
      { input: { command: 'git worktree list -x' } },
      { input: { command: 'git worktree list extra' } },
      { input: { command: 'git worktree add ../wt' } },
      { input: { command: 'git worktree remove ../wt' } },
      { input: { command: 'git worktree prune' } },
      { input: { command: 'git worktree prune -n' } },
      { input: { command: 'git worktree move a b' } },
      { input: { command: 'git worktree lock a' } },
      { input: { command: 'git worktree' } },
      { input: { command: 'git worktree frob' } },
      { input: { command: 'git worktree add --help' } },
      { input: { command: 'git worktree remove -h' } },
      { input: { action: 'worktree', worktree_action: 'enter', branch: 'feat' } },
      { input: { action: 'worktree', worktree_action: 'merge' } },
      { input: { action: 'worktree', worktree_action: 'prune' } },
    ],
  },
  'worktree-input-validation': {
    setup: BASE,
    steps: [
      { input: { action: 'worktree' } },
      { input: { action: 'worktree', worktree_action: 'nope' } },
      { input: { action: 'worktree', worktree_action: 'list', command: 'git status' } },
      { input: { action: 'worktree', worktree_action: 'list', output_limit: 5 } },
      { input: { action: 'worktree', worktree_action: 'merge', force: true } },
      { input: { action: 'worktree', worktree_action: 'merge', branch: 'x' } },
      { input: { action: 'worktree', worktree_action: 'return', name: 'n' } },
      { input: { action: 'worktree', worktree_action: 'remove', create: true } },
      { input: { action: 'worktree', worktree_action: 'enter', create: true } },
      { input: { action: 'worktree', worktree_action: 'enter', branch: '  ' } },
      { input: { action: 'worktree', worktree_action: 'enter', branch: 'b', name: 'n' } },
      { input: { action: 'worktree', worktree_action: 'enter', carry: 'maybe' } },
      { input: { action: 'worktree', worktree_action: 'enter', session_id: ' ' } },
      { input: { action: 'worktree', worktree_action: 'remove', branch: 'b', session_id: 's' } },
      { input: { action: 'worktree', worktree_action: 'list', confirm_large: true } },
      { input: { command: 'git status', worktree_action: 'list' } },
      { input: { command: 'git status', force: true } },
      { input: { command: 'git status', confirm_large: true, action: 'command' } },
      { input: { action: 'stage', diff_id: 'd', change_ids: ['c1'], confirm_large: true } },
    ],
  },
  // ---- worktrees: scripted Lead host ----
  'worktree-host-actions': {
    setup: BASE,
    host: lead({
      enter: { workspace: WS, revision: 7, extra: 1 },
      return: { workspace: { ...WS, cwd: '<ROOT>', worktreeId: null }, unchanged: false },
      merge: { workspace: { ...WS, cwd: '<ROOT>' }, merged: true },
      remove: { removed: true },
      prune: { removed: ['wt9'], skipped: [] },
      list: ROWS,
    }),
    steps: [
      { input: { action: 'worktree', worktree_action: 'enter', name: 'my-feature', carry: 'carry', confirm_large: true } },
      { input: { action: 'worktree', worktree_action: 'enter', branch: 'feat', create: true } },
      { input: { action: 'worktree', worktree_action: 'return', session_id: 'other' } },
      { input: { action: 'worktree', worktree_action: 'merge' } },
      { input: { action: 'worktree', worktree_action: 'remove', force: true } },
      { input: { action: 'worktree', worktree_action: 'remove', branch: 'feat' } },
      { input: { action: 'worktree', worktree_action: 'prune' } },
      { input: { action: 'worktree', worktree_action: 'list' } },
    ],
  },
  'worktree-host-failures': {
    setup: BASE,
    host: lead({
      enter: { error: { code: 'WORKTREE_LARGE_REPO_CONFIRM', message: 'WORKTREE_LARGE_REPO_CONFIRM: big', details: { estimateBytes: 5368709120 } } },
      return: { error: { code: 'WORKTREE_DIRTY', message: 'WORKTREE_DIRTY: x', details: { reason: 'project-dirty' } } },
      merge: { error: { code: 'MERGE_CONFLICT', message: 'MERGE_CONFLICT: c', details: { files: ['a', 'b', 'c', 'd', 'e', 'f'] } } },
      remove: { error: { code: 'WORKTREE_BUSY_JOBS', message: 'busy', details: { reason: 'folder-shell-jobs' } } },
      prune: { error: { code: 'WORKTREE_DISK_INSUFFICIENT', message: 'disk', details: { requiredBytes: 2147483648, freeBytes: 1048576 } } },
      list: ROWS,
    }),
    steps: [
      { input: { action: 'worktree', worktree_action: 'enter', name: 'x' } },
      { input: { action: 'worktree', worktree_action: 'return' } },
      { input: { action: 'worktree', worktree_action: 'merge' } },
      { input: { action: 'worktree', worktree_action: 'remove' } },
      { input: { action: 'worktree', worktree_action: 'prune' } },
      { input: { command: 'git worktree add -b feat2 ../w2', confirm_large: true } },
    ],
  },
  'worktree-host-plain-error': {
    setup: BASE,
    host: lead({ merge: { error: { code: 'GIT_FAILED', message: 'git merge failed (exit 1): nope' } } }),
    steps: [{ input: { action: 'worktree', worktree_action: 'merge' } }],
  },
  'worktree-host-mapped': {
    setup: [...BASE, { git: ['branch', 'existing'] }],
    host: lead({
      add: { id: 'wt2', path: '<ROOT>/.mixdog-wt/feat', branch: 'feat', created: true },
      snapshot: { id: 'snap2', path: '<ROOT>/.mixdog-wt/snap2', baseCommit: 'abc123' },
      'remove-path': { removed: true, workspace: WS, revision: 3 },
      prune: { removed: [] },
      list: ROWS,
    }),
    steps: [
      { input: { command: 'git worktree add -b feat ../w feature-base' } },
      { input: { command: 'git worktree add -b feat ../w' } },
      { input: { command: 'git worktree add -b main ../w' } },
      { input: { command: 'git worktree add -B main ../w' } },
      { input: { command: 'git worktree add -b' } },
      { input: { command: 'git worktree add --detach -b x ../w' } },
      { input: { command: 'git worktree add --orphan ../w' } },
      { input: { command: 'git worktree add --bogus ../w' } },
      { input: { command: 'git worktree add' } },
      { input: { command: 'git worktree add a b c' } },
      { input: { command: 'git worktree add ../newbranch' } },
      { input: { command: 'git worktree add ../w existing' } },
      { input: { command: 'git worktree add ../w HEAD' } },
      { input: { command: 'git worktree add --detach ../w HEAD' } },
      { input: { command: 'git worktree add ../w nonsense-ref' } },
      { input: { command: 'git worktree remove ../w' } },
      { input: { command: 'git worktree remove -f ../w' } },
      { input: { command: 'git worktree remove' } },
      { input: { command: 'git worktree remove --weird ../w' } },
      { input: { command: 'git worktree prune' } },
      { input: { command: 'git worktree prune -n' } },
      { input: { command: 'git worktree prune --expire=now' } },
      { input: { command: 'git worktree prune extra' } },
      { input: { command: 'git worktree list' } },
      { input: { command: 'git worktree move a b' } },
    ],
  },
};

const ws = join(work, 'ws');
const fwd = ws.replace(/\\/g, '/');
const forms = [1, 2, 4, 8].flatMap((n) => [ws.replace(/\\/g, '\\'.repeat(n)), ws.toLowerCase().replace(/\\/g, '\\'.repeat(n))]);
const workFwd = work.replace(/\\/g, '/');
const workForms = [1, 2, 4, 8].flatMap((n) => [work.replace(/\\/g, '\\'.repeat(n)), work.toLowerCase().replace(/\\/g, '\\'.repeat(n))]);
const scrub = (value) => {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const form of [...forms, fwd, fwd.toLowerCase()]) text = text.replaceAll(form, '<ROOT>');
  for (const form of [...workForms, workFwd, workFwd.toLowerCase()]) text = text.replaceAll(form, '<WORK>');
  // Path separators after <ROOT> are normalised so Windows and POSIX runs compare equal.
  text = text.replace(/<(ROOT|WORK)>((?:\\+|\/)[^"\s,}\]\\]*(?:\\+[^"\s,}\]\\]+)*)/g, (_m, tag, rest) => `<${tag}>${rest.replace(/\\+/g, '/')}`);
  text = text.replace(/\b[0-9a-f]{40}\b/g, '<SHA>').replace(/diff_[0-9a-f]{20}/g, '<DIFF_ID>');
  return typeof value === 'string' ? text : JSON.parse(text);
};
const unscrub = (value) => JSON.parse(JSON.stringify(value).replaceAll('<ROOT>', fwd));

// The fixture files are written with sorted keys, so the scripted host replies are sorted too:
// the Node run and the Rust replay then answer with the same key order.
const sortKeys = (value) =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]))
      : value;
for (const def of Object.values(cases)) if (def.host) def.host.script = sortKeys(def.host.script);

const git = (cwd, argv) => execFileSync('git', argv, { cwd, stdio: 'pipe' });
function applySetup(ops) {
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  for (const op of ops) {
    if (op.write) {
      const target = join(ws, op.write[0]);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, op.write[1]);
    } else git(ws, op.git);
  }
}

const outDir = join(FIXTURES_ROOT, 'tools', 'git');
const recorded = [];
for (const [name, def] of Object.entries(cases)) {
  applySetup(def.setup);
  const requests = [];
  let unregister = null;
  if (def.host) {
    unregister = registerWorktreeToolHost({
      sessionId: () => def.host.sessionId,
      run: async (request) => {
        requests.push(request);
        const reply = unscrub(def.host.script)[request.op];
        if (reply?.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code, details: reply.error.details });
        return reply;
      },
    });
  }
  const steps = [];
  let lastDiffId = null;
  for (const step of def.steps) {
    if (step.write) {
      writeFileSync(join(ws, step.write[0]), step.write[1]);
      steps.push({ write: step.write });
      continue;
    }
    const input = JSON.parse(JSON.stringify(step.input).replaceAll(ID, lastDiffId ?? ID));
    const before = requests.length;
    const text = await executeGitTool(input, step.cwd ? join(ws, step.cwd) : ws, {
      sessionId: def.host?.sessionId ?? 'worker',
      toolCallId: def.host?.toolCallId,
    });
    lastDiffId = /diff_[0-9a-f]{20}/.exec(text)?.[0] ?? lastDiffId;
    steps.push({
      input: step.input,
      ...(step.cwd ? { cwd: step.cwd } : {}),
      text: scrub(text),
      ...(def.host ? { requests: scrub(requests.slice(before)) } : {}),
    });
  }
  unregister?.();
  writeJson(join(outDir, `${name}.json`), {
    tool: 'git',
    setup: def.setup,
    ...(def.host ? { host: def.host } : {}),
    steps,
  });
  recorded.push(name);
}
rmSync(work, { recursive: true, force: true });
refreshSetManifest(join(FIXTURES_ROOT, 'tools'), tree);
console.log(`recorded ${recorded.length} git goldens into ${outDir}`);
