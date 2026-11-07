#!/usr/bin/env node
// Genuine 1.4.5 behaviour of the desktop's "move to project" refusals, for the session core's
// `thread/metadata/update{projectPath}`: the real `SessionHost` lifecycle `setSessionProject` over the
// catalog rows and live states of the situations that refuse (or allow) it.
//
//   node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-project-move.mjs --tree <tree>
// Output: native/core/fixtures/project-move/golden.json
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const root = mkdtempSync(join(tmpdir(), 'project-move-'));

// An isolated environment, set before anything of the product loads.
for (const name of ['data', 'home', 'appdata', 'local']) mkdirSync(join(root, name), { recursive: true });
Object.assign(process.env, {
  MIXDOG_DATA_DIR: join(root, 'data'),
  MIXDOG_HOME: join(root, 'home'),
  HOME: join(root, 'home'),
  USERPROFILE: join(root, 'home'),
  APPDATA: join(root, 'appdata'),
  LOCALAPPDATA: join(root, 'local'),
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
});

const { SessionHost } = await importFrom(tree, 'apps/desktop/src/main/session-host.ts');

const project = join(root, 'repo');
const worktree = join(root, 'data', 'worktrees-v1', '0123456789abcdef', 'fix-login');
const elsewhere = join(root, 'elsewhere');
for (const dir of [project, worktree, elsewhere]) mkdirSync(dir, { recursive: true });
const host = await SessionHost.create(
  { userDataPath: root, resourcesPath: root, appPath: root, packaged: false },
  {
    attachSessionClient: async () => ({ list: async () => ({ sessions: [] }), close: async () => {} }),
    loadProjects: async () => ({
      listProjects: () => [{ name: 'repo', path: project, addedAt: 1 }],
      listProjectsStrict: () => [{ name: 'repo', path: project, addedAt: 1 }],
    }),
    loadWorktrees: async () => ({ getWorktreeByPath: () => null }),
    loadSessionStore: async () => ({}),
    loadStatuslineSegments: async () => ({}),
    executeCodeGraphTool: async () => ({}),
  }
);
const invoked = [];
host.transport.invokeSession = async (sessionId, method, args) => {
  invoked.push([sessionId, method, args]);
  return { value: args[0], snapshot: null, result: {} };
};
host.catalog.publishCatalogs = async () => {};
const task = join(root, 'workspace', 'unclassified');

// Where a session works, and what a target names, by the names the fixture uses.
const WHERE = {
  task: { cwd: elsewhere, projectPath: null },
  project: { cwd: join(project, 'src'), projectPath: project },
  worktree: {
    cwd: worktree,
    projectPath: project,
    workspace: { projectPath: project, cwd: worktree, worktreeId: 'fix-login' },
  },
};
const TARGET = { project, task: '', elsewhere };
const named = (cwd) => (cwd === project ? 'project' : cwd === task ? 'task' : cwd);

const moves = [];
/** One move: where the session works, the catalog's `leadWorking`, the live snapshot the host
 *  holds, and the target. The outcome is the runtime's `setCwd` it made, or the refusal's text. */
async function move(name, note, { where, working = false, live = null, target, listed = true }) {
  const id = `sess_move_${moves.length + 1}`;
  const row = { id, ...WHERE[where], ...(working ? { working: true, leadWorking: true } : {}) };
  host.listSessions = async () => (listed ? [row] : []);
  host.publication.projections.delete(id);
  if (live) host.publication.projections.set(id, { snapshot: live });
  const before = invoked.length;
  let outcome;
  try {
    await host.setSessionProject(id, TARGET[target]);
    outcome = { moved: invoked.slice(before).map(([, method, args]) => ({ method, cwd: named(args[0]) })) };
  } catch (error) {
    outcome = { error: error.message };
  }
  moves.push({ name, note, listed, where, working, live, target, ...outcome });
}
await move('moves-into-project', 'an idle task session moves into a registered Project', { where: 'task', target: 'project' });
await move('moves-to-task', 'an idle Project session moves out to the task workspace', { where: 'project', target: 'task' });
await move('already-there', 'a session already in that Project stays put', { where: 'project', target: 'project' });
await move('already-task', 'a task session asked for "no Project" stays put', { where: 'task', target: 'task' });
await move('unlisted', 'the catalog does not list the session', { where: 'task', target: 'project', listed: false });
await move('not-registered', 'the target is not a registered Project', { where: 'task', target: 'elsewhere' });
await move('lead-working', 'the catalog row says the session\'s own turn is in flight', {
  where: 'task',
  working: true,
  target: 'project',
});
await move('live-busy', 'the live state is busy', { where: 'task', live: { busy: true }, target: 'project' });
await move('live-command-busy', 'a compaction is running', { where: 'task', live: { commandBusy: true }, target: 'project' });
await move('live-idle', 'a live state that is neither busy nor running a command', {
  where: 'task',
  live: { busy: false, commandBusy: false },
  target: 'project',
});
await move('worktree', 'the session works in a managed worktree', { where: 'worktree', target: 'task' });
await move('busy-before-worktree', 'a busy session in a worktree is refused for the turn first', {
  where: 'worktree',
  working: true,
  target: 'task',
});
await move('same-project-while-busy', 'a busy session already in that Project is not refused', {
  where: 'project',
  working: true,
  target: 'project',
});

const rel = 'benchmarks/rust-core/recorders/record-project-move.mjs';
const setDir = join(FIXTURES_ROOT, 'project-move');
writeJson(join(setDir, 'golden.json'), { domain: 'project-move', recorder: rel, moves });
const command = `node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs ${rel} --tree <tree>`;
writeSetManifest(setDir, { set: 'project-move', recorder: rel, command });
console.log(`recorded ${moves.length} project moves`);
await host.dispose().catch(() => {});
process.exit(0);
