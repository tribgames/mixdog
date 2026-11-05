// Records the session worktree refusal and transition texts of the Node implementation into
// goldens.json, which `worktree_goldens.rs` compares the Rust port against byte for byte.
//
//   node record.mjs [path-to-mixdog-node-checkout]   (default C:/Project/mixdog)
//
// Every scenario runs on a fresh real git repository and data dir. Machine paths are replaced
// by <REPO>, <WT> and <DATA> so the file is stable across runs.
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.argv[2] ?? 'C:/Project/mixdog';
const load = (path) => import(pathToFileURL(`${ROOT}/${path}`).href);

const { configureWorktreeManager } = await load('src/runtime/shared/worktrees/manager.mjs');
const { samePath } = await load('src/runtime/shared/worktrees/paths.mjs');
const support = await load('src/runtime/shared/worktrees/test-support.mjs');
const { createWorkspaceTransitions } = await load('src/session-runtime/workspace/transitions.mjs');
const { createWorktreeToolHost } = await load('src/session-runtime/workspace/worktree-tool.mjs');
const { restoreWorkspaceAfterResume } = await load('src/session-runtime/workspace/workspace-state.mjs');
const gate = await load('src/session-runtime/workspace/admission-gate.mjs');
const { commitFile, git, makeRepo, useTempDataDir, writeFile } = support;

const LEAD = 'lead';

function fixture({ autoCleanup = true, activeTurns = 0, live = [], sourceType = 'lead' } = {}) {
  const data = useTempDataDir();
  const restore = configureWorktreeManager({
    settings: {},
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    processAlive: () => false,
  });
  const repo = makeRepo();
  commitFile(repo, 'f.txt', 'a\nb\nc\n', 'init f');
  const session = {
    id: LEAD,
    owner: 'user',
    sourceType,
    cwd: repo,
    desktopSession: { classification: 'project', projectPath: repo },
    messages: [],
  };
  const api = createWorkspaceTransitions({
    getSession: () => session,
    getCurrentCwd: () => session.cwd,
    getConfig: () => ({ worktree: { autoCleanup } }),
    applyResolvedCwd: (next) => {
      session.cwd = next;
    },
    persistSession: () => {},
    refreshWorkspaceContext: async () => {},
    getActiveTurnCount: () => activeTurns,
    agentStatusState: () => ({ agentWorkers: [], agentJobs: [] }),
    countOwnShellJobs: async () => 0,
    listLiveSessions: () => live,
    listStoredSessionIds: async () => [],
    listWorkspaceConsumers: async () => [],
    listWorkspaceJobs: async () => [],
    findRegisteredProject: async (path) => (samePath(path, repo) ? repo : null),
  });
  const host = createWorktreeToolHost({
    getSession: () => session,
    getWorkspaceApi: () => api,
    executeSessionControl: async (args) => {
      throw new Error(`session ${args.session_id} is not available`);
    },
  });
  const run = (request) => host.run(request, { callerSessionId: LEAD });
  return { data, repo, session, api, run, restore, roots: { '<REPO>': repo, '<DATA>': data } };
}

const failure = (error) => ({
  error: { code: error.code ?? null, message: error.message, details: error.details ?? null },
});
const capture = async (work) => {
  try {
    return { ok: await work() };
  } catch (error) {
    return failure(error);
  }
};

function normalize(value, roots) {
  const forms = [];
  for (const [label, path] of Object.entries(roots)) {
    let real = path;
    try {
      real = realpathSync(path);
    } catch {
      // A removed worktree keeps only its given spelling.
    }
    for (const form of new Set([path, real])) {
      forms.push([form, label], [form.replaceAll('\\', '/'), label]);
    }
  }
  forms.sort((a, b) => b[0].length - a[0].length);
  const walk = (node) => {
    if (typeof node === 'string') {
      let out = node;
      for (const [form, label] of forms) out = out.split(form).join(label);
      // Spell separators as `/`: the Rust side compares on every platform.
      return out.replaceAll('\\', '/');
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    return node;
  };
  return walk(value);
}

const goldens = {};
async function scenario(name, body) {
  const f = fixture(body.options);
  try {
    const result = await body.run(f);
    goldens[name] = normalize(result, { ...f.roots, ...(result.__roots ?? {}) });
    delete goldens[name].__roots;
  } finally {
    f.restore();
  }
}
const enterFeat = (f) => f.run({ op: 'enter', name: 'feat', txId: 'c1:enter' });
const worktreeOf = (entered) => entered.workspace.cwd;

await scenario('dirty_choice', {
  run: async (f) => {
    writeFile(f.repo, 'f.txt', 'changed\n');
    return await capture(() => enterFeat(f));
  },
});

await scenario('stale_revision', {
  run: async (f) =>
    await capture(() => f.api.selectBranch({ branch: 'x', expectedRevision: 5 }, { ownTurn: true })),
});

await scenario('turn_running', {
  options: { activeTurns: 1 },
  run: async (f) => await capture(() => f.api.selectBranch({ branch: 'x', create: true })),
});

await scenario('dirty_worktree_remove', {
  run: async (f) => {
    const entered = await enterFeat(f);
    writeFile(worktreeOf(entered), 'new.txt', 'wip\n');
    const result = await capture(() => f.run({ op: 'remove', txId: 'c2:remove' }));
    return { ...result, __roots: { '<WT>': worktreeOf(entered) } };
  },
});

await scenario('merge_cleanup_refused', {
  run: async (f) => {
    const entered = await enterFeat(f);
    commitFile(worktreeOf(entered), 'g.txt', 'x\n');
    const merged = await f.run({ op: 'merge', txId: 'c2:merge' });
    return { merged: merged.merged, cleanup: merged.cleanup, __roots: { '<WT>': worktreeOf(entered) } };
  },
});

await scenario('merge_cleanup_off', {
  options: { autoCleanup: false },
  run: async (f) => {
    const entered = await enterFeat(f);
    commitFile(worktreeOf(entered), 'g.txt', 'x\n');
    const merged = await f.run({ op: 'merge', txId: 'c2:merge' });
    return { merged: merged.merged, cleanup: merged.cleanup, __roots: { '<WT>': worktreeOf(entered) } };
  },
});

await scenario('remove_branch_not_owned', {
  run: async (f) => await capture(() => f.run({ op: 'remove', branch: 'other', txId: 'c1:remove' })),
});

await scenario('remove_path_unmanaged', {
  run: async (f) => await capture(() => f.run({ op: 'remove-path', path: join(f.repo, 'nowhere') })),
});

await scenario('unattended_session', {
  options: { sourceType: 'schedule' },
  run: async (f) => {
    const out = {};
    for (const op of ['enter', 'return', 'merge', 'remove']) {
      out[op] = await capture(() => f.run({ op, name: 'feat', txId: `u:${op}` }));
    }
    return out;
  },
});

await scenario('worktree_missing_turn', {
  run: async (f) => {
    const entered = await enterFeat(f);
    const worktree = worktreeOf(entered);
    rmSync(worktree, { recursive: true, force: true });
    f.session.workspace = restoreWorkspaceAfterResume(f.session);
    const refused = await capture(() => f.api.prepareTurnWorkspace({ submissionId: 'sub1' }));
    return { ...refused, __roots: { '<WT>': worktree } };
  },
});

await scenario('project_folder_in_use', {
  options: { live: [] },
  run: async (f) => {
    git(f.repo, 'branch', 'feature');
    const live = [{ id: 'other', cwd: join(f.repo, 'sub'), status: 'running' }];
    const guarded = createWorkspaceTransitions({
      getSession: () => f.session,
      getCurrentCwd: () => f.session.cwd,
      applyResolvedCwd: () => {},
      persistSession: () => {},
      refreshWorkspaceContext: async () => {},
      getActiveTurnCount: () => 0,
      agentStatusState: () => ({ agentWorkers: [], agentJobs: [] }),
      countOwnShellJobs: async () => 0,
      listLiveSessions: () => live,
      listStoredSessionIds: async () => [],
      listWorkspaceConsumers: async () => [],
      listWorkspaceJobs: async () => [],
      findRegisteredProject: async () => f.repo,
    });
    return await capture(() => guarded.selectProjectBranch({ projectPath: f.repo, branch: 'feature' }));
  },
});

await scenario('input_validation', {
  run: async (f) => ({
    invalid_name: await capture(() => f.api.requestWorktree({ name: 'Bad Name!', provision: true, txId: 'v1' })),
    bad_carry: await capture(() =>
      f.api.requestWorktree({ name: 'ok', provision: true, carryChanges: 'bogus', txId: 'v2' })
    ),
    empty_branch: await capture(() => f.api.selectBranch({ branch: '', txId: 'v3' })),
    bad_branch: await capture(() => f.api.selectBranch({ branch: 'a..b', create: true, txId: 'v4' })),
  }),
});

// The three call sites that refuse `reason: 'transition'`, each with its own text.
await scenario('transition_texts', {
  run: async (f) => {
    const begin = (id) => gate.beginWorkspaceTransition(id, 'tx');
    const leave = begin('s-a');
    const session = await capture(async () => begin('s-a'));
    const spawn = await capture(async () => gate.enterWorkerSpawn(['s-a']));
    leave();
    const release = gate.holdCheckoutFolder('s-b', f.repo);
    const folder = await capture(async () => gate.holdCheckoutFolder('s-c', join(f.repo, 'sub')));
    release();
    return { session, spawn, folder };
  },
});

const out = join(dirname(fileURLToPath(import.meta.url)), 'goldens.json');
writeFileSync(out, `${JSON.stringify(goldens, null, 2)}\n`);
rmSync(process.env.MIXDOG_DATA_DIR ?? out + '.none', { recursive: true, force: true });
console.log(`recorded ${Object.keys(goldens).length} scenarios -> ${out}`);
