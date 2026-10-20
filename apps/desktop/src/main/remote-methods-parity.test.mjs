import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DESKTOP_CAPABILITIES, DESKTOP_IPC, DESKTOP_READ_CAPABILITIES } from '../shared/contract.ts';
import { registerSessionIpc } from './ipc-sessions.ts';
import { createRemoteMethods, createSelectedFileGrants } from './remote-methods.ts';
import { remoteFilePreviewTestHooks } from './remote-file-preview.ts';
import { sensitivePolicy } from './remote-sensitive-paths.ts';
import * as remoteProjectFiles from './remote-project-files.ts';
import { replaceWorkspaceTextIn, searchWorkspaceTextIn } from './workspace-search.ts';
import { SelectedFileAccess } from './selected-file-access.ts';

const CWD = process.cwd();
const SESSION = `sess_desktop_${'a'.repeat(64)}`;

function operationHost(extra = {}) {
  const operations = [];
  return {
    operations,
    host: {
      invokeDesktopOperation: async (name, args) => {
        operations.push([name, args]);
        return { name };
      },
      ...extra,
    },
  };
}

test('every pull request route validates the repository and forwards to the same host operation', async () => {
  const { host, operations } = operationHost();
  const methods = createRemoteMethods({ host });
  await methods.ghPrList([CWD]);
  await methods.ghPrDefaultBranch([CWD]);
  await methods.ghPrCreate([CWD, { title: 't' }]);
  await methods.ghPrView([CWD, 7]);
  await methods.ghPrCheckout([CWD, 7]);
  await methods.ghPrMerge([CWD, 7, 'squash']);
  await methods.ghPrDiff([CWD, 7]);
  assert.deepEqual(operations, [
    ['ghPrList', [CWD]],
    ['ghPrDefaultBranch', [CWD]],
    ['ghPrCreate', [CWD, { title: 't' }]],
    ['ghPrView', [CWD, 7]],
    ['ghPrCheckout', [CWD, 7]],
    ['ghPrMerge', [CWD, 7, 'squash']],
    ['ghPrDiff', [CWD, 7]],
  ]);
  assert.throws(() => methods.ghPrList(['relative/dir']), /project directory/);
  assert.equal(operations.length, 7);
});

test('browserReleasePage releases only main-workspace tab pages', async () => {
  const released = [];
  const methods = createRemoteMethods({
    host: {},
    browserRemote: async (method, args) => released.push([method, args]),
  });
  await methods.browserReleasePage(['main-browser-a']);
  assert.deepEqual(released, [['release', ['main-browser-a']]]);
  await assert.rejects(async () => methods.browserReleasePage([SESSION]), /not a main tab page/);
  await assert.rejects(async () => methods.browserReleasePage([7]), /session id/);
  assert.equal(released.length, 1);
  // Like the desktop handler, an app without Browser Use releases nothing.
  assert.equal(await createRemoteMethods({ host: {} }).browserReleasePage(['main-browser-a']), undefined);
});

test('trashProjectEntry resolves the entry on the host and trashes it in the window process', async () => {
  const requests = [];
  const methods = createRemoteMethods({
    host: { projectEntryPath: async (project, rel) => `${project}/${rel}` },
    hostRequest: async (method, args) => requests.push([method, args]),
  });
  await methods.trashProjectEntry(['/p', 'a.txt']);
  assert.deepEqual(requests, [['trashItem', ['/p/a.txt']]]);
  await assert.rejects(async () => methods.trashProjectEntry(['/p', '']), /relPath/);
  await assert.rejects(
    async () => createRemoteMethods({ host: { projectEntryPath: async () => '/x' } }).trashProjectEntry(['/p', 'a']),
    /unavailable/
  );
});

test('localPageUrl confines the page to its project and mints the lease in the window process', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-page-')));
  mkdirSync(join(root, 'docs'));
  // The page is opened and authorized, so it must exist.
  writeFileSync(join(root, 'docs', 'a.html'), '<p>a</p>');
  const requests = [];
  const methods = createRemoteMethods({
    host: { projectDirectory: async () => root },
    hostRequest: async (method, args) => {
      requests.push([method, args]);
      return 'http://127.0.0.1:9/token/docs/a.html';
    },
  });
  assert.equal(await methods.localPageUrl(['p', 'docs/a.html', null]), 'http://127.0.0.1:9/token/docs/a.html');
  assert.deepEqual(requests, [['localPageUrl', [root, join('docs', 'a.html'), 'project', sensitivePolicy()]]]);
  await assert.rejects(async () => methods.localPageUrl(['p', '../outside.html', null]), /outside the project/);
  assert.equal(requests.length, 1);
  await assert.rejects(
    async () => createRemoteMethods({ host: { projectDirectory: async () => root } }).localPageUrl(['p', 'a.html']),
    /unavailable/
  );
});

test('the host updater is reached through the window process', async () => {
  const requests = [];
  const state = { status: 'ready', version: '2.0.0' };
  const methods = createRemoteMethods({
    host: {},
    hostRequest: async (method, args) => {
      requests.push([method, args]);
      return state;
    },
  });
  assert.equal(await methods.getUpdaterState([]), state);
  assert.equal(await methods.checkForDesktopUpdate([]), state);
  assert.equal(await methods.showDesktopUpdate([]), state);
  assert.deepEqual(
    requests.map(([method]) => method),
    ['updaterState', 'updaterCheck', 'updaterInstall']
  );
});

test('a settings write notifies the host windows and every client', async () => {
  const { host, operations } = operationHost();
  const saved = { keepAwake: true };
  const changed = [];
  const methods = createRemoteMethods({
    host,
    settingsStore: { read: async () => saved, update: async () => saved },
    onDesktopSettingsChanged: (value) => changed.push(value),
  });
  assert.equal(await methods.updateSetting(['keepAwake', true]), saved);
  assert.deepEqual(changed, [saved]);
  assert.deepEqual(operations, [['notifySettingsChanged', ['desktop']]]);
  await assert.rejects(async () => methods.updateSetting(['keepAwake', 'yes']), /boolean/);
  assert.equal(operations.length, 1);

  await methods.setGitGlobalConfig(['user.name', 'Ada']);
  assert.deepEqual(operations.at(-1), ['notifySettingsChanged', ['git']]);
  assert.equal(operations.at(-2)[0], 'setGitGlobalConfig');
});

test('prefetchSession drops an empty read trace id like the desktop handler', async () => {
  const calls = [];
  const methods = createRemoteMethods({
    host: { prefetchSession: async (...args) => calls.push(args) },
  });
  await methods.prefetchSession([SESSION, 40, '']);
  await methods.prefetchSession([SESSION, 40, 'trace']);
  assert.deepEqual(
    calls.map((call) => call[2]),
    [undefined, 'trace']
  );
});

test('openAgentHome resolves the same home thread on the desktop and a paired device', async () => {
  const calls = [];
  const host = {
    openAgentHome: async (agentId) => {
      calls.push(agentId);
      return { sessionId: `sess_home_${agentId}` };
    },
  };
  const handlers = new Map();
  registerSessionIpc({ handle: (channel, listener) => handlers.set(channel, listener), host });
  const desktop = (agentId) => handlers.get(DESKTOP_IPC.openAgentHome)({}, agentId);
  const remote = createRemoteMethods({ host }).openAgentHome;
  assert.deepEqual(await desktop('github-watcher'), { sessionId: 'sess_home_github-watcher' });
  assert.deepEqual(await remote(['github-watcher']), { sessionId: 'sess_home_github-watcher' });
  assert.deepEqual(calls, ['github-watcher', 'github-watcher']);
  // Both refuse a missing or oversized agent id before reaching the host.
  for (const bad of [undefined, 42, 'x'.repeat(201)]) {
    await assert.rejects(async () => desktop(bad));
    await assert.rejects(async () => remote([bad]));
  }
  assert.equal(calls.length, 2);
});

test('resetAgentHome starts the same home thread over on the desktop and a paired device', async () => {
  const calls = [];
  const host = {
    resetAgentHome: async (agentId) => {
      calls.push(agentId);
      return { sessionId: `sess_home_${agentId}`, archivedSessionId: 'sess_archive' };
    },
  };
  const handlers = new Map();
  registerSessionIpc({ handle: (channel, listener) => handlers.set(channel, listener), host });
  const desktop = (agentId) => handlers.get(DESKTOP_IPC.resetAgentHome)({}, agentId);
  const remote = createRemoteMethods({ host }).resetAgentHome;
  const expected = { sessionId: 'sess_home_lead', archivedSessionId: 'sess_archive' };
  assert.deepEqual(await desktop('lead'), expected);
  assert.deepEqual(await remote(['lead']), expected);
  for (const bad of [undefined, 42, 'x'.repeat(201)]) {
    await assert.rejects(async () => desktop(bad));
    await assert.rejects(async () => remote([bad]));
  }
  assert.deepEqual(calls, ['lead', 'lead']);
});

test('a file outside every project gets the same grant answers on the desktop and a paired device', async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-grant-parity-')));
  const file = join(folder, 'report.txt');
  writeFileSync(file, 'linked report');
  const desktop = new SelectedFileAccess({ storePath: '', listProjects: async () => [] });
  const remote = createSelectedFileGrants(() => false);
  // Describing (resolving) the file again keeps its one token on both sides.
  const [first] = await desktop.describe([file]);
  const [again] = await desktop.describe([file]);
  assert.equal(again.accessToken, first.accessToken);
  assert.deepEqual([first.projectPath, first.relPath], [folder, 'report.txt']);
  const token = remote.rememberFileGrant(file, 's1');
  assert.equal(remote.rememberFileGrant(file, 's1'), token);
  assert.deepEqual(remote.grantedFile(token, folder, 'report.txt').absolute, file);
  // The same refusals, word for word: the remote client refreshes on the
  // "unavailable" one, so it must stay the text both hosts send.
  const refusal = async (attempt) => {
    try {
      await attempt();
    } catch (error) {
      return error.message;
    }
    return null;
  };
  for (const [desktopRefusal, remoteRefusal] of [
    [
      () => desktop.requireGrant('unknown', folder, 'report.txt'),
      () => remote.grantedFile('unknown', folder, 'report.txt'),
    ],
    [
      () => desktop.requireGrant(first.accessToken, folder, 'other.txt'),
      () => remote.grantedFile(token, folder, 'other.txt'),
    ],
  ]) {
    const message = await refusal(desktopRefusal);
    assert.ok(message);
    assert.equal(await refusal(remoteRefusal), message);
  }
  assert.equal(
    await refusal(() => desktop.requireGrant('unknown', folder, 'report.txt')),
    'The selected-file permission is unavailable.'
  );
});

/** Remote methods that read, write, describe or relocate a file a request
 *  names, with arguments naming the project's `.env`: each must refuse it
 *  before any host operation runs. */
const REFUSING = (project) => ({
  readProjectFile: [project, '.env'],
  statProjectFile: [project, '.env'],
  writeProjectFile: [project, '.env', 'X=1', 'TOKEN=abc'],
  previewDocumentPages: [project, '.env', null, {}],
  previewProjectFile: [project, '.env', null],
  previewProjectFileRange: [project, '.env', null, 0, 16],
  captureFileSnapshot: [project, '.env', null],
  localPageUrl: [project, '.env', null],
  readLocalFile: [join(project, '.env')],
  resolveLocalPaths: [[join(project, '.env')]],
  readEditorBackup: [project, '.env', null],
  writeEditorBackup: [project, '.env', 'a', 'b', null],
  deleteEditorBackup: [project, '.env', null],
  saveWorkspace: [join(project, '.git', 'project.code-workspace'), [{ path: project }]],
  readEditorSettings: [project, 'a.ts', join(project, '.git', 'project.code-workspace')],
  replaceWorkspaceText: [project, { query: 'TOKEN' }, 'X', ['.env']],
  lspDocument: [{ kind: 'open', projectPath: project, relPath: '.env', languageId: 'dotenv', version: 1 }],
  lspRequest: [{ projectPath: project, relPath: '.env', languageId: 'dotenv', method: 'textDocument/completion' }],
  lspApplyWorkspaceEdit: [project, [{ relPath: '.env', content: 'a', expectedContent: 'b' }]],
  gitDiff: [project, '.env', false],
  gitReviewDiff: [project, '.env', false, 'uncommitted'],
  gitShowDiff: [project, 'abcdef1', '.env'],
  gitShowFile: [project, 'HEAD', '.env'],
  gitApplyPatch: [project, '.env', 'diff --git a/.env b/.env\n'],
  gitStage: [project, ['.env']],
  gitCommitPaths: [project, 'message', ['.env']],
  gitRevert: [project, '.env', false, 'all'],
  trashProjectEntry: [project, '.env'],
  createProjectEntry: [project, '.ssh', 'config', false],
  renameProjectEntry: [project, '.env', 'public.txt'],
  moveProjectEntry: [project, '.env', 'docs'],
  copyProjectEntry: [project, '.env', 'docs'],
});

/** Folder-capable Git calls given a folder or `.`: refused when Git's own
 *  expansion of the pathspec covers a secret-bearing file. */
const FOLDER_PATHSPECS = (project) => ({
  gitStage: [project, ['.']],
  gitCommitPaths: [project, 'message', ['src']],
  gitRevert: [project, '.', false, 'all'],
});

/** Methods whose answer covers many files: the secret-bearing ones are left
 *  out (asserted below) instead of the call being refused. */
const FILTERING = [
  'searchWorkspaceText',
  'gitReviewDiffs',
  'gitRequestContext',
  'ghPrDiff',
  'invokeCapability',
  'readCapabilities',
];

/** The review reads invokeCapability/readCapabilities filter, and one answer
 *  carrying a secret file at every level a review nests files. */
const TURN_REVIEW_CAPABILITIES = {
  getTurnReviewDiff: [{}],
  getSessionReviewDiff: [],
  getTurnChanges: [{ checkpointId: 'cp' }],
  getTurnReviewFilePatch: ['.env'],
  getSessionReviewFilePatch: ['.env'],
};
const REVIEW = {
  supported: true,
  files: [
    { path: '.env', additions: 1 },
    { path: 'notes.txt', additions: 1 },
    { path: 'renamed.txt', oldPath: 'id_rsa', additions: 0 },
  ],
  patch: 'diff --git a/.env b/.env\n+TOKEN=abc\ndiff --git a/notes.txt b/notes.txt\n+ok\n',
  agents: [{ files: [{ path: 'deep/.npmrc' }], patch: 'diff --git a/deep/.npmrc b/deep/.npmrc\n+_authToken=x\n' }],
  file: { path: '.env', patch: 'diff --git a/.env b/.env\n+TOKEN=abc\n' },
};
const REVIEW_WITHOUT_SECRETS = {
  supported: true,
  files: [{ path: 'notes.txt', additions: 1 }],
  patch: 'diff --git a/notes.txt b/notes.txt\n+ok\n',
  agents: [{ files: [], patch: '' }],
  file: { path: '.env', patch: '' },
};

/** Methods on the file surface that never produce a named file's content nor
 *  move one, and why. */
const EXEMPT = {
  // Names, sizes and stats only.
  listProjectDir: 'entry names',
  searchProjectFiles: 'entry names',
  listHostDirectories: 'directory names',
  folderWatch: 'change notifications',
  folderUnwatch: 'change notifications',
  gitStatus: 'paths and line counts',
  gitReview: 'paths and line counts',
  gitShow: 'commit metadata and paths',
  gitLog: 'commit metadata',
  gitStashList: 'stash names',
  codeGraphQuery: 'code symbols',
  // Index, refs and remotes: no file content crosses, nothing is staged by name.
  gitUnstage: 'index',
  gitIgnore: 'writes .gitignore',
  gitCommit: 'commits what is already staged',
  gitAmend: 'commits what is already staged',
  gitUndoLastCommit: 'refs',
  // `stash push -u` does take a secret's changes, but only into a stash
  // entry in this repository: no byte crosses to the device, and every
  // remote route that could later show it (gitShowDiff, the diff reads,
  // gitShowFile) refuses or filters secret files.
  gitStash: 'moves changes into a local stash; no content leaves the host',
  gitStashPop: 'refs',
  gitStashApply: 'refs',
  gitStashDrop: 'refs',
  gitBranches: 'refs',
  gitRenameBranch: 'refs',
  gitDeleteBranch: 'refs',
  gitCreateTag: 'refs',
  gitDeleteTag: 'refs',
  gitPush: 'refs',
  gitFetch: 'refs',
  gitPull: 'refs',
  gitSync: 'refs',
  gitContinue: 'refs',
  gitAbortOperation: 'refs',
  gitResetToCommit: 'refs',
  gitRevertCommit: 'refs',
  gitCherryPickCommit: 'refs',
  gitGlobalConfig: 'git identity',
  setGitGlobalConfig: 'git identity',
  gitCliStatus: 'tool status',
  projectRecovery: "the app's own record of its edits",
  // Guarded in their own modules (file-downloads, remote-visualize, session-attachments).
  fileDownloadAuthorize: 'file-downloads.ts',
  fileDownloadBegin: 'file-downloads.ts',
  fileDownloadRange: 'file-downloads.ts',
  fileDownloadFinish: 'file-downloads.ts',
  fileDownloadAbort: 'file-downloads.ts',
  visualizePaneFile: 'remote-visualize.ts',
  visualizePanePages: 'remote-visualize.ts',
  visualizePaneRange: 'remote-visualize.ts',
  visualizeExport: 'remote-visualize.ts',
  attachmentOpen: 'content-addressed store',
  readAttachmentThumbnail: 'content-addressed store',
  // Project registration.
  addProject: 'registration',
  removeProject: 'registration',
  renameProject: 'registration',
  startProject: 'registration',
  startProjectTask: 'registration',
  listProjects: 'registration',
  setSessionProject: 'registration',
  // The GitHub account and API: nothing on this machine's disk.
  githubRequest: 'GitHub API',
  githubStarStatus: 'GitHub API',
  githubCliStatus: 'GitHub CLI',
  githubCliAccount: 'GitHub CLI',
  githubCliLogout: 'GitHub CLI',
  githubCliLoginStart: 'GitHub CLI',
  githubCliLoginStatus: 'GitHub CLI',
  githubCliLoginOpenBrowser: 'GitHub CLI',
  githubCliLoginCancel: 'GitHub CLI',
};

/** Names that put a method on the file surface. */
const FILE_SURFACE =
  /File|Entry|Entries|Diff|Patch|Backup|Workspace|Local|Preview|Lsp|lsp|FileSnapshot|Page[A-Z]|Folder|folder|Download|Attachment|^visualizePane|^visualizeExport|codeGraph|Recovery|^git|Project/;

test('every remote file entry point applies the sensitive-path guard', async (t) => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-guard-parity-')));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  writeFileSync(join(project, '.env'), 'TOKEN=abc');
  writeFileSync(join(project, 'notes.txt'), 'TOKEN mentioned');
  mkdirSync(join(project, '.ssh'));
  const touched = [];
  const record = (name, args) => {
    touched.push([name, args]);
    if (name === 'searchWorkspaceTextIn') return { files: [], matchCount: 0, limitHit: false };
    if (name === 'gitReviewDiffs') return { patches: [], omitted: [] };
    if (name === 'gitRequestContext') return { files: [] };
    if (name === 'ghPrDiff') return 'diff --git a/.env b/.env\n+TOKEN=abc\ndiff --git a/notes.txt b/notes.txt\n+ok\n';
    // `.` as Git expands it.
    if (name === 'gitPathspecChanges') return [join(project, '.env'), join(project, 'notes.txt')];
    if (name === 'invokeCapability') return { value: REVIEW };
    if (name === 'readCapabilities') return [{ ok: true, value: REVIEW }];
    return null;
  };
  // Path resolution is all a guard may ask the host; anything else it is
  // asked counts as touching the file.
  const resolvers = {
    listProjects: async () => [{ path: project }],
    projectDirectory: async () => project,
    projectEntryPath: async (_project, rel) => join(project, rel),
    listSessions: async () => [],
    invokeDesktopOperation: async (name, args) => record(name, args),
  };
  const host = new Proxy(resolvers, {
    get: (target, name) =>
      name in target || typeof name !== 'string' ? target[name] : async (...args) => record(name, args),
  });
  const methods = createRemoteMethods({
    host,
    userDataPath: join(project, 'user'),
    hostRequest: async (name, args) => record(name, args),
  });

  const refusing = REFUSING(project);
  const classified = new Set([...Object.keys(refusing), ...FILTERING, ...Object.keys(EXEMPT)]);
  const unclassified = Object.keys(methods).filter((name) => FILE_SURFACE.test(name) && !classified.has(name));
  assert.deepEqual(unclassified, [], 'a remote file method must be guarded, filtering or exempt with a reason');

  for (const [name, params] of Object.entries(refusing)) {
    await assert.rejects(async () => methods[name](params), /credentials or secrets/, name);
    assert.deepEqual(touched, [], `${name} touched the host before refusing`);
  }

  // A folder or `.` is expanded by Git, and refused when it covers a secret.
  for (const [name, params] of Object.entries(FOLDER_PATHSPECS(project))) {
    const before = touched.length;
    await assert.rejects(async () => methods[name](params), /credentials or secrets/, name);
    assert.deepEqual(
      touched.slice(before).map(([operation]) => operation),
      ['gitPathspecChanges'],
      `${name} ran before its pathspec was checked`
    );
  }

  await methods.searchWorkspaceText([project, { query: 'TOKEN' }]);
  assert.deepEqual(
    touched.at(-1)[1][1].sensitivePolicy,
    sensitivePolicy(),
    'search carries the deny policy to the process that reads the candidates'
  );
  // Before the fix these answers crossed with `.env`, `id_rsa` and `.npmrc`.
  for (const [capability, args] of Object.entries(TURN_REVIEW_CAPABILITIES)) {
    const invokable = DESKTOP_CAPABILITIES.includes(capability);
    const readable = DESKTOP_READ_CAPABILITIES.includes(capability);
    assert.ok(invokable || readable, `${capability} is a remote capability`);
    if (invokable) {
      const { value } = await methods.invokeCapability([{ capability, args, sessionId: SESSION }]);
      assert.deepEqual(value, REVIEW_WITHOUT_SECRETS, capability);
    }
    if (readable) {
      const [read] = await methods.readCapabilities([[{ capability, args, sessionId: SESSION }]]);
      assert.deepEqual(read.value, REVIEW_WITHOUT_SECRETS, capability);
    }
  }
  await methods.gitReviewDiffs([
    project,
    [
      { path: '.env', untracked: false },
      { path: 'notes.txt', untracked: false },
    ],
  ]);
  assert.deepEqual(touched.at(-1)[1][1], [{ path: 'notes.txt', untracked: false }]);
  await methods.gitRequestContext([project, { paths: ['.env', 'notes.txt'], base: '' }]);
  assert.deepEqual(touched.at(-1)[1][1].paths, ['notes.txt']);
  const prDiff = await methods.ghPrDiff([project, 7]);
  assert.doesNotMatch(prDiff, /\.env|TOKEN/);
  assert.match(prDiff, /notes\.txt/);
});

/** Remote methods that read a file's bytes, or hand the file to other work
 *  (a snapshot, a conversion, the page server, a media lease): each opens it
 *  through openAuthorizedFile, so it is judged by where the open file is. */
const HANDLE_AUTHORIZED = {
  previewProjectFile: ['clip.mp4', (project) => [project, 'clip.mp4', null]],
  previewProjectFileRange: ['clip.mp4', (project) => [project, 'clip.mp4', null, 0, 4]],
  captureFileSnapshot: ['clip.mp4', (project) => [project, 'clip.mp4', null]],
  previewDocumentPages: ['doc.pdf', (project) => [project, 'doc.pdf', null, {}]],
  localPageUrl: ['page.html', (project) => [project, 'page.html', null]],
  readProjectFile: ['read.txt', (project) => [project, 'read.txt']],
  writeProjectFile: ['write.txt', (project) => [project, 'write.txt', 'written', 'write.txt']],
  readLocalFile: ['local.txt', (project) => [join(project, 'local.txt')]],
  readEditorSettings: ['team.code-workspace', (project) => [project, 'read.txt', join(project, 'team.code-workspace')]],
  saveWorkspace: ['team.code-workspace', (project) => [join(project, 'team.code-workspace'), [{ path: project }]]],
  searchWorkspaceText: ['search.txt', (project) => [project, { query: 'NEEDLE' }]],
  replaceWorkspaceText: ['replace.txt', (project) => [project, { query: 'REPLACEME' }, 'replaced', ['replace.txt']]],
  lspApplyWorkspaceEdit: [
    'lsp.txt',
    (project) => [project, [{ relPath: 'lsp.txt', content: 'edited', expectedContent: 'lsp.txt' }]],
  ],
};

/** Remote methods on the file surface that read or write no file's bytes on
 *  this machine (or do so in their own, separately tested module), and why.
 *  With HANDLE_AUTHORIZED they classify every guarded method above. */
const NO_FILE_BYTES = {
  statProjectFile: 'size and mtime only',
  resolveLocalPaths: 'stat only',
  readEditorBackup: "the app's own backup store, keyed by the file's path",
  writeEditorBackup: "the app's own backup store, keyed by the file's path",
  deleteEditorBackup: "the app's own backup store, keyed by the file's path",
  lspDocument: 'the device sends the content',
  lspRequest: 'language-server answers',
  gitDiff: 'git output, filtered by file section',
  gitReviewDiff: 'git output, filtered by file section',
  gitShowDiff: 'git output, filtered by file section',
  gitShowFile: 'a git object, not the worktree file',
  gitApplyPatch: 'git applies the patch; every file it names is checked',
  gitStage: 'the index; Git-expanded pathspecs are checked',
  gitCommitPaths: 'the index; Git-expanded pathspecs are checked',
  gitRevert: 'git restores; Git-expanded pathspecs are checked',
  trashProjectEntry: 'moves an entry, reads nothing',
  createProjectEntry: 'creates an empty entry',
  renameProjectEntry: 'moves an entry, reads nothing',
  moveProjectEntry: 'moves an entry, reads nothing',
  copyProjectEntry: 'copies an entry on the host, nothing crosses',
};

test('every remote method that reads or writes file bytes authorizes the opened file', async (t) => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-handle-parity-')));
  t.after(() => {
    remoteFilePreviewTestHooks.beforeOpen = undefined;
    rmSync(project, { recursive: true, force: true });
  });
  for (const [file] of Object.values(HANDLE_AUTHORIZED)) writeFileSync(join(project, file), file);
  writeFileSync(join(project, 'search.txt'), 'NEEDLE');
  writeFileSync(join(project, 'replace.txt'), 'REPLACEME');
  writeFileSync(join(project, 'team.code-workspace'), '{}');
  // The operations the remote lanes hand file work to, as the desktop runs them.
  const operations = {
    ...remoteProjectFiles,
    searchWorkspaceTextIn,
    replaceWorkspaceTextIn: (root, options, replacement, relPaths) =>
      replaceWorkspaceTextIn(root, options, replacement, relPaths),
  };
  const opened = [];
  remoteFilePreviewTestHooks.beforeOpen = (absolute) => opened.push(absolute);
  const methods = createRemoteMethods({
    host: {
      listProjects: async () => [{ path: project }],
      projectDirectory: async () => project,
      invokeDesktopOperation: async (name, args) => (operations[name] ? operations[name](...args) : {}),
    },
    hostRequest: async () => ({}),
  });
  // Every guarded method is classified: its bytes go through an authorized
  // handle, or it reads and writes none.
  const refusing = Object.keys(REFUSING('/p'));
  assert.deepEqual(
    refusing.filter((name) => !(name in HANDLE_AUTHORIZED) && !(name in NO_FILE_BYTES)),
    [],
    'a guarded method must be handle-authorized or read no file bytes'
  );
  for (const [name, [file, params]] of Object.entries(HANDLE_AUTHORIZED)) {
    opened.length = 0;
    await methods[name](params(project));
    assert.ok(opened.includes(join(project, file)), `${name} opened ${file} through openAuthorizedFile`);
  }
});

test('a conversion reads a private copy of the authorized bytes, never the original path', async (t) => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-copy-parity-')));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const original = join(project, 'doc.pdf');
  writeFileSync(original, 'authorized bytes');
  const seen = [];
  const convert = async (root, rel) => {
    // Another process swaps the original and restores it around the read.
    writeFileSync(original, 'swapped secret');
    seen.push({ root, bytes: readFileSync(join(root, rel), 'utf8') });
    writeFileSync(original, 'authorized bytes');
    return { pages: [] };
  };
  const methods = createRemoteMethods({
    host: {
      listProjects: async () => [{ path: project }],
      projectDirectory: async () => project,
      invokeDesktopOperation: async (name, args) => (name === 'documentPreviewPagesIn' ? convert(...args) : null),
    },
  });
  await methods.previewDocumentPages([project, 'doc.pdf', null, {}]);
  // Before the fix the converter read the original path: 'swapped secret'.
  assert.equal(seen[0].bytes, 'authorized bytes');
  assert.notEqual(seen[0].root, project);
  assert.equal(existsSync(seen[0].root), false, 'the private copy is removed afterwards');
});

test('editor backups refuse a path that escapes the project like the desktop handler', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-parity-')));
  mkdirSync(join(root, 'src'));
  const { host, operations } = operationHost({ projectDirectory: async () => root });
  const methods = createRemoteMethods({ host, userDataPath: join(root, 'user') });
  await methods.readEditorBackup(['p', 'src/a.ts', null]);
  assert.equal(operations[0][0], 'readEditorBackup');
  assert.equal(operations[0][1][1], join(root, 'src', 'a.ts'));
  await assert.rejects(async () => methods.readEditorBackup(['p', '../outside.ts', null]), /outside the project/);
  assert.equal(operations.length, 1);
});
