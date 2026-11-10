#!/usr/bin/env node
// What Node's host (b6f10295a) answers a paired phone for its branch, worktree and review calls: `invokeCapability` for the sixteen
// worktree capabilities and the five review reads, over the inputs the page can send (the argument left out, the page's `undefined`
// as the relay's JSON carried it, null, a wrong type, an empty value, a folder that is no Project, an id nobody knows, and the valid
// forms). Recorded from an exact export: the relay's own frame executor (`executeRemoteFrame` over `createRemoteMethods`,
// remote-methods.ts) with the real desktop host (`SessionHost`, session-host.ts) attached to the real Node daemon of the same tree
// (session-client.mjs `ensureDaemon`/`attachSession`), in an isolated profile with a git repository registered as a Project and one
// session in it. Per call the recording holds the request the page sent, the frame the relay answered (the session snapshot a
// non-value-only answer carries is written as `<snapshot>`) and the repository afterwards (refs, HEAD and worktrees).
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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { commitStage, exactProductIdentity, importFrom, parseArgs, REPO_ROOT, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { startRelay } from './lib/phone-relay-core.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const FIXTURES = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'phone-worktree');
const WORK = process.env.PHONE_WORKTREE_WORK ?? join('D:\\mixdog-build\\tmp', `${REPO_ROOT.split(/[\\/]/).pop()}-phone-worktree`);
/** Node's daemon supervisor (v0.1.1, sha256-checked by the real-turn harness that cached it): a fresh profile would otherwise download it. */
const SUPERVISOR = 'D:\\mixdog-build\\tmp\\real-turn-harness\\cache\\supervisor-v0.1.1\\mixdog-supervisor-win32-x64.exe';
const args = parseArgs();
const REPLAY = args.get('replay') ?? null;
const ONLY = args.get('only') ?? null;
const RECORDER_FILES = ['record-phone-worktree.mjs', 'lib/common.mjs', 'lib/phone-relay-core.mjs'].map((file) => `benchmarks/rust-core/recorders/${file}`);
const recorderFiles = () =>
  RECORDER_FILES.map((path) => ({ path, sha256: createHash('sha256').update(readFileSync(join(REPO_ROOT, path), 'utf8').replaceAll('\r\n', '\n')).digest('hex') }));
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
        modelOverrides: { 'fixture-model': { manual: true } },
      },
    },
  },
};
/** The session's route: the fixture's model. */
const ROUTE = { provider: 'custom-fixture', model: 'fixture-model' };
/** The profile both products run in: a parent variable that could reach a real profile, service or key is dropped. */
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
    // inspectProjectBranch
    cap('inspectProjectBranch', [{ projectPath: '$PROJECT' }]),
    cap('inspectProjectBranch', [{ projectPath: '$PROJECT', branch: undefined }]),
    cap('inspectProjectBranch', [{ projectPath: '$PROJECT', branch: '' }]),
    cap('inspectProjectBranch', [{ projectPath: '$PROJECT', branch: null }]),
    cap('inspectProjectBranch', [{ projectPath: '$ELSEWHERE', branch: 'feature' }]),
    cap('inspectProjectBranch', [{ projectPath: '$PROJECT', branch: 'nope' }]),
    cap('inspectProjectBranch', [{ projectPath: '$PROJECT', branch: 'feature' }]),
    cap('inspectProjectBranch', [{ projectPath: '$PROJECT', branch: 'main' }]),
    // selectProjectBranch: the branch, the exclusive flags, a start point or a detach that is no commit id, valid moves.
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
    cap('mergeProjectBranch', [{ projectPath: '$PROJECT', branch: 'feature' }]),
    cap('mergeProjectBranch', [{ projectPath: '$PROJECT', branch: 'feature', target: undefined }]),
    cap('mergeProjectBranch', [{ projectPath: '$PROJECT', target: 'main' }]),
    cap('mergeProjectBranch', [{ projectPath: '$ELSEWHERE', branch: 'feature', target: 'main' }]),
    cap('mergeProjectBranch', [{ projectPath: '$PROJECT', branch: 'feature', target: 'spare' }]),
    cap('mergeProjectBranch', [{ projectPath: '$PROJECT', branch: 'nope', target: 'main' }]),
    cap('mergeProjectBranch', [{ projectPath: '$PROJECT', branch: 'feature', target: 'main' }]),
    // manageProjectBranch: the commit ids, the action, the confirmation, `force` outside delete-branch, valid deletes.
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
    cap('mergeWorkspace', [{ confirmed: true, target: 'main', expectedRevision: '$STALE' }], S),
    cap('mergeWorkspace', [{ confirmed: true, target: 'main', expectedRevision: '$REVISION' }], S),
    // removeWorktree
    cap('removeWorktree', [undefined], S),
    cap('removeWorktree', [{ force: 'yes' }], S),
    cap('removeWorktree', [{ expectedRevision: -2 }], S),
    cap('removeWorktree', [{ keep: true }], S),
    cap('removeWorktree', [{ expectedRevision: '$STALE' }], S),
    cap('removeWorktree', [{ expectedRevision: '$REVISION' }], S),
    cap('removeWorktree', [{ expectedRevision: '$REVISION' }], S),
    cap('getBranchMenu', [], S),
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
    cap('getTurnReviewFilePatch', ['a.txt'], S),
    cap('getTurnReviewFilePatch', [], S),
    cap('getTurnReviewFilePatch', [undefined], S),
    cap('getTurnReviewFilePatch', [''], S),
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

/** The answer as the recording keeps it: the session's own id as `<session>`, a time of the run as `<time>`, and the snapshot a
 *  non-value-only answer carries as `<snapshot>` (the page reads only `.value` of these calls: worktree-branch-model.ts
 *  invokeWorktree). */
function kept(frame, ctx) {
  const walk = (value, key) => {
    if (typeof value === 'string') return ctx.session && value.includes(ctx.session) ? value.replaceAll(ctx.session, '<session>') : value;
    if (/At$/.test(key ?? '') && (typeof value === 'number' || typeof value === 'string')) return '<time>';
    if (Array.isArray(value)) return value.map((entry) => walk(entry));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, walk(entry, name)]));
    return value;
  };
  const out = clone(frame);
  if (out.ok && out.value && typeof out.value === 'object' && 'snapshot' in out.value) out.value.snapshot = '<snapshot>';
  return walk(out);
}

/** The last workspace revision an answer showed (the branch menu's, a transition's). */
function noteRevision(frame, ctx) {
  const value = frame.ok ? frame.value?.value : undefined;
  const revision = value?.workspace?.revision;
  if (Number.isSafeInteger(revision)) ctx.revision = revision;
}

if (REPLAY) process.exit(await replay(REPLAY));

// ── Node's host ──
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, REF);
Object.assign(process.env, ENV);
// The daemon is forked with this process's flags: it runs as Node's own does, without the test preloads (test-env.mjs would move
// its data folder into a temporary one).
process.execArgv.splice(0, process.execArgv.length, ...process.execArgv.filter((arg, index, all) => !/test-(env|tsx)\.mjs/.test(arg) && !/test-(env|tsx)\.mjs/.test(all[index + 1] ?? '')));
const sessionClient = await importFrom(tree, 'src/standalone/session-client.mjs');
const { createSessionProtocolClient } = await importFrom(tree, 'src/standalone/session-protocol.mjs');
const { SessionHost } = await importFrom(tree, 'apps/desktop/src/main/session-host.ts');
const { createRemoteMethods, executeRemoteFrame } = await importFrom(tree, 'apps/desktop/src/main/remote-methods.ts');

async function recordGroup(group) {
  makeWorld(group);
  const discovery = await sessionClient.ensureDaemon({ cwd: PATHS.project, attempts: 2, readyTimeoutMs: 120_000 });
  const daemonPid = Number(discovery.pid);
  let host = null;
  const attachments = [];
  try {
    const runtime = {
      async attachSessionClient({ onFrame, onFatal }) {
        const attached = await sessionClient.attachSession({ discovery, cwd: PATHS.project, clientKind: 'desktop', onFrame, onFatal });
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
    const ctx = { session: '', revision: 0 };
    if (group !== 'settings') {
      // The project's session, as the desktop's new task creates it (session-host-lifecycle.ts createNewTask), idle.
      const created = await attachments[0].call('session.create', { cwd: PATHS.project, desktopSession: { classification: 'project', projectPath: PATHS.project } });
      ctx.session = String(created.sessionId);
      // ... and its draft's route (configureDraft), the fixture's model.
      await attachments[0].call('session.configure', { sessionId: ctx.session, action: 'setRoute', args: [{ ...ROUTE, applyToCurrentSession: true, keepMainModel: false }] });
    }
    const methods = createRemoteMethods({ host, userDataPath: PATHS.userData });
    const cases = [];
    let frameId = 0;
    for (const request of GROUPS[group]) {
      const sent = filled(request, ctx);
      const run = async () => clone(await executeRemoteFrame(methods, JSON.stringify({ id: ++frameId, method: 'invokeCapability', params: [sent] })));
      let answer = await run();
      // A pooled socket the daemon was closing at that moment (session-client.mjs daemonCallAgent): the request never reached
      // the daemon, so it is sent once more; it is not Node's answer to the input.
      if (answer.errorCode === 'ECONNRESET') answer = await run();
      const { id: _id, ...frame } = answer;
      noteRevision(frame, ctx);
      cases.push({ group, request: clone([request])[0] ?? null, frame: kept(frame, ctx), repository: kept(repository(), ctx) });
    }
    return cases;
  } finally {
    await host?.dispose?.();
    for (const attached of attachments) await attached.close().catch(() => undefined);
    await sessionClient.shutdownDaemon(discovery, { waitForExit: true, timeoutMs: 30_000 }).catch(() => undefined);
    // Whatever outlived the stop (the supervisor, a git child) ends with the daemon's tree.
    spawnSync('taskkill', ['/T', '/F', '/PID', String(daemonPid)], { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
  }
}

const cases = [];
for (const group of groups) cases.push(...(await recordGroup(group)));

if (ONLY) {
  const text = `${JSON.stringify(cases, null, 2)}\n`;
  await new Promise((written, failed) => process.stdout.write(text, (error) => (error ? failed(error) : written())));
  process.exit(0);
}
const stage = stageSet(FIXTURES);
writeJson(join(stage, 'golden.json'), {
  note: "Node host (b6f10295a) answers to a paired phone's invokeCapability for the worktree capabilities and the review reads: per call the request the page sent ($NAME filled from the world when it runs), the relay frame (session id as <session>, run times as <time>, a carried session snapshot as <snapshot>) and the repository afterwards.",
  world: { paths: PATHS, git: GIT_IDENTITY, noSession: NO_SESSION },
  cases,
});
writeSetManifest(stage, {
  set: 'phone-worktree',
  recorder: 'benchmarks/rust-core/recorders/record-phone-worktree.mjs',
  command: `node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs benchmarks/rust-core/recorders/record-phone-worktree.mjs --tree <git archive of ${REF} with node_modules>`,
  identity,
  extra: {
    node: process.version,
    cases: cases.length,
    recorderFiles: recorderFiles(),
    entry: {
      runs: "executeRemoteFrame over createRemoteMethods (remote-methods.ts:828, :1256) with SessionHost (session-host.ts) attached to the tree's own daemon (session-client.mjs ensureDaemon, attachSession; session-protocol.mjs createSessionProtocolClient), one world and one daemon per group",
      notRun: 'the relay transport (encryption, admission) and the window process; the daemon runs without memory worker and MCP servers (MIXDOG_DAEMON_SKIP_MEMORY, MIXDOG_DISABLE_MCP), with the supervisor binary the real-turn harness cached',
    },
    syntheticInput: {
      world: 'a git repository registered as a Project (main, feature, spare; the review group leaves a.txt changed), a folder that is no Project, and one idle project session created as the new task does (session.create {cwd, desktopSession}); fixed git identity and time for every commit',
    },
    normalized: {
      session: "the session's own id is <session> in every answer (each product makes its own)",
      time: 'a field named *At is <time> (the run time)',
      snapshot: "a non-value-only answer's session snapshot is <snapshot>: the page reads only .value of these calls (worktree-branch-model.ts invokeWorktree); the snapshot is the chat's (phone-chat-live)",
    },
    notRecorded: {
      notProducible: "a request that is no object, names no or an unknown capability, has args that are no array, or a session id that is no id: the page's invokeCapability always sends {capability, args, sessionId?} with a capability it names and a session id it holds, and those requests go to the group that owns invokeCapability itself",
    },
  },
});
commitStage(stage, FIXTURES);
console.log(`phone-worktree: ${cases.length} cases`);
process.exit(0);

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
  if (!isDeepStrictEqual(manifest.recorderFiles, recorderFiles())) throw new Error('the recording was made by another recorder than this one: record again before comparing');
  globalThis.window = { setTimeout: () => 0, clearTimeout() {} };
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
      const ctx = { session: '', revision: 0 };
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
      const wanted = golden.cases.filter((entry) => entry.group === group);
      for (const [index, expected] of wanted.entries()) {
        const sent = filled(expected.request, ctx);
        let frame;
        try {
          frame = { ok: true, value: clone(await router.call('invokeCapability', [sent])) };
        } catch (error) {
          frame = {
            ok: false,
            error: error.message,
            ...(typeof error.code === 'string' && error.code ? { errorCode: error.code } : {}),
            ...(error.details !== undefined ? { errorParams: clone(error.details) } : {}),
          };
        }
        noteRevision(frame, ctx);
        compared += 1;
        const label = `${group} #${index} ${JSON.stringify(expected.request).slice(0, 140)}`;
        const got = { frame: kept(frame, ctx), repository: kept(repository(), ctx) };
        for (const field of ['frame', 'repository']) {
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
    console.log(`   node: ${JSON.stringify(entry.node).slice(0, 700)}`);
    console.log(`   core: ${JSON.stringify(entry.core).slice(0, 700)}`);
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
