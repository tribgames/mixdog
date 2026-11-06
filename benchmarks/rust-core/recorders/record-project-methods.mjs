#!/usr/bin/env node
// Genuine 1.4.5 behaviour of the Node-sourced `project/*` methods over a real fixture repository
// and data dir: Node's own createWorkspaceTransitions (getProjectBranchMenu, inspectProjectBranch,
// selectProjectBranch, mergeProjectBranch, manageProjectBranch, listWorktrees,
// previewWorktreeCleanup, pruneWorktrees, deleteWorktree, setArchivedSessionWorktrees,
// removeWorktree) against real git and the real managed-worktree backend, and
// createWorkflowAgentsApi (getProjectConnectors, setProjectConnectorEnabled) over a real
// project-connectors.json. The Rust ProjectService replays the same steps over its own fixture
// and must answer the same values once temp paths, commit ids, times and generated ids are masked
// the same way.
//
//   node benchmarks/rust-core/recorders/record-project-methods.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/project-methods/golden.json
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'project-methods-')));
process.env.MIXDOG_DATA_DIR = join(base, 'data');
process.on('exit', () => rmSync(base, { recursive: true, force: true }));

const { configureWorktreeManager } = await importFrom(tree, 'src/runtime/shared/worktrees/manager.mjs');
const { samePath } = await importFrom(tree, 'src/runtime/shared/worktrees/paths.mjs');
const { createWorkspaceTransitions } = await importFrom(tree, 'src/session-runtime/workspace/transitions.mjs');
const { createWorkflowAgentsApi } = await importFrom(tree, 'src/session-runtime/workflow-agents-api.mjs');
const { createWorkflowHelpers, createWorkflowRouteHelpers } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/workflow.mjs');
const { readMarkdownDocument, normalizeAgentPermissionOrNone } = await importFrom(tree, 'src/runtime/shared/markdown-frontmatter.mjs');

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
function maskText(text) {
  let out = slash(text);
  for (const [from, to] of masks) out = out.split(slash(from)).join(to);
  return out
    .replace(/worktrees-v1\/[0-9a-f]{16}\//g, 'worktrees-v1/<project>/')
    .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)/g, '<time>');
}
const TIME_KEYS = new Set(['createdAt', 'updatedAt', 'lastActiveAt', 'committedAt', 'archivedAt', 'lastUsedAt']);
function mask(value) {
  if (typeof value === 'string') return maskText(value);
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [maskText(k), TIME_KEYS.has(k) && typeof v === 'number' ? '<ms>' : mask(v)]));
  }
  return value;
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
git(repo, 'checkout', '-q', '-b', 'topic');
writeFileSync(join(repo, 't.txt'), 't\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'topic work');
git(repo, 'checkout', '-q', 'main');
masks.push([repo, '<repo>'], [join(base, 'data'), '<data>'], [base, '<base>']);

// The hosted session is the Lead until `ended`: then no session of this process is live, which
// leaves its worktrees without an owner.
let current = { id: 'lead', cwd: repo, desktopSession: { classification: 'project', projectPath: repo }, messages: [] };
const cwdRef = { cwd: repo };
const api = createWorkspaceTransitions({
  getSession: () => current,
  getCurrentCwd: () => cwdRef.cwd,
  applyResolvedCwd: (next) => { cwdRef.cwd = next; if (current) current.cwd = next; },
  persistSession: () => {},
  refreshWorkspaceContext: async () => {},
  getActiveTurnCount: () => 0,
  agentStatusState: () => ({ agentWorkers: [], agentJobs: [] }),
  countOwnShellJobs: async () => 0,
  listLiveSessions: () => [],
  findRegisteredProject: async (path) => (samePath(path, repo) ? repo : null),
});

// ---- branches
await step('menu: project folder', () => api.getProjectBranchMenu({ projectPath: repo }));
await step('menu: unregistered project', () => api.getProjectBranchMenu({ projectPath: join(base, 'nowhere') }));
await step('menu: blank project path', () => api.getProjectBranchMenu({ projectPath: '  ' }));
await step('inspect: unmerged topic', () => api.inspectProjectBranch({ projectPath: repo, branch: 'topic' }));
await step('inspect: merged dev', () => api.inspectProjectBranch({ projectPath: repo, branch: 'dev' }));
await step('inspect: unknown branch', () => api.inspectProjectBranch({ projectPath: repo, branch: 'nope' }));
await step('inspect: blank branch', () => api.inspectProjectBranch({ projectPath: repo, branch: '' }));
await step('select: unknown branch', () => api.selectProjectBranch({ projectPath: repo, branch: 'nope' }));
await step('select: already current', () => api.selectProjectBranch({ projectPath: repo, branch: 'main' }));
await step('select: create from start point', () => api.selectProjectBranch({ projectPath: repo, branch: 'fresh', create: true, startPoint: git(repo, 'rev-parse', 'main') }));
await step('select: topic', () => api.selectProjectBranch({ projectPath: repo, branch: 'topic' }));
await step('menu: on topic', () => api.getProjectBranchMenu({ projectPath: repo }));
await step('select: create and remote', () => api.selectProjectBranch({ projectPath: repo, branch: 'x', create: true, remote: true }));
await step('select: start point needs create', () => api.selectProjectBranch({ projectPath: repo, branch: 'dev', startPoint: git(repo, 'rev-parse', 'main') }));
await step('select: detach excludes branch', () => api.selectProjectBranch({ projectPath: repo, branch: 'dev', detach: 'main' }));
await step('select: detach', () => api.selectProjectBranch({ projectPath: repo, detach: git(repo, 'rev-parse', 'main') }));
await step('menu: detached', () => api.getProjectBranchMenu({ projectPath: repo }));
await step('select: back to main', () => api.selectProjectBranch({ projectPath: repo, branch: 'main' }));
await step('merge: wrong target', () => api.mergeProjectBranch({ projectPath: repo, branch: 'topic', target: 'dev' }));
await step('merge: blank target', () => api.mergeProjectBranch({ projectPath: repo, branch: 'topic', target: '' }));
await step('merge: topic into main', () => api.mergeProjectBranch({ projectPath: repo, branch: 'topic', target: 'main' }));
await step('inspect: topic now merged', () => api.inspectProjectBranch({ projectPath: repo, branch: 'topic' }));
git(repo, 'branch', 'spare');
const view = await api.inspectProjectBranch({ projectPath: repo, branch: 'spare' });
const act = (view, action, extra = {}) =>
  api.manageProjectBranch({ projectPath: repo, branch: view.branch, commit: view.commit, target: view.target, targetCommit: view.targetCommit, confirmed: true, action, ...extra });
await step('manage: unconfirmed', () => api.manageProjectBranch({ projectPath: repo, branch: view.branch, commit: view.commit, target: view.target, targetCommit: view.targetCommit, confirmed: false, action: 'delete-branch' }));
await step('manage: unknown action', () => act(view, 'explode'));
await step('manage: stale commit', () => act({ ...view, commit: '0'.repeat(40) }, 'delete-branch'));
await step('manage: delete branch', () => act(view, 'delete-branch'));
await step('manage: delete branch again', () => act(view, 'delete-branch'));

// ---- worktrees
await step('list: none', () => api.listWorktrees({ details: true }));
await step('preview: none', () => api.previewWorktreeCleanup({ repoCommonDir: null }));
await step('prune: nothing', () => api.pruneWorktrees({ repoCommonDir: null }));
current.id = 's1';
const feat = await api.requestWorktree({ name: 'feat', provision: true, txId: 'p1' });
const featPath = feat.workspace.cwd;
masks.unshift([featPath, '<feat>']);
current = { id: 's2', cwd: repo, desktopSession: { classification: 'project', projectPath: repo }, messages: [] };
cwdRef.cwd = repo;
const feat2 = await api.requestWorktree({ name: 'feat2', provision: true, txId: 'p2' });
const feat2Path = feat2.workspace.cwd;
masks.unshift([feat2Path, '<feat2>']);
writeFileSync(join(feat2Path, 'w.txt'), 'w\n');
git(feat2Path, 'add', '.');
git(feat2Path, 'commit', '-qm', 'work');
current = null;
await step('list: owners gone', () => api.listWorktrees({ details: true }));
await step('preview: clean merged orphan', () => api.previewWorktreeCleanup({ repoCommonDir: null }));
await step('preview: other repository', () => api.previewWorktreeCleanup({ repoCommonDir: join(base, 'other', '.git') }));
await step('archived: mark', () => api.setArchivedSessionWorktrees({ sessionIds: ['s1', 7, ''], archived: true }));
await step('archived: restore', () => api.setArchivedSessionWorktrees({ sessionIds: ['s1'], archived: false }));
await step('archived: none', () => api.setArchivedSessionWorktrees({ sessionIds: [], archived: true }));
await step('delete: unknown entry', () => api.deleteWorktree({ entryId: 'nope' }));
const idAt = async (path) => (await api.listWorktrees({ details: true })).find((r) => r.path === path).id;
await step('delete: unmerged without force', async () => api.deleteWorktree({ entryId: await idAt(feat2Path) }));
await step('prune: removes the clean merged one', () => api.pruneWorktrees({ repoCommonDir: null }));
await step('list: after prune', () => api.listWorktrees({ details: true }));
await step('delete: unmerged with force', async () => api.deleteWorktree({ entryId: await idAt(feat2Path), force: true }));
await step('list: empty again', () => api.listWorktrees({ details: true }));

// ---- a session's own worktree
current = { id: 'solo', cwd: repo, desktopSession: { classification: 'project', projectPath: repo }, messages: [] };
cwdRef.cwd = repo;
const solo = await api.requestWorktree({ name: 'solo-wt', provision: true, txId: 'p3' });
masks.unshift([solo.workspace.cwd, '<solo>']);
await step('remove: stale revision', () => api.removeWorktree({ expectedRevision: 99 }));
await step('remove: session works there', () => api.removeWorktree({}));

restore();

// ---- connectors
const dataDir = join(base, 'connector-data');
mkdirSync(dataDir, { recursive: true });
const SERVERS = ['gmail', 'github', 'notion'].map((name) => ({ name, enabled: true, status: 'connected', connected: true, transport: 'http', toolCount: 1, source: 'config' }));
const helpers = createWorkflowHelpers({ rootDir: join(tree, 'src'), dataDir, readMarkdownDocument, normalizeAgentPermissionOrNone });
const routeHelpers = createWorkflowRouteHelpers({ findPreset: () => null });
const state = { config: { workflow: { active: 'default' } } };
const connectors = createWorkflowAgentsApi({
  ...helpers,
  getConfig: () => state.config,
  displayConfig: () => state.config,
  cfgMod: { getPluginData: () => dataDir },
  STANDALONE_DATA_DIR: dataDir,
  resolveRoute: () => ({ provider: 'openai', model: 'main-model' }),
  agentRouteFromConfig: routeHelpers.agentRouteFromConfig,
  saveConfigAndAdopt: (value) => { state.config = value; },
  lookupModelMeta: async () => ({}),
  ensureProvidersReady: async () => {},
  invalidateContextStatusCache() {},
  mcpStatus: () => ({ servers: SERVERS }),
  getMcpTools: () => [],
  listProjects: () => [{ path: repo }],
  resolveConfiguredMcpCatalog: () => ({ servers: { gmail: {}, github: {}, notion: {} }, warnings: [] }),
});
const NO_WIDEN = { noWiden: true };
const policyFile = () => {
  try { return JSON.parse(readFileSync(join(dataDir, 'project-connectors.json'), 'utf8')); } catch { return null; }
};
masks.push([dataDir, '<connector-data>']);
await step('connectors: all on', () => connectors.getProjectConnectors(repo));
await step('connectors: unregistered project', () => connectors.getProjectConnectors(join(base, 'nowhere')));
await step('connectors: blank project', () => connectors.getProjectConnectors(' '));
await step('connectors: switch notion off', () => connectors.setProjectConnectorEnabled(repo, 'notion', false));
await step('connectors: switch gmail off, remote', () => connectors.setProjectConnectorEnabled(repo, 'gmail', false, NO_WIDEN));
await step('connectors: policy file', () => policyFile());
await step('connectors: remote cannot widen', () => connectors.setProjectConnectorEnabled(repo, 'gmail', true, NO_WIDEN));
await step('connectors: enabled must be boolean', () => connectors.setProjectConnectorEnabled(repo, 'gmail', 'yes'));
await step('connectors: blank connector id', () => connectors.setProjectConnectorEnabled(repo, ' ', true));
await step('connectors: unregistered project set', () => connectors.setProjectConnectorEnabled(join(base, 'nowhere'), 'gmail', false));
await step('connectors: switch gmail on', () => connectors.setProjectConnectorEnabled(repo, 'gmail', true));
await step('connectors: switch notion on', () => connectors.setProjectConnectorEnabled(repo, 'notion', true));
await step('connectors: policy file emptied', () => policyFile());
writeFileSync(join(dataDir, 'project-connectors.json'), '{ not json');
await step('connectors: unreadable file reads deny-all', () => connectors.getProjectConnectors(repo));
await step('connectors: unreadable file is never overwritten', () => connectors.setProjectConnectorEnabled(repo, 'gmail', false));

const finalOut = join(FIXTURES_ROOT, 'project-methods');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'project/* branch, worktree and connector steps of the real 1.4.5 functions; paths, commit ids and times are masked as <repo>, <data>, <base>, <feat>, <feat2>, <solo>, <sha>, <short>, <time>',
  steps,
});
writeSetManifest(out, {
  set: 'project-methods',
  recorder: 'benchmarks/rust-core/recorders/record-project-methods.mjs',
  command: 'node benchmarks/rust-core/recorders/record-project-methods.mjs --tree <tree>',
  extra: { steps: steps.length },
});
commitStage(out, finalOut);
console.log(`steps=${steps.length}`);
