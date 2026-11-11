#!/usr/bin/env node
// What Node's host (b6f10295a) answers a paired phone for its branch, worktree and review calls: `invokeCapability` for the sixteen
// worktree capabilities and the five review reads, over the inputs the page can send (the argument left out, the page's `undefined`
// as the relay's JSON carried it, null, a wrong type, an empty value, a folder that is no Project, an id nobody knows, and the valid
// forms). Recorded from an exact export: the relay's own frame executor (`executeRemoteFrame` over `createRemoteMethods`,
// remote-methods.ts) with the real desktop host (`SessionHost`, session-host.ts) attached to the real Node daemon of the same tree
// (session-client.mjs `ensureDaemon`/`attachSession`), in an isolated profile with a git repository registered as a Project and one
// session in it. Per call the recording holds the request the page sent, the frame the relay answered (whole, the session snapshot a
// non-value-only answer carries included) and the repository afterwards (refs, HEAD and worktrees).
//
//   node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-phone-worktree.mjs --tree <git archive of b6f10295a with node_modules> [--only <group>]
//
// With `--replay <mixdogd.exe>` the same cases run through the phone's router and adapters (renderer/remote-protocol-worktree.ts,
// renderer/remote-protocol-review.ts) on a phone paired behind a scripted relay with a built `mixdogd`, in the same world at the same
// paths, and each case is compared whole with the recording: the frame and the repository.
//
// Each group runs in a world of its own (made again, a daemon of its own), so `--only` records or replays exactly what the full run
// holds for that group.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { commitStage, exactProductIdentity, importFrom, parseArgs, REPO_ROOT, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { startRelay } from './lib/phone-relay-core.mjs';
import { recorderProvenance } from './lib/provenance.mjs';
import { RecorderError } from './lib/recorder-error.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const FIXTURES = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'phone-worktree');
const WORK = process.env.PHONE_WORKTREE_WORK ?? join('D:\\mixdog-build\\tmp', `${REPO_ROOT.split(/[\\/]/).pop()}-phone-worktree`);
/** Node's daemon supervisor (v0.1.1, sha256-checked by the real-turn harness that cached it): a fresh profile would otherwise download it. */
const SUPERVISOR = 'D:\\mixdog-build\\tmp\\real-turn-harness\\cache\\supervisor-v0.1.1\\mixdog-supervisor-win32-x64.exe';
const args = parseArgs();
const REPLAY = args.get('replay') ?? null;
const ONLY = args.get('only') ?? null;
// The daemon's preload (and its hooks) is loaded by Node's daemon, not by this module: named as inputs.
const PROVENANCE = recorderProvenance(import.meta.url, ['benchmarks/rust-core/recorders/lib/status-clock-preload.mjs', 'benchmarks/rust-core/recorders/lib/status-clock-hooks.mjs']);
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));
const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);

// ── the world, the same for both products and at the same paths ──
const PATHS = {
  home: join(WORK, 'home'),
  mixdogHome: join(WORK, 'home', '.mixdog'),
  data: join(WORK, 'home', '.mixdog', 'data'),
  runtime: join(WORK, 'runtime'),
  appData: join(WORK, 'home', 'AppData', 'Roaming'),
  localAppData: join(WORK, 'home', 'AppData', 'Local'),
  tmp: join(WORK, 'tmp'),
  // The desktop's profile where the core keeps it (compose_flip.rs `user_data_dir`): the project-less session works in its
  // `workspace/unclassified` (session-host.ts), whose path answers carry.
  userData: join(WORK, 'home', '.mixdog', 'data', 'userdata'),
  project: join(WORK, 'project'),
  elsewhere: join(WORK, 'elsewhere'),
};
/** Every commit, the fixture's and the ones the products make (merges), has this author, committer and time. */
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
};
/** A session runs only with a model to route to: one custom provider with one manual model, never called (no case starts a turn). */
const SEED_CONFIG = {
  agent: {
    providers: {
      'custom-fixture': {
        type: 'custom',
        schemaVersion: 2,
        name: 'fixture',
        protocol: 'openai-chat',
        baseURL: 'http://127.0.0.1:9/v1',
        auth: 'none',
        enabled: true,
        modelOverrides: { 'fixture-model': { manual: true }, 'fixture-wide': { manual: true, contextWindow: 200000 } },
      },
    },
  },
};
/** The session's route: the fixture's model. */
const ROUTE = { provider: 'custom-fixture', model: 'fixture-model' };
/** The model a session switches to mid-group: its configured window differs from the fixture model's. */
const WIDE_ROUTE = { provider: 'custom-fixture', model: 'fixture-wide' };/** The profile both products run in: a parent variable that could reach a real profile, service or key is dropped. */
function isolatedEnv() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(MIXDOG_|GIT_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|XDG_|ELECTRON_)/i.test(name)) env[name] = value;
  }
  return {
    ...env,
    ...GIT_IDENTITY,
    MIXDOG_DATA_DIR: PATHS.data,
    MIXDOG_HOME: PATHS.mixdogHome,
    MIXDOG_CONFIG_DIR: PATHS.mixdogHome,
    MIXDOG_DESKTOP_USER_DATA: PATHS.userData,
    MIXDOG_RUNTIME_ROOT: PATHS.runtime,
    MIXDOG_SKIP_USER_DATA_BACKUP: '1',
    MIXDOG_SUPERVISOR_BIN: SUPERVISOR,
    MIXDOG_DAEMON_SKIP_MEMORY: '1',
    MIXDOG_DISABLE_MCP: '1',
    // Node drops an idle session's wire projection after 90 s of real time (and its runtime after 5 min) and rebuilds it with the
    // status fields empty until the next pass (session-service.mjs:97-101, retention.mjs:127-143): which case met a rebuilt one
    // depended on how long the run took. Both stay out of reach of a run; a rebuild is no content (manifest `settledStatus`).
    MIXDOG_SESSION_PROJECTION_IDLE_MS: '86400000',
    MIXDOG_SESSION_IDLE_EVICT_MS: '86400000',
    HOME: PATHS.home,
    USERPROFILE: PATHS.home,
    APPDATA: PATHS.appData,
    LOCALAPPDATA: PATHS.localAppData,
    TEMP: PATHS.tmp,
    TMP: PATHS.tmp,
    TMPDIR: PATHS.tmp,
    NO_PROXY: '127.0.0.1,localhost',
  };
}
const ENV = isolatedEnv();
const git = (cwd, ...gitArgs) => {
  const run = spawnSync('git', gitArgs, { cwd, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (run.status !== 0) throw new Error(`git ${gitArgs.join(' ')} failed: ${run.stderr || run.error}`);
  return run.stdout.trim();
};
/** The repository: `main` (a.txt), `feature` (b.txt on main) and `spare` (c.txt on main), `main` checked out; the review group also
 *  leaves a.txt changed and not committed. A folder beside it is no Project. */
function makeWorld(group) {
  rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  for (const dir of [PATHS.data, PATHS.runtime, PATHS.appData, PATHS.localAppData, PATHS.tmp, PATHS.userData, PATHS.project, PATHS.elsewhere]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(PATHS.data, 'mixdog-config.json'), JSON.stringify(SEED_CONFIG, null, 2));
  const repo = PATHS.project;
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'alpha\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  for (const [branch, file, text] of [
    ['feature', 'b.txt', 'beta\n'],
    ['spare', 'c.txt', 'gamma\n'],
  ]) {
    git(repo, 'checkout', '-q', '-b', branch, 'main');
    writeFileSync(join(repo, file), text);
    git(repo, 'add', file);
    git(repo, 'commit', '-q', '-m', `${branch} work`);
  }
  git(repo, 'checkout', '-q', 'main');
  if (group === 'review') writeFileSync(join(repo, 'a.txt'), 'alpha\nchanged on the PC\n');
}
/** The repository as a case left it: every ref, HEAD and the worktrees git knows. */
const repository = () => ({
  // A detached HEAD names its commit.
  head: git(PATHS.project, 'rev-parse', '--abbrev-ref', 'HEAD') === 'HEAD' ? git(PATHS.project, 'rev-parse', 'HEAD') : git(PATHS.project, 'rev-parse', '--abbrev-ref', 'HEAD'),
  refs: git(PATHS.project, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter(Boolean),
  worktrees: git(PATHS.project, 'worktree', 'list', '--porcelain').split('\n').filter(Boolean),
});

// ── the cases: what the page sends ──
// A request is the page's `invokeCapability(request)` (worktree-branch-model.ts invokeWorktree, session-diff-cache.ts,
// session-changes-store.ts, turn-review-model.ts, turn-changes-model.ts). `undefined` is what the page's code leaves undefined; the
// relay's JSON carries it (an array's as null, an object's not at all), exactly as Node's relay did. `$NAME` is filled from the
// world when the case runs: $PROJECT, $ELSEWHERE, $COMMON_DIR, the session ($SESSION, an id nobody has: $NO_SESSION), the branch
// tips ($MAIN, $FEATURE, $SPARE, read from the repository then) and the session's workspace revision ($REVISION, the last one an
// answer showed; $STALE is far past it).
const cap = (capability, capArgs, sessionId) => ({ capability, ...(capArgs === undefined ? {} : { args: capArgs }), ...(sessionId === undefined ? {} : { sessionId }) });
const S = '$SESSION';
const GROUPS = {
  project: [
    // getProjectBranchMenu: arity, the input object, its projectPath, a folder that is no Project, an unsupported field, valid.
    cap('getProjectBranchMenu', []),
    cap('getProjectBranchMenu', [undefined]),
    cap('getProjectBranchMenu', [null]),
    cap('getProjectBranchMenu', ['$PROJECT']),
    cap('getProjectBranchMenu', [{}]),
    cap('getProjectBranchMenu', [{ projectPath: undefined }]),
    cap('getProjectBranchMenu', [{ projectPath: '' }]),
    cap('getProjectBranchMenu', [{ projectPath: '   ' }]),
    cap('getProjectBranchMenu', [{ projectPath: 42 }]),
    cap('getProjectBranchMenu', [{ projectPath: '$ELSEWHERE' }]),
    cap('getProjectBranchMenu', [{ projectPath: '$PROJECT', branch: 'main' }]),
    cap('getProjectBranchMenu', [{ projectPath: '$PROJECT' }]),
    cap('getProjectBranchMenu', [{ projectPath: '$PROJECT' }, {}]),
    // inspectProjectBranch: arity, the input object, its fields, then the branch.
    cap('inspectProjectBranch', []),
    cap('inspectProjectBranch', [undefined]),
    cap('inspectProjectBranch', ['feature']),
    cap('inspectProjectBranch', [42]),
    cap('inspectProjectBranch', [[]]),
    cap('inspectProjectBranch', [{ projectPath: '$PROJECT', branch: 'feature' }, {}]),
    cap('inspectProjectBranch', [{ projectPath: '$PROJECT', branch: 'feature', extra: 1 }]),
    cap('inspectProjectBranch', [{ branch: 'feature' }]),
    cap('inspectProjectBranch', [{ projectPath: 7, branch: 'feature' }]),
    cap('inspectProjectBranch', [{ projectPath: '$PROJECT', branch: 'f'.repeat(256) }]),
    cap('inspectProjectBranch', [{ projectPath: '$PROJECT' }]),
    cap('inspectProjectBranch', [{ projectPath: '$PROJECT', branch: undefined }]),
    cap('inspectProjectBranch', [{ projectPath: '$PROJECT', branch: '' }]),
    cap('inspectProjectBranch', [{ projectPath: '$PROJECT', branch: null }]),
    cap('inspectProjectBranch', [{ projectPath: '$ELSEWHERE', branch: 'feature' }]),
    cap('inspectProjectBranch', [{ projectPath: '$PROJECT', branch: 'nope' }]),
    cap('inspectProjectBranch', [{ projectPath: '$PROJECT', branch: 'feature' }]),
    cap('inspectProjectBranch', [{ projectPath: '$PROJECT', branch: 'main' }]),
    // selectProjectBranch: the branch, the exclusive flags, a start point or a detach that is no commit id, valid moves.
    cap('selectProjectBranch', []),
    cap('selectProjectBranch', [null]),
    cap('selectProjectBranch', ['main']),
    cap('selectProjectBranch', [{ projectPath: '$PROJECT', branch: 'feature', extra: 1 }]),
    cap('selectProjectBranch', [{ branch: 'feature' }]),
    cap('selectProjectBranch', [{ projectPath: '$PROJECT', branch: 'feature', remote: 'yes' }]),
    cap('selectProjectBranch', [{ projectPath: '$PROJECT', branch: 'made', create: true, startPoint: 'main' }]),
    cap('selectProjectBranch', [{ projectPath: '$PROJECT', detach: '$FEATURE', create: undefined }]),
    cap('selectProjectBranch', [{ projectPath: '$PROJECT' }]),
    cap('selectProjectBranch', [{ projectPath: '$PROJECT', branch: 'made', create: true, remote: true }]),
    cap('selectProjectBranch', [{ projectPath: '$PROJECT', branch: 'made', startPoint: '$MAIN' }]),
    cap('selectProjectBranch', [{ projectPath: '$PROJECT', branch: 'made', create: 'yes' }]),
    cap('selectProjectBranch', [{ projectPath: '$PROJECT', detach: 'main' }]),
    cap('selectProjectBranch', [{ projectPath: '$PROJECT', detach: '$FEATURE', branch: 'feature' }]),
    cap('selectProjectBranch', [{ projectPath: '$PROJECT', branch: 'feature', remote: undefined, create: undefined }]),
    cap('selectProjectBranch', [{ projectPath: '$ELSEWHERE', branch: 'feature' }]),
    cap('selectProjectBranch', [{ projectPath: '$PROJECT', branch: 'nope' }]),
    cap('selectProjectBranch', [{ projectPath: '$PROJECT', branch: 'main' }]),
    cap('selectProjectBranch', [{ projectPath: '$PROJECT', branch: 'made', create: true, startPoint: '$MAIN' }]),
    cap('selectProjectBranch', [{ projectPath: '$PROJECT', detach: '$FEATURE' }]),
    cap('selectProjectBranch', [{ projectPath: '$PROJECT', branch: 'main' }]),
    // mergeProjectBranch
    cap('mergeProjectBranch', []),
    cap('mergeProjectBranch', [undefined]),
    cap('mergeProjectBranch', ['feature']),
    cap('mergeProjectBranch', [{ projectPath: '$PROJECT', branch: 'feature', target: 'main', extra: 1 }]),
    cap('mergeProjectBranch', [{ branch: 'feature', target: 'main' }]),
    cap('mergeProjectBranch', [{ projectPath: '$PROJECT', branch: 'feature', target: '' }]),
    cap('mergeProjectBranch', [{ projectPath: '$PROJECT', branch: 'feature' }]),
    cap('mergeProjectBranch', [{ projectPath: '$PROJECT', branch: 'feature', target: undefined }]),
    cap('mergeProjectBranch', [{ projectPath: '$PROJECT', target: 'main' }]),
    cap('mergeProjectBranch', [{ projectPath: '$ELSEWHERE', branch: 'feature', target: 'main' }]),
    cap('mergeProjectBranch', [{ projectPath: '$PROJECT', branch: 'feature', target: 'spare' }]),
    cap('mergeProjectBranch', [{ projectPath: '$PROJECT', branch: 'nope', target: 'main' }]),
    cap('mergeProjectBranch', [{ projectPath: '$PROJECT', branch: 'feature', target: 'main' }]),
    // manageProjectBranch: the commit ids, the action, the confirmation, `force` outside delete-branch, valid deletes.
    cap('manageProjectBranch', []),
    cap('manageProjectBranch', [null]),
    cap('manageProjectBranch', ['spare']),
    cap('manageProjectBranch', [{ projectPath: '$PROJECT', branch: 'spare', action: 'delete-branch', commit: '$SPARE', target: 'main', targetCommit: '$MAIN', confirmed: true, extra: 1 }]),
    cap('manageProjectBranch', [{ branch: 'spare', action: 'delete-branch', commit: '$SPARE', target: 'main', targetCommit: '$MAIN', confirmed: true }]),
    cap('manageProjectBranch', [{ projectPath: '$PROJECT', action: 'delete-branch', commit: '$SPARE', target: 'main', targetCommit: '$MAIN', confirmed: true }]),
    cap('manageProjectBranch', [{ projectPath: '$PROJECT', branch: 'spare', action: 'delete-branch', commit: '$SPARE', target: 'main', targetCommit: '$MAIN', confirmed: true, force: 'yes' }]),
    cap('manageProjectBranch', [{ projectPath: '$PROJECT', branch: 'spare', action: 'delete-branch', commit: '$SPARE', targetCommit: '$MAIN', confirmed: true }]),
    cap('manageProjectBranch', [{ projectPath: '$PROJECT', branch: 'spare', commit: '$SPARE', target: 'main', targetCommit: '$MAIN', confirmed: true }]),
    cap('manageProjectBranch', [{ projectPath: '$PROJECT', branch: 'spare', action: 'delete-branch', commit: '$SPARE', target: 'main', targetCommit: '$MAIN', confirmed: 'true' }]),
    cap('manageProjectBranch', [{ projectPath: '$PROJECT', branch: 'spare', action: 'delete-branch', commit: '$SPARE', target: 'main', targetCommit: '$MAIN' }]),
    cap('manageProjectBranch', [{ projectPath: '$PROJECT', branch: 'spare', action: 'delete-branch', commit: 'spare', target: 'main', targetCommit: '$MAIN', confirmed: true }]),
    cap('manageProjectBranch', [{ projectPath: '$PROJECT', branch: 'spare', action: 'delete-branch', commit: '$SPARE', target: 'main', confirmed: true }]),
    cap('manageProjectBranch', [{ projectPath: '$PROJECT', branch: 'spare', action: 'rename', commit: '$SPARE', target: 'main', targetCommit: '$MAIN', confirmed: true }]),
    cap('manageProjectBranch', [{ projectPath: '$PROJECT', branch: 'spare', action: 'merge', commit: '$SPARE', target: 'main', targetCommit: '$MAIN', confirmed: true, force: true }]),
    cap('manageProjectBranch', [{ projectPath: '$PROJECT', branch: 'spare', action: 'remove-worktree', commit: '$SPARE', confirmed: true }]),
    cap('manageProjectBranch', [{ projectPath: '$ELSEWHERE', branch: 'spare', action: 'delete-branch', commit: '$SPARE', target: 'main', targetCommit: '$MAIN', confirmed: true }]),
    cap('manageProjectBranch', [{ projectPath: '$PROJECT', branch: 'spare', action: 'delete-branch', commit: '$FEATURE', target: 'main', targetCommit: '$MAIN', confirmed: true }]),
    cap('manageProjectBranch', [{ projectPath: '$PROJECT', branch: 'spare', action: 'delete-branch', commit: '$SPARE', target: 'main', targetCommit: '$MAIN', confirmed: true }]),
    cap('manageProjectBranch', [{ projectPath: '$PROJECT', branch: 'spare', action: 'delete-branch', commit: '$SPARE', target: 'main', targetCommit: '$MAIN', confirmed: true, force: true }]),
    cap('getProjectBranchMenu', [{ projectPath: '$PROJECT' }]),
  ],
  session: [
    // getBranchMenu: the session's, the control session's, a session nobody has, arity.
    cap('getBranchMenu', [], S),
    cap('getBranchMenu', undefined, S),
    cap('getBranchMenu', []),
    cap('getBranchMenu', [], '$NO_SESSION'),
    cap('getBranchMenu', [{}], S),
    // selectBranch
    cap('selectBranch', [], S),
    cap('selectBranch', [undefined], S),
    cap('selectBranch', ['feature'], S),
    cap('selectBranch', [{}], S),
    cap('selectBranch', [{ branch: '' }], S),
    cap('selectBranch', [{ branch: 'feature', create: 'yes' }], S),
    cap('selectBranch', [{ branch: 'feature', expectedRevision: -1 }], S),
    cap('selectBranch', [{ branch: 'feature', expectedRevision: '$REVISION_TEXT' }], S),
    cap('selectBranch', [{ branch: 'feature', expectedRevision: undefined, confirmLarge: undefined }], S),
    cap('selectBranch', [{ branch: 'feature', name: 'x' }], S),
    cap('selectBranch', [{ branch: 'feature', confirmLarge: 'yes' }], S),
    cap('selectBranch', [{ branch: 'feature' }, {}], S),
    cap('selectBranch', [null], S),
    cap('selectBranch', [{ branch: 'feature', expectedRevision: '$REVISION' }], '$NO_SESSION'),
    cap('selectBranch', [{ branch: 'feature', expectedRevision: '$STALE' }], S),
    cap('selectBranch', [{ branch: 'nope', expectedRevision: '$REVISION' }], S),
    cap('selectBranch', [{ branch: 'feature', expectedRevision: '$REVISION' }], S),
    cap('getBranchMenu', [], S),
    cap('selectBranch', [{ branch: 'main', expectedRevision: '$REVISION' }], S),
    cap('selectBranch', [{ branch: 'fresh', create: true, expectedRevision: '$REVISION' }], S),
    cap('selectBranch', [{ branch: 'main', expectedRevision: '$REVISION' }], S),
    // requestWorktree
    cap('requestWorktree', [null], S),
    cap('requestWorktree', ['wt'], S),
    cap('requestWorktree', [{ carryChanges: 'move' }], S),
    cap('requestWorktree', [{ name: '' }], S),
    cap('requestWorktree', [{ provision: 'yes' }], S),
    cap('requestWorktree', [{ expectedRevision: 1.5 }], S),
    cap('requestWorktree', [{ branch: 'x' }], S),
    cap('requestWorktree', [{ confirmLarge: 'yes' }], S),
    cap('requestWorktree', [{ name: 7 }], S),
    cap('requestWorktree', [{}, {}], S),
    cap('requestWorktree', [[]], S),
    cap('requestWorktree', [{ expectedRevision: '$STALE', provision: true }], S),
    cap('requestWorktree', [{ expectedRevision: '$REVISION', provision: true }], '$NO_SESSION'),
    cap('requestWorktree', [{ expectedRevision: '$REVISION', provision: true, name: null }], S),
    cap('getBranchMenu', [], S),
    cap('listWorktrees', []),
    // mergeWorkspace
    cap('mergeWorkspace', [], S),
    cap('mergeWorkspace', [{}], S),
    cap('mergeWorkspace', [{ confirmed: true }], S),
    cap('mergeWorkspace', [{ confirmed: true, target: 'main', cleanup: 'yes' }], S),
    cap('mergeWorkspace', [{ confirmed: 'true', target: 'main' }], S),
    cap('mergeWorkspace', [undefined], S),
    cap('mergeWorkspace', ['main'], S),
    cap('mergeWorkspace', [{ confirmed: true, target: 'main', extra: 1 }], S),
    cap('mergeWorkspace', [{ confirmed: true, target: 'main', expectedRevision: -1 }], S),
    cap('mergeWorkspace', [{ confirmed: true, target: 'main' }, {}], S),
    cap('mergeWorkspace', [{ confirmed: true, target: 'main', expectedRevision: '$STALE' }], S),
    cap('mergeWorkspace', [{ confirmed: true, target: 'main', expectedRevision: '$REVISION' }], S),
    // removeWorktree
    cap('removeWorktree', [null], S),
    cap('removeWorktree', ['wt'], S),
    cap('removeWorktree', [{}, {}], S),
    cap('removeWorktree', [{ force: 'yes' }], S),
    cap('removeWorktree', [{ expectedRevision: -2 }], S),
    cap('removeWorktree', [{ keep: true }], S),
    cap('removeWorktree', [{ expectedRevision: '$STALE' }], S),
    cap('removeWorktree', [undefined], '$NO_SESSION'),
    cap('removeWorktree', [{ expectedRevision: '$REVISION' }], S),
    cap('removeWorktree', [{ expectedRevision: '$REVISION' }], S),
    cap('getBranchMenu', [], S),
    // A model switch moves the context windows (content, not timing): the session's route set to the wider model, then the
    // answers carry its window.
    { switchRoute: WIDE_ROUTE },
    cap('getBranchMenu', [], S),
    cap('listWorktrees', []),
    // A move back, and one whose read of the new route's status fails (the injected fault). Last in the group: the core's replay
    // cannot fail that read.
    { switchRoute: ROUTE },
    { switchRoute: WIDE_ROUTE, failStatus: true },
  ],
  settings: [
    cap('getWorktreeSettings', []),
    cap('getWorktreeSettings', [{}]),
    cap('setWorktreeSettings', []),
    cap('setWorktreeSettings', [undefined]),
    cap('setWorktreeSettings', [{}]),
    cap('setWorktreeSettings', [{ newTaskDefault: 'always' }]),
    cap('setWorktreeSettings', [{ branchPrefix: 5 }]),
    cap('setWorktreeSettings', [{ branchPrefix: 'p'.repeat(256) }]),
    cap('setWorktreeSettings', [{ sizeWarnBytes: -1 }]),
    cap('setWorktreeSettings', [{ maxWorktrees: 1.5 }]),
    cap('setWorktreeSettings', [{ unusedDays: 100_000 }]),
    cap('setWorktreeSettings', [{ autoCleanup: 'yes' }]),
    cap('setWorktreeSettings', [{ deleteBranch: null }]),
    cap('setWorktreeSettings', [{ cleanupArchived: 'yes' }]),
    cap('setWorktreeSettings', [{ maxWorktrees: -1 }]),
    cap('setWorktreeSettings', [{ sizeWarnBytes: 1.5 }]),
    cap('setWorktreeSettings', ['phone/']),
    cap('setWorktreeSettings', [null]),
    cap('setWorktreeSettings', [{ branchPrefix: 'x/' }, {}]),
    cap('setWorktreeSettings', [{ color: 'red' }]),
    cap('setWorktreeSettings', [{ branchPrefix: undefined }]),
    cap('setWorktreeSettings', [{ branchPrefix: 'phone/' }]),
    cap('setWorktreeSettings', [{ newTaskDefault: 'worktree', maxWorktrees: 3, unusedDays: 0, autoCleanup: false }]),
    cap('setWorktreeSettings', [{ branchPrefix: '' }]),
    cap('getWorktreeSettings', []),
    cap('listWorktrees', []),
    cap('listWorktrees', [{}]),
    cap('previewWorktreeCleanup', []),
    cap('previewWorktreeCleanup', [undefined]),
    cap('previewWorktreeCleanup', [null]),
    cap('previewWorktreeCleanup', [{}]),
    cap('previewWorktreeCleanup', [{ repoCommonDir: '' }]),
    cap('previewWorktreeCleanup', [{ repoCommonDir: 5 }]),
    cap('previewWorktreeCleanup', [{ repoCommonDir: undefined }]),
    cap('previewWorktreeCleanup', [{ other: 1 }]),
    cap('previewWorktreeCleanup', ['$COMMON_DIR']),
    cap('previewWorktreeCleanup', [{}, {}]),
    cap('pruneWorktrees', [undefined]),
    cap('pruneWorktrees', ['$COMMON_DIR']),
    cap('pruneWorktrees', [{ repoCommonDir: 5 }]),
    cap('pruneWorktrees', [{ repoCommonDir: undefined }]),
    cap('previewWorktreeCleanup', [{ repoCommonDir: '$ELSEWHERE' }]),
    cap('previewWorktreeCleanup', [{ repoCommonDir: '$COMMON_DIR' }]),
    cap('pruneWorktrees', []),
    cap('pruneWorktrees', [null]),
    cap('pruneWorktrees', [{ repoCommonDir: '' }]),
    cap('pruneWorktrees', [{ other: 1 }]),
    cap('pruneWorktrees', [{ repoCommonDir: '$ELSEWHERE' }]),
    cap('pruneWorktrees', [{ repoCommonDir: '$COMMON_DIR' }]),
    cap('deleteWorktree', []),
    cap('deleteWorktree', [undefined]),
    cap('deleteWorktree', [{}]),
    cap('deleteWorktree', [{ entryId: '' }]),
    cap('deleteWorktree', [{ entryId: 7 }]),
    cap('deleteWorktree', [{ entryId: 'nope', force: 'yes' }]),
    cap('deleteWorktree', [null]),
    cap('deleteWorktree', ['nope']),
    cap('deleteWorktree', [{ entryId: 'nope', extra: 1 }]),
    cap('deleteWorktree', [{ entryId: 'nope' }, {}]),
    cap('deleteWorktree', [{ entryId: 'nope', force: undefined }]),
    cap('deleteWorktree', [{ entryId: 'nope' }]),
  ],
  review: [
    cap('getSessionReviewDiff', [], S),
    cap('getSessionReviewDiff', undefined, S),
    cap('getSessionReviewDiff', [{}], S),
    cap('getSessionReviewDiff', [], '$NO_SESSION'),
    cap('getSessionReviewDiff', []),
    cap('getSessionReviewFilePatch', ['a.txt'], S),
    cap('getSessionReviewFilePatch', ['a.txt', undefined], S),
    cap('getSessionReviewFilePatch', ['b.txt', 'a.txt'], S),
    cap('getSessionReviewFilePatch', [], S),
    cap('getSessionReviewFilePatch', [undefined], S),
    cap('getSessionReviewFilePatch', [''], S),
    cap('getSessionReviewFilePatch', [7], S),
    cap('getSessionReviewFilePatch', ['../outside.txt'], S),
    cap('getSessionReviewFilePatch', ['a.txt'], '$NO_SESSION'),
    cap('getSessionReviewFilePatch', ['a.txt', 7], S),
    cap('getSessionReviewFilePatch', ['a.txt', null], S),
    cap('getSessionReviewFilePatch', ['a.txt', ''], S),
    cap('getSessionReviewFilePatch', ['a.txt', 'b.txt', 'c.txt'], S),
    cap('getSessionReviewFilePatch', [null], S),
    cap('getSessionReviewDiff', [undefined], S),
    cap('getTurnReviewDiff', [], S),
    cap('getTurnReviewDiff', [undefined], S),
    cap('getTurnReviewDiff', [{ summary: true }], S),
    cap('getTurnReviewDiff', [{ refresh: true, poll: 'background' }], S),
    cap('getTurnReviewDiff', [{ known: 'abc' }], S),
    cap('getTurnReviewDiff', [{ known: '0123456789abcdef0123456789abcdef' }], S),
    cap('getTurnReviewDiff', [{ poll: 'foreground' }], S),
    cap('getTurnReviewDiff', [{ summary: 'yes' }], S),
    cap('getTurnReviewDiff', [{ summary: undefined }], S),
    cap('getTurnReviewDiff', [{ extra: 1 }], S),
    cap('getTurnReviewDiff', [], '$NO_SESSION'),
    cap('getTurnReviewDiff', [null], S),
    cap('getTurnReviewDiff', ['summary'], S),
    cap('getTurnReviewDiff', [[]], S),
    cap('getTurnReviewDiff', [{ refresh: 'yes' }], S),
    cap('getTurnReviewDiff', [{}, {}], S),
    cap('getTurnReviewFilePatch', ['a.txt'], S),
    cap('getTurnReviewFilePatch', [], S),
    cap('getTurnReviewFilePatch', [undefined], S),
    cap('getTurnReviewFilePatch', [''], S),
    cap('getTurnReviewFilePatch', [7], S),
    cap('getTurnReviewFilePatch', [null], S),
    cap('getTurnReviewFilePatch', ['a.txt'], '$NO_SESSION'),
    cap('getTurnReviewFilePatch', ['a.txt', 'b.txt'], S),
    cap('getTurnChanges', [{ checkpointId: 'nope' }], S),
    cap('getTurnChanges', [{ checkpointId: 'nope', patch: true, file: 'a.txt' }], S),
    cap('getTurnChanges', [], S),
    cap('getTurnChanges', [undefined], S),
    cap('getTurnChanges', [{}], S),
    cap('getTurnChanges', [{ checkpointId: '' }], S),
    cap('getTurnChanges', [{ checkpointId: 'nope', patch: 'yes' }], S),
    cap('getTurnChanges', [{ checkpointId: 'nope', file: 7 }], S),
    cap('getTurnChanges', [{ checkpointId: 'nope', file: undefined }], S),
    cap('getTurnChanges', [null], S),
    cap('getTurnChanges', ['nope'], S),
    cap('getTurnChanges', [{ checkpointId: 7 }], S),
    cap('getTurnChanges', [{ checkpointId: 'nope', extra: 1 }], S),
    cap('getTurnChanges', [{ checkpointId: 'nope' }, {}], S),
    cap('getTurnChanges', [{ checkpointId: 'nope' }], '$NO_SESSION'),
  ],
};
if (ONLY !== null && !GROUPS[ONLY]) throw new Error(`--only takes one of ${Object.keys(GROUPS).join(', ')}, not ${ONLY}`);
const groups = ONLY ? [ONLY] : Object.keys(GROUPS);

/** The paired phone that calls (its relay credential). */
const PHONE_ID = '0123456789abcdef0123456789abcdef';
/** A session id no session has: the same shape as Node's own ids, so only its absence is refused. */
const NO_SESSION = 'sess_daemon_0000000000000_nobody';

/** The case's request with `$NAME` filled from the world and the run's context (its session, the last workspace revision). */
function filled(value, ctx) {
  const lookup = (name) => {
    if (name === 'PROJECT') return PATHS.project;
    if (name === 'ELSEWHERE') return PATHS.elsewhere;
    if (name === 'COMMON_DIR') return join(PATHS.project, '.git');
    if (name === 'SESSION') return ctx.session;
    if (name === 'NO_SESSION') return NO_SESSION;
    if (name === 'MAIN' || name === 'FEATURE' || name === 'SPARE') return git(PATHS.project, 'rev-parse', `refs/heads/${name.toLowerCase()}`);
    if (name === 'REVISION') return ctx.revision;
    if (name === 'REVISION_TEXT') return String(ctx.revision);
    if (name === 'STALE') return ctx.revision + 1000;
    throw new Error(`no value for $${name}`);
  };
  if (typeof value === 'string') {
    const whole = /^\$([A-Z_]+)$/.exec(value);
    return whole ? lookup(whole[1]) : value;
  }
  if (Array.isArray(value)) return value.map((entry) => filled(entry, ctx));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, filled(entry, ctx)]));
  return value;
}

/** The answer as the recording keeps it, whole (a carried session snapshot included): only what cannot be equal between two runs is
 *  normalised, each listed in the manifest's `normalized`: the session's own id as `<session>`, the host's control session's id as
 *  `<control>`, a time of the run as `<time>`, a transition's random id as `<tx>`. A `clientHostPid` is compared as the process it
 *  names (`ctx.pids`: the process running the session runtimes, the desktop's process); any other number stays as it is and differs. */
function kept(frame, ctx) {
  // A call naming no session carries the host's control session's snapshot (Node: invokeControlResult; the core: the lane's
  // control thread); each product makes that id itself.
  const carried = frame?.ok ? frame.value?.snapshot?.sessionId : undefined;
  if (typeof carried === 'string' && carried && carried !== ctx.session) ctx.control = carried;
  const ids = [
    [ctx.session, '<session>'],
    [ctx.control, '<control>'],
  ].filter(([id]) => id);
  const walk = (value, key) => {
    if (key === 'txId' && typeof value === 'string') return '<tx>';
    if (typeof value === 'string') return ids.reduce((text, [id, name]) => (text.includes(id) ? text.replaceAll(id, name) : text), value);
    if (/(^at|At)$/.test(key ?? '') && (typeof value === 'number' || typeof value === 'string')) return '<time>';
    if (key === 'clientHostPid' && typeof value === 'number' && ctx.pids?.[value]) return ctx.pids[value];
    if (Array.isArray(value)) return value.map((entry) => walk(entry));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, walk(entry, name)]));
    return value;
  };
  return walk(clone(frame));
}


/** The last workspace revision an answer showed (the branch menu's, a transition's). */
function noteRevision(frame, ctx) {
  const value = frame.ok ? frame.value?.value : undefined;
  const revision = value?.workspace?.revision;
  if (Number.isSafeInteger(revision)) ctx.revision = revision;
}

/** The ordered input before each case: three times every session's pass marked (a daemon-wide change) and the clock moved 1 s - past
 *  the scheduler's settle beat and minimum interval (session-status-scheduler.mjs:14-18). Two passes settle the context windows: the
 *  first publishes the route's window with the display fields 0 (`routeState` keeps them only for an unchanged window,
 *  context-state.mjs:102-114), the second keeps the display fields `syncContextStats` filled; the third publishes nothing more. Before
 *  and after it the control session's and the project session's snapshot are read (getWorktreeSettings): the first read opens a
 *  runtime not open yet, the second makes the host hold what the daemon does. */
const STATUS_SETTLE = { steps: [{ markAll: true, ms: 1000 }, { markAll: true, ms: 1000 }, { markAll: true, ms: 1000 }], read: 'getWorktreeSettings' };

/** The read after a case's after-call order: the snapshot of the session the case named (the control session's for none); the replay
 *  makes it too, so it is set before the replay runs. */
const settledRead = (sent) => ({ capability: STATUS_SETTLE.read, args: [], ...(sent.sessionId ? { sessionId: sent.sessionId } : {}) });

if (REPLAY) process.exit(await replay(REPLAY));

// ── Node's host ──
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, REF);
Object.assign(process.env, ENV);
const launchArgv = [...process.execArgv];
// The daemon is forked with this process's flags: it runs as Node's own does, without the test preloads (test-env.mjs would move
// its data folder into a temporary one).
process.execArgv.splice(0, process.execArgv.length, ...process.execArgv.filter((arg, index, all) => !/test-(env|tsx)\.mjs/.test(arg) && !/test-(env|tsx)\.mjs/.test(all[index + 1] ?? '')));
const sessionClient = await importFrom(tree, 'src/standalone/session-client.mjs');
const { createSessionProtocolClient } = await importFrom(tree, 'src/standalone/session-protocol.mjs');
const { SessionHost } = await importFrom(tree, 'apps/desktop/src/main/session-host.ts');
const { createRemoteMethods, executeRemoteFrame } = await importFrom(tree, 'apps/desktop/src/main/remote-methods.ts');

/** Before every case Node's session status is brought to the state it settles in (STATUS_SETTLE): its daemon's status scheduler runs
 *  on the virtual clock of status-clock-preload.mjs, which the recorder moves; this is the order's folder and its count, the last
 *  order marker each host attachment's stream delivered, and who waits for the next. */
const statusClock = { dir: join(WORK, 'status-clock'), sent: 0, markers: [], waiters: new Set() };
/** The frame type that ends an order on every stream (status-clock-preload.mjs `MARKER`). */
const STATUS_MARKER = 'rec-status-clock';
/** The snapshot fields Node fills on its status pass (manifest `settledStatus`). */
const SETTLED_FIELDS = ['contextWindow', 'rawContextWindow', 'effectiveContextWindowPercent', 'displayContextWindow', 'autoCompactTokenLimit', 'compactBoundaryTokens', 'agentScope', 'cwd', 'workspace'];
/** The snapshot fields a call moves that Node shows only after its answer, which the core may show in the answer already (manifest
 *  `fasterInCore`): the status fields above and `setupChanged`, which Node moves on its config watch. */
const FASTER_FIELDS = [...SETTLED_FIELDS, 'setupChanged'];

/** One status-clock order (by default STATUS_SETTLE's steps), answered once each host stream read its marker. */
async function settleStatus(pid, request = { steps: STATUS_SETTLE.steps }) {
  statusClock.sent += 1;
  const n = statusClock.sent;
  const done = join(statusClock.dir, `done-${n}.json`);
  const answered = new Promise((resolve, reject) => {
    const watcher = watch(statusClock.dir, () => existsSync(done) && finish());
    const deadline = setTimeout(() => finish(new RecorderError(`Node's daemon did not answer status-clock order ${n} in 150 s`)), 150_000);
    const finish = (error) => {
      watcher.close();
      clearTimeout(deadline);
      if (error) return reject(error);
      const reply = JSON.parse(readFileSync(done, 'utf8'));
      if (reply.error) reject(new RecorderError(`status-clock order ${n}: ${reply.error}`));
      else resolve(reply);
    };
  });
  const order = join(statusClock.dir, `advance-${n}.json.tmp`);
  writeFileSync(order, JSON.stringify({ pid, ...request }));
  renameSync(order, join(statusClock.dir, `advance-${n}.json`));
  const reply = await answered;
  // The publications reach the host on its streams, not with the answer: it holds the settled state once each stream read the marker.
  await new Promise((resolve, reject) => {
    const check = () => {
      if (statusClock.markers.some((seen) => seen < n)) return;
      finish();
    };
    const deadline = setTimeout(
      () => finish(new RecorderError(`the host's streams did not deliver status-clock order ${n}'s marker in 30 s (they read ${JSON.stringify(statusClock.markers)})`)),
      30_000
    );
    const finish = (error) => {
      statusClock.waiters.delete(check);
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve();
    };
    statusClock.waiters.add(check);
    check();
  });
  return reply;
}

/** Who waits for a session's route publication on the host's streams (routeShown). */
const routeWaiters = new Set();

/** The desktop's setRoute of `session`, ordered: its answer can come before the daemon publishes the session's new route to the host
 *  (set-route.mjs:393-395 runs followSession after adoptRoute), so the next case waits for the host to have received that publication. */
async function routeShown(attachment, session, route) {
  let resolveShown;
  let rejectShown;
  const shown = new Promise((resolve, reject) => ((resolveShown = resolve), (rejectShown = reject)));
  const waiter = (frame) => {
    if (frame?.type === 'session-state' && frame.sessionId === session && frame.patch?.set?.model === route.model) resolveShown();
  };
  routeWaiters.add(waiter);
  const deadline = setTimeout(() => rejectShown(new RecorderError(`the host did not receive session ${session}'s route ${route.model} in 30 s`)), 30_000);
  try {
    await attachment.call('session.configure', { sessionId: session, action: 'setRoute', args: [{ ...route, applyToCurrentSession: true, keepMainModel: false }] });
    await shown;
  } finally {
    clearTimeout(deadline);
    routeWaiters.delete(waiter);
  }
}

async function recordGroup(group) {
  makeWorld(group);
  rmSync(statusClock.dir, { recursive: true, force: true });
  mkdirSync(statusClock.dir, { recursive: true });
  process.env.MIXDOG_REC_STATUS_CLOCK = statusClock.dir;
  process.execArgv.push('--import', pathToFileURL(join(REPO_ROOT, 'benchmarks', 'rust-core', 'recorders', 'lib', 'status-clock-preload.mjs')).href);
  const discovery = await sessionClient.ensureDaemon({ cwd: PATHS.project, attempts: 2, readyTimeoutMs: 120_000 });
  const daemonPid = Number(discovery.pid);
  let host = null;
  const attachments = [];
  try {
    const runtime = {
      async attachSessionClient({ onFrame, onFatal }) {
        const fatal = (reason) => {
          console.error(`[recorder] ${group}: the host's daemon attachment ended: ${reason}`);
          onFatal(reason);
        };
        // The status clock's marker frames end each order on this stream (settleStatus); the host never sees them.
        const index = statusClock.markers.push(0) - 1;
        const frames = (frame) => {
          if (frame?.type !== STATUS_MARKER) {
            onFrame(frame);
            for (const waiter of [...routeWaiters]) waiter(frame);
            return;
          }
          statusClock.markers[index] = frame.order;
          for (const waiter of [...statusClock.waiters]) waiter();
        };
        const attached = await sessionClient.attachSession({ discovery, cwd: PATHS.project, clientKind: 'desktop', onFrame: frames, onFatal: fatal });
        attachments.push(attached);
        return createSessionProtocolClient({ call: (name, params, options) => attached.call(name, params, options), close: () => attached.close() });
      },
      loadProjects: () => importFrom(tree, 'src/runtime/shared/projects.mjs'),
      loadWorktrees: () => importFrom(tree, 'src/runtime/shared/worktrees/manager.mjs'),
      loadSessionStore: () => importFrom(tree, 'src/runtime/agent/orchestrator/session/store-summary-reader.mjs'),
      loadSessionSearch: () => importFrom(tree, 'src/runtime/session-search/session-search-db.mjs'),
      loadStatuslineSegments: () => importFrom(tree, 'src/runtime/shared/statusline/statusline-segments.mjs'),
      executeCodeGraphTool: async () => ({}),
    };
    host = await SessionHost.create({ userDataPath: PATHS.userData, resourcesPath: PATHS.userData, appPath: join(tree, 'apps', 'desktop'), packaged: false }, runtime);
    await host.addProject(PATHS.project);
    const ctx = { session: '', revision: 0, pids: { [daemonPid]: '<runtime pid>', [process.pid]: '<desktop pid>' } };
    if (group !== 'settings') {
      // The project's session, as the desktop's new task creates it (session-host-lifecycle.ts createNewTask), idle.
      const created = await attachments[0].call('session.create', { cwd: PATHS.project, desktopSession: { classification: 'project', projectPath: PATHS.project } });
      ctx.session = String(created.sessionId);
      // ... and its draft's route (configureDraft), the fixture's model.
      await routeShown(attachments[0], ctx.session, ROUTE);
    }
    const methods = createRemoteMethods({ host, userDataPath: PATHS.userData });
    const cases = [];
    let frameId = 0;
    for (const request of GROUPS[group]) {
      if (request.switchRoute) {
        // The desktop's model switch of the session (configureDraft's setRoute on the current session), an ordered input. The
        // session as the host holds it before, right after (no status pass between: the clock is held, and the order that ends the
        // move waits for its publications and each stream's marker) and once the after-move order settled it; the status reads the
        // move made (status-clock-preload.mjs `contextRead`), the first failed when the entry injects it.
        const read = async () => {
          const { id: _read, ...answer } = clone(await executeRemoteFrame(methods, JSON.stringify({ id: ++frameId, method: 'invokeCapability', params: [settledRead({ sessionId: ctx.session })] })));
          if (!answer.ok) throw new RecorderError(`${group}: the read around the route move failed: ${answer.error}`);
          return kept(answer, ctx);
        };
        const before = await read();
        await settleStatus(daemonPid, { steps: [], statusReads: { start: true, fail: request.failStatus ? 1 : 0 } });
        await routeShown(attachments[0], ctx.session, request.switchRoute);
        const { statusReads, unfailed } = await settleStatus(daemonPid, { steps: [{ ms: 0 }], statusReads: { take: true } });
        if (unfailed) throw new RecorderError(`${group}: the route move to ${request.switchRoute.model} made no status read to fail`);
        const frame = await read();
        await settleStatus(daemonPid);
        const settled = await read();
        cases.push({ group, switchRoute: request.switchRoute, ...(request.failStatus ? { failStatus: true } : {}), before, statusReads, frame, settled });
        continue;
      }
      // Read, settle, read: the first read opens the host's control session's runtime should none be open yet (the first case of a
      // group), so its status settles as well.
      await host.invokeCapability(STATUS_SETTLE.read, []);
      if (ctx.session) await host.invokeCapability(STATUS_SETTLE.read, [], ctx.session);
      await settleStatus(daemonPid);
      await host.invokeCapability(STATUS_SETTLE.read, []);
      if (ctx.session) await host.invokeCapability(STATUS_SETTLE.read, [], ctx.session);
      const sent = filled(request, ctx);
      const { id: _id, ...frame } = clone(await executeRemoteFrame(methods, JSON.stringify({ id: ++frameId, method: 'invokeCapability', params: [sent] })));
      // A lost daemon socket is the run's failure, not Node's answer: the recording is refused rather than kept with it.
      if (!frame.ok && /^(ECONNRESET|ECONNREFUSED|EPIPE)$/.test(frame.errorCode ?? '')) {
        throw new Error(`${group}: the host lost its daemon connection (${frame.error}) on ${JSON.stringify(request)}; record again`);
      }
      noteRevision(frame, ctx);
      // The answer is kept as Node gave it. What the call moved after its answer (a settings write's setupChanged, a transition's
      // cwd and window: manifest `fasterInCore`) Node shows once the after-call order has run its config watch and status passes:
      // the read after that order is the case's `settled`, compared whole as well.
      let settled;
      if (frame.ok && frame.value?.snapshot && typeof frame.value.snapshot === 'object') {
        await settleStatus(daemonPid);
        const { id: _after, ...after } = clone(await executeRemoteFrame(methods, JSON.stringify({ id: ++frameId, method: 'invokeCapability', params: [settledRead(sent)] })));
        if (!after.ok) throw new RecorderError(`${group}: the settled read failed: ${after.error}`);
        settled = kept(after, ctx);
      }
      cases.push({ group, request: clone([request])[0] ?? null, frame: kept(frame, ctx), ...(settled ? { settled } : {}), repository: kept(repository(), ctx) });
      // repository() blocks this process on git; one turn of the loop (its overdue timers, then pending socket closes) lets the
      // client's pool drop idle sockets the daemon's keep-alive ended, or the next call goes out on one and reads ECONNRESET.
      await new Promise((resolve) => setImmediate(resolve));
    }
    return cases;
  } finally {
    await host?.dispose?.();
    for (const attached of attachments) await attached.close().catch(() => undefined);
    await sessionClient.shutdownDaemon(discovery, { waitForExit: true, timeoutMs: 30_000 }).catch(() => undefined);
    // Whatever outlived the stop (the supervisor, a git child) ends with the daemon's tree.
    spawnSync('taskkill', ['/T', '/F', '/PID', String(daemonPid)], { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
    endPostgres();
  }
}

/** Node's memory store starts postgres detached (`pg_ctl start`), outside the daemon's tree; a postgres still running after the stop
 *  holds the world's pgdata, so it is ended by the pid its postmaster.pid names (only if that process is a postgres) and its exit
 *  awaited, within 30 s, before the next group makes its world. */
function endPostgres() {
  const pidFile = join(PATHS.data, 'pgdata', 'postmaster.pid');
  if (!existsSync(pidFile)) return;
  const pid = Number.parseInt(readFileSync(pidFile, 'utf8').split('\n')[0], 10);
  if (!(pid > 0)) return;
  const script =
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'postgres') ` +
    `{ taskkill /T /F /PID ${pid} | Out-Null; if (-not $p.WaitForExit(30000)) { exit 1 } }`;
  const run = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true, timeout: 60_000 });
  if (run.status !== 0) throw new RecorderError(`the Node daemon's postgres (pid ${pid}) did not end in 30 s (${run.status ?? run.error})`);
}

/** One group recorded by a process of its own (`--only`): the tree's modules keep state about the daemon they talked to, and a
 *  group's daemon ends with its group, so a later group in the same process reached the ended one (read ECONNRESET). */
function recordInOwnProcess(group) {
  const run = spawnSync(process.execPath, [...launchArgv, process.argv[1], '--tree', tree, '--only', group], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  if (run.status !== 0) throw new Error(`recording ${group} failed (exit ${run.status ?? run.error})`);
  return JSON.parse(run.stdout);
}

const cases = [];
if (ONLY) cases.push(...(await recordGroup(ONLY)));
else for (const group of groups) cases.push(...recordInOwnProcess(group));

if (ONLY) {
  const text = `${JSON.stringify(cases, null, 2)}\n`;
  await new Promise((written, failed) => process.stdout.write(text, (error) => (error ? failed(error) : written())));
  process.exit(0);
}
const stage = stageSet(FIXTURES);
writeJson(join(stage, 'golden.json'), {
  note: "Node host (b6f10295a) answers to a paired phone's invokeCapability for the worktree capabilities and the review reads: per call the request the page sent ($NAME filled from the world when it runs), the relay frame, whole (session id as <session>, run times as <time>) and the repository afterwards.",
  world: { paths: PATHS, git: GIT_IDENTITY, noSession: NO_SESSION },
  // Before every case, in this order: Node's status clock (status-clock-preload.mjs) and the host's reads of the control and the
  // project session (`read`, which the replay sends as well).
  beforeEachCase: STATUS_SETTLE,
  cases,
});
writeSetManifest(stage, {
  set: 'phone-worktree',
  recorder: 'benchmarks/rust-core/recorders/record-phone-worktree.mjs',
  command: `node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs benchmarks/rust-core/recorders/record-phone-worktree.mjs --tree <git archive of ${REF} with node_modules>`,
  identity,
  extra: {
    ...PROVENANCE,
    cases: cases.length,
    entry: {
      runs: "executeRemoteFrame over createRemoteMethods (remote-methods.ts:828, :1256) with SessionHost (session-host.ts) attached to the tree's own daemon (session-client.mjs ensureDaemon, attachSession; session-protocol.mjs createSessionProtocolClient), one world and one daemon per group",
      notRun: 'the relay transport (encryption, admission) and the window process; the daemon runs without memory worker and MCP servers (MIXDOG_DAEMON_SKIP_MEMORY, MIXDOG_DISABLE_MCP), with the supervisor binary the real-turn harness cached',
    },
    syntheticInput: {
      world: 'a git repository registered as a Project (main, feature, spare; the review group leaves a.txt changed), a folder that is no Project, and one idle project session created as the new task does (session.create {cwd, desktopSession}); fixed git identity and time for every commit',
    },
    normalized: {
      session: "the session's own id is <session> in every answer (each product makes its own)",
      control: "the host's control session's id (the snapshot a call naming no session carries) is <control> (each product makes its own)",
      time: 'a field named *At or at is <time> (the run time)',
      pid: "a clientHostPid that is the id of the process running the session runtimes (Node's daemon, mixdogd) is <runtime pid>, the desktop's own process (this recorder's, which hosts SessionHost or the replay's window client) <desktop pid>; any other number is kept and compared as it is",
      tx: "a workspace transition's txId is <tx> (a random id each run makes)",
    },
    settledStatus: {
      fields: SETTLED_FIELDS,
      node: "Node fills these on its session status pass (local-session-runtime.mjs createRuntimePulse: syncContextStats, then routeState, context-state.mjs:45-155; agentStatusState, agent-tool-routing.mjs:51-66), which its daemon's status scheduler runs when a mark arrives (session-status-scheduler.mjs); before the first pass they are null/0, after the first the route's window with the display fields 0, from the second on the settled values; agentScope is null until the keychain prewarm is done (agent-tool.mjs statusFor). A projection Node drops after 90 s idle is rebuilt with them empty until the next pass (retention.mjs:127-143). Which of these a call answered depended on whether a pass had landed",
      recording: "holds the settled state: before every case the daemon's scheduler runs on a virtual clock the recorder moves (beforeEachCase in golden.json: status-clock-preload.mjs, the keychain prewarm awaited, then three marks of every session each followed by 1 s, the order ending with a marker frame each host stream delivers after the passes' publications), no real wait; the idle projection drop and eviction are set beyond a run (MIXDOG_SESSION_PROJECTION_IDLE_MS, MIXDOG_SESSION_IDLE_EVICT_MS)",
      core: 'has the settled values from the start (only faster with the same content, rule U-SV1); a change of these values later in a session (a model switch) is content, recorded as its own case',
    },
    fasterInCore: {
      fields: FASTER_FIELDS,
      node: {
        setupChanged:
          "a settings write reaches setupChanged after the call's answer: the runtime's config save is debounced (src/session-runtime/config-lifecycle/config-writers.mjs:67-75), the daemon's config watch sees the file (config.mjs watchConfigDir) and runs its listeners after a 100 ms debounce (config.mjs notifyConfigChanged), the change effects announce settings_changed (config-change-effects.mjs), the router counts it (notification-router.mjs:33-36) and the store publishes on its 16 ms frame (frame-batched-store.mjs)",
        status: "a field of settledStatus the call itself moved (a transition's cwd and workspace, the window of a route) Node publishes on its next status pass (src/tui/session/context-state.mjs:45-113,137-155; session-status-scheduler.mjs)",
      },
      recording:
        "deterministic: the daemon's timers run on the recorder's virtual clock (status-clock-preload.mjs), so no debounce, watch listener or status pass runs between the call and its answer; each answer is kept as Node gave it. After a call whose answer carries a snapshot the after-call order lands the saves accepted before it (drainSessionConfigWrites), waits for the watch event that saw the files on disk, moves the clock past the debounces and the status passes, and waits for the store's frame and each host stream's marker; the read after it (getWorktreeSettings of the session the case named) is the case's `settled`, kept whole",
      replay:
        "the core's answer is compared whole with Node's; in a field listed here it may instead hold the value Node's `settled` read holds (the core applies the change before it answers: the same content, only faster, rule U-SV1). The same read after the case is compared whole with `settled`",
    },
    routeMoves: {
      entries: "a session group entry with switchRoute: the desktop's setRoute of the session ({...switchRoute, applyToCurrentSession: true, keepMainModel: false}), with `before` (the session's read before it), `statusReads` (the status read of the move's own sync, routes-write.mjs:142, as the fields syncContextDisplayFields takes: context-state.mjs:116-142; a settings change's later sync is not the move's), `frame` (the read right after the move: no status pass ran, routes-write.mjs:133-142 published) and `settled` (the read after the next status-clock order)",
      fault: "failStatus: the move's own sync (routes-write.mjs:142) finds no status (null, as the runtime answers without one), injected by status-clock-hooks.mjs on context-state.mjs:140 and status-clock-preload.mjs `contextRead`; the recording fails if the move made no read to fail. A move of an idle session never moves its window (the session's window follows at its next turn: routes-write.mjs:168-175 deferUntilNextTurn), so the recorded moves keep it",
      compared:
        "by mixdog-core-session route_config_tests (the move's thread/header/patch with the route Node resolved, the status read answered as recorded, the failed one failing): the moved route and context fields equal `frame`, a fasterInCore field `settled` instead; the replay sends each move as input (route/set) and compares the cases after it",
    },
    notRecorded: {
      notProducible: "a request that is no object, names no or an unknown capability, has args that are no array, or a session id that is no id: the page's invokeCapability always sends {capability, args, sessionId?} with a capability it names and a session id it holds, and those requests go to the group that owns invokeCapability itself",
    },
  },
});
commitStage(stage, FIXTURES);
console.log(`phone-worktree: ${cases.length} cases`);
process.exit(0);

/** The core's answer as compared with Node's: a `fasterInCore` field of its snapshot that holds the value Node's `settled` read holds
 *  where Node's answer held its earlier one counts as Node's answer (the same content, only faster); every other field stays as the
 *  core answered. */
function fasterAs(frame, expected, fields) {
  const core = frame.value?.snapshot;
  const node = expected.frame?.value?.snapshot;
  const later = expected.settled?.value?.snapshot;
  if (!core || !node || !later) return frame;
  const snapshot = { ...core };
  for (const field of fields) {
    if (isDeepStrictEqual(snapshot[field], node[field]) || !isDeepStrictEqual(snapshot[field], later[field])) continue;
    // A field Node's answer did not hold yet is absent from it, not present as undefined.
    if (Object.hasOwn(node, field)) snapshot[field] = node[field];
    else delete snapshot[field];
  }
  return { ...frame, value: { ...frame.value, snapshot } };
}

/** A call's frame as the relay answers it: `{ ok, value }`, or `{ ok: false, error, errorCode?, errorParams? }`. */
async function answered(call) {
  try {
    return { ok: true, value: clone(await call()) };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      ...(typeof error.code === 'string' && error.code ? { errorCode: error.code } : {}),
      ...(error.details !== undefined ? { errorParams: clone(error.details) } : {}),
    };
  }
}

/** Where two answers part: [path, node, core] down to the first field that is not an object on both sides. */
function divergences(node, core, path) {
  const objects = node && core && typeof node === 'object' && typeof core === 'object' && Array.isArray(node) === Array.isArray(core);
  if (!objects) return isDeepStrictEqual(node, core) ? [] : [[path, node, core]];
  const keys = [...new Set([...Object.keys(node), ...Object.keys(core)])];
  return keys.flatMap((key) => divergences(node[key], core[key], `${path}.${key}`));
}

// ── the replay: the phone's router and adapters over a built core ──
async function replay(exe) {
  const ownProtocol = pathToFileURL(join(REPO_ROOT, 'packages', 'protocol', 'src', 'index.ts')).href;
  register(
    `data:text/javascript,${encodeURIComponent(
      `export const resolve = (specifier, context, next) => specifier === '@mixdog/protocol' ? { url: ${JSON.stringify(ownProtocol)}, shortCircuit: true } : next(specifier, context);`
    )}`
  );
  const golden = JSON.parse(readFileSync(join(FIXTURES, 'golden.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(FIXTURES, 'MANIFEST.json'), 'utf8'));
  if (manifest.recorderSha256 !== PROVENANCE.recorderSha256 || !isDeepStrictEqual(manifest.inputs, PROVENANCE.inputs)) throw new Error('the recording was made by another recorder than this one: record again before comparing');
  // The router's call deadlines run on the page's timers (remote-shim-call-watch.ts): real ones, so a stalled call fails its case
  // with the router's deadline error instead of hanging the replay.
  globalThis.window = { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (timer) => clearTimeout(timer) };
  const { parseDiscovery } = await here('apps/desktop/src/main/protocol/discovery.ts');
  const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
  const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
  const { relayE2EEPairingMaterial } = await here('apps/desktop/src/shared/remote-e2ee.ts');
  const { createProtocolRouter } = await here('apps/desktop/src/renderer/remote-shim-protocol.ts');
  const adapters = [(await here('apps/desktop/src/renderer/remote-protocol-worktree.ts')).adapter, (await here('apps/desktop/src/renderer/remote-protocol-review.ts')).adapter];
  const runtimeManifest = join(exe, '..', 'js-runtime.json');
  if (!existsSync(runtimeManifest)) writeFileSync(runtimeManifest, JSON.stringify({ program: process.execPath, packageRoot: REPO_ROOT }));

  const differences = [];
  let compared = 0;
  for (const group of groups) {
    console.error(`replaying ${group}`);
    makeWorld(group);
    writeFileSync(join(PATHS.data, 'remote-activated.json'), '{"activatedAt":1}');
    const relay = await startRelay({ repoRoot: REPO_ROOT, clients: [{ id: PHONE_ID, name: 'Pixel 9 · Mixdog App', platform: 'Android', browser: 'Mixdog App', createdAt: 1, lastSeenAt: 2, online: true }], capabilities: { textFrames: 1, maxFrameBytes: 1048576 } });
    // The profile is already the core's own folder: nothing to migrate from (boot.rs `MIXDOG_DESKTOP_USER_DATA`).
    const { MIXDOG_DESKTOP_USER_DATA: _profile, ...coreEnv } = ENV;
    const child = spawn(exe, ['serve'], { env: { ...coreEnv, MIXDOG_RELAY_URL: `ws://127.0.0.1:${relay.port}` }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const clients = [];
    try {
      const endpointOf = await discovered(child, PATHS.runtime, parseDiscovery, () => stderr);
      const base = {
        target: { id: 'core' },
        connector: createWsConnector(async () => endpointOf),
        clientInfo: { name: 'mixdog-phone', title: 'Mixdog Phone', version: '1.4.5', kind: 'phone' },
        capabilities: { optOutNotificationMethods: [], experimentalApi: false },
        threadReducer: sessionReducer,
        clock: { sleep: () => Promise.reject(new Error('the replay dropped its connection')) },
        random: Math.random,
      };
      // The desktop's window: registers the Project and starts the project's idle session, as the recording's world did.
      const window = await connect({ ...base, clientInfo: { ...base.clientInfo, name: 'mixdog-replay-window', kind: 'desktop' } });
      clients.push(window);
      await window.call('project/create', { path: PATHS.project });
      const ctx = { session: '', revision: 0, pids: { [child.pid]: '<runtime pid>', [process.pid]: '<desktop pid>' } };
      if (group !== 'settings') {
        const started = await window.call('thread/start', { kind: 'task', projectPath: PATHS.project, draft: { projectPath: PATHS.project, route: ROUTE } });
        ctx.session = String(started.thread.id);
      }
      await relay.leg();
      const pairing = relayE2EEPairingMaterial(JSON.parse(readFileSync(join(PATHS.data, 'relay-e2ee.json'), 'utf8')));
      const phone = await connect({ ...base, connector: await relay.openPhone('client-worktree', PHONE_ID, pairing) });
      clients.push(phone);
      await phone.subscribeApp();
      const host = { ctx: { browserId: PHONE_ID, fanOut() {} }, client: () => phone, declareLane() {}, onClient: (listener) => (listener(phone), () => undefined) };
      const router = createProtocolRouter(adapters, { host, started: async () => {}, synced: async () => {}, probe() {}, silentSince: () => false });
      router.install();
      const wanted = golden.cases.filter((entry) => entry.group === group && (entry.request !== undefined || entry.switchRoute));
      for (const [index, expected] of wanted.entries()) {
        if (expected.switchRoute) {
          // The desktop window's model switch of the session (route/set), as the recording's input.
          await window.call('route/set', { threadId: ctx.session, route: { ...expected.switchRoute, applyToCurrentSession: true, keepMainModel: false } });
          continue;
        }
        // The recording's reads before each case; the core needs no clock moved (its status is settled from the start).
        for (let reads = 0; reads < 2; reads += 1) {
          await router.call('invokeCapability', [{ capability: golden.beforeEachCase.read, args: [] }]);
          if (ctx.session) await router.call('invokeCapability', [{ capability: golden.beforeEachCase.read, args: [], sessionId: ctx.session }]);
        }
        const sent = filled(expected.request, ctx);
        const label = `${group} #${index} ${JSON.stringify(expected.request).slice(0, 140)}`;
        let frame;
        let stall;
        try {
          // Each call has its own deadline as well, naming the case: a stall fails the replay, never hangs it.
          const deadline = new Promise((_, reject) => {
            stall = setTimeout(() => reject(new Error(`the replay's call stalled for 120 s: ${label}`)), 120_000);
          });
          frame = { ok: true, value: clone(await Promise.race([router.call('invokeCapability', [sent]), deadline])) };
        } catch (error) {
          if (String(error?.message).startsWith("the replay's call stalled")) {
            // The group's later cases would queue behind the stalled call: the stall is its difference and the group ends here.
            differences.push({ label, field: 'stall', node: expected.frame, core: `${error.message}\nmixdogd stderr:\n${stderr.slice(-4000)}` });
            compared += 1;
            break;
          }
          frame = {
            ok: false,
            error: error.message,
            ...(typeof error.code === 'string' && error.code ? { errorCode: error.code } : {}),
            ...(error.details !== undefined ? { errorParams: clone(error.details) } : {}),
          };
        } finally {
          clearTimeout(stall);
        }
        noteRevision(frame, ctx);
        compared += 1;
        const got = { frame: fasterAs(kept(frame, ctx), expected, manifest.fasterInCore.fields), repository: kept(repository(), ctx) };
        if (expected.settled) got.settled = kept(await answered(() => router.call('invokeCapability', [settledRead(sent)])), ctx);
        for (const field of ['frame', 'repository', 'settled']) {
          if (!isDeepStrictEqual(expected[field], got[field])) differences.push({ label, field, node: expected[field], core: got[field] });
        }
      }
    } finally {
      for (const client of clients) client.close?.();
      spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
      relay.close();
    }
  }
  console.log(`phone-worktree replay over ${exe}: ${compared} cases compared, ${differences.length} differ`);
  for (const entry of differences) {
    console.log(`DIFF ${entry.label} ${entry.field}`);
    for (const [path, node, core] of divergences(entry.node, entry.core, '')) {
      console.log(`   ${path || '.'}: node ${JSON.stringify(node)?.slice(0, 300)} | core ${JSON.stringify(core)?.slice(0, 300)}`);
    }
  }
  return differences.length ? 1 : 0;
}

/** The core is up when it has written its discovery file: the watch wakes the wait on the directory's change or the child's exit. */
async function discovered(child, dir, parseDiscovery, stderr) {
  const file = join(dir, 'daemon.json');
  let stirred = false;
  let wake = null;
  const stir = () => {
    stirred = true;
    wake?.();
  };
  const watcher = watch(dir, stir);
  child.once('exit', stir);
  const deadline = setTimeout(stir, 120_000);
  const started = Date.now();
  try {
    for (;;) {
      stirred = false;
      if (child.exitCode !== null) throw new Error(`mixdogd exited ${child.exitCode}:\n${stderr()}`);
      if (Date.now() - started > 120_000) throw new Error('mixdogd did not write its discovery file within 120 s');
      try {
        return parseDiscovery(readFileSync(file, 'utf8'));
      } catch {
        if (!stirred) await new Promise((resolve) => (wake = resolve));
      }
    }
  } finally {
    clearTimeout(deadline);
    watcher.close();
  }
}
