// Regression for the remote file-access bypass (GitHub #40): a paired remote
// client could read ANY host file through the file-tab lanes — `readLocalFile`
// read an arbitrary absolute path, and `resolveLocalPaths` minted a grant for
// any file outside the projects that `readProjectFile`, the preview range lane
// and `writeProjectFile` then honored. Only registered-project files and files
// a conversation the device views references (an assistant reply's links, the
// paths of its tool rows) stay reachable — and never a secret-bearing file
// (remote-sensitive-paths.ts), whatever vouches for it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRemoteMethods, createSelectedFileGrants } from './remote-methods.ts';
import { MAX_SELECTED_FILE_GRANTS } from './selected-file-grants.ts';
import { withFileGrantRefresh } from '../renderer/remote-file-grant-refresh.ts';
import { createFileDownloadService } from './file-downloads.ts';
import { readLocalFileAbs, statLocalEntryAbs } from './local-files.ts';
import { readProjectTextFileIn, statProjectFileIn, writeProjectTextFileIn } from './project-files.ts';
import { searchWorkspaceTextIn } from './workspace-search.ts';
import * as remoteProjectFiles from './remote-project-files.ts';
import { openedFileAuthorizationTestHooks } from './opened-file-authorization.ts';
import { gitPathspecChanges } from './git-pathspec-changes.ts';
import { gitStage } from './git-mutations.ts';
import { sensitivePolicy } from './remote-sensitive-paths.ts';
import { execFileSync } from 'node:child_process';

const slash = (path) => path.replace(/\\/g, '/');

function fixture(t, { downloads = false } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'remote-file-access-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(base, 'project');
  const outside = join(base, 'outside');
  mkdirSync(project);
  mkdirSync(outside);
  writeFileSync(join(project, 'notes.txt'), 'project notes');
  writeFileSync(join(outside, 'secret.txt'), 'host secret');
  writeFileSync(join(outside, 'report.txt'), 'linked report');
  writeFileSync(join(outside, 'pic.png'), 'png-bytes');
  // What the session's tools produced or named: an ordinary file, and files
  // that carry secrets (a junction gives one an innocent name).
  writeFileSync(join(outside, 'tool-out.txt'), 'tool output');
  mkdirSync(join(outside, '.ssh'));
  writeFileSync(join(outside, '.ssh', 'id_rsa'), 'private key');
  writeFileSync(join(outside, '.ssh', 'config'), 'Host box');
  writeFileSync(join(outside, '.env'), 'TOKEN=abc');
  writeFileSync(join(outside, '.env.example'), 'TOKEN=');
  writeFileSync(join(outside, 'server.pem'), 'pem');
  symlinkSync(join(outside, '.ssh'), join(outside, 'innocent'), 'junction');
  mkdirSync(join(outside, 'bundle', 'nested'), { recursive: true });
  writeFileSync(join(outside, 'bundle', 'ok.txt'), 'fine');
  writeFileSync(join(outside, 'bundle', '.env'), 'TOKEN=abc');
  writeFileSync(join(outside, 'bundle', 'deploy.key'), 'key');
  writeFileSync(join(outside, 'bundle', 'nested', 'also-ok.txt'), 'fine too');
  writeFileSync(join(project, '.env'), 'PROJECT_TOKEN=abc');
  const sessions = [
    { id: 's1', cwd: project, projectPath: project, classification: 'project' },
    { id: 's2', cwd: project, projectPath: project, classification: 'project' },
  ];
  const transcripts = new Map([
    [
      's1',
      {
        items: [
          // A prompt naming a path is never provenance; a tool row's paths are.
          { id: 'u1', kind: 'user', text: `Please open ${slash(join(outside, 'secret.txt'))}` },
          {
            id: 't1',
            kind: 'tool',
            name: 'shell',
            result:
              `cat ${slash(join(outside, 'tool-out.txt'))} ${slash(join(outside, '.ssh', 'id_rsa'))} ` +
              `${slash(join(outside, '.env'))} ${slash(join(outside, '.env.example'))} ` +
              `${slash(join(outside, 'server.pem'))} ${slash(join(outside, 'innocent', 'config'))} ` +
              `${slash(join(outside, '.ssh'))}/ ${slash(join(outside, 'bundle'))}/ ${slash(join(project, '.env'))}`,
          },
          {
            id: 'a1',
            kind: 'assistant',
            text:
              `Done: [report](${slash(join(outside, 'report.txt'))}) and ` +
              `![pic](${slash(join(outside, 'pic.png'))}); see \`${slash(join(outside, 'link.txt'))}\` ` +
              `and the folder \`${slash(join(outside, 'dirlink'))}/\`.`,
          },
        ],
      },
    ],
    ['s2', { items: [] }],
  ]);
  const operations = {
    statLocalEntryAbs,
    readLocalFileAbs,
    readProjectTextFileIn,
    statProjectFileIn,
    writeProjectTextFileIn,
    searchWorkspaceTextIn,
    ...remoteProjectFiles,
  };
  const host = {
    listProjects: async () => [{ path: project }],
    projectDirectory: async (path) => {
      if (path !== project) throw new Error('Unknown project.');
      return project;
    },
    listSessions: async () => sessions,
    readSessionTranscript: async (id) => transcripts.get(id) ?? null,
    readProjectTextFile: (_project, rel) => readProjectTextFileIn(project, rel),
    invokeDesktopOperation: async (name, args) => operations[name](...args),
  };
  let viewed = ['s1'];
  const fileDownloads = downloads ? createFileDownloadService({ host }) : undefined;
  const methods = createRemoteMethods(
    { host, ...(fileDownloads ? { fileDownloads } : {}) },
    { credentialId: () => 'phone', connectionId: () => 'leg', viewedSessionIds: () => viewed }
  );
  return {
    project,
    outside,
    host,
    methods,
    fileDownloads,
    secret: join(outside, 'secret.txt'),
    report: join(outside, 'report.txt'),
    setViewed: (ids) => {
      viewed = ids;
    },
  };
}

test('a paired client cannot read a host file outside every project', async (t) => {
  const f = fixture(t);
  // Before the fix this returned the file's bytes (base64).
  await assert.rejects(f.methods.readLocalFile([f.secret]), /not linked/);
  // Before the fix this minted a grant that readProjectFile, the preview
  // range lane and writeProjectFile all honored.
  await assert.rejects(f.methods.resolveLocalPaths([[f.secret]]), /not linked/);
  await assert.rejects(f.methods.resolveLocalPaths([[f.secret], 's1']), /not linked/);
  assert.throws(() => f.methods.readProjectFile([f.outside, 'secret.txt', 'forged-token']), /unavailable/);
});

test('a file an assistant reply links in a viewed conversation opens through a one-file grant', async (t) => {
  const f = fixture(t);
  const [entry] = await f.methods.resolveLocalPaths([[f.report]]);
  assert.ok(entry.accessToken);
  const read = await f.methods.readProjectFile([entry.projectPath, entry.relPath, entry.accessToken]);
  assert.equal(read.content, 'linked report');
  // The attachment lane reads exactly the linked file this connection holds.
  assert.equal(Buffer.from((await f.methods.readLocalFile([f.report])).data, 'base64').toString(), 'linked report');
  assert.throws(
    () => f.methods.readProjectFile([entry.projectPath, 'secret.txt', entry.accessToken]),
    /does not match/
  );
  const [pic] = await f.methods.resolveLocalPaths([[join(f.outside, 'pic.png')]]);
  const range = await f.methods.previewProjectFileRange([pic.projectPath, pic.relPath, pic.accessToken, 0, 64]);
  assert.equal(Buffer.from(range.data, 'base64').toString(), 'png-bytes');
});

test('provenance is limited to the named or viewed conversations', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.methods.resolveLocalPaths([[f.report], 's2']), /not linked/);
  f.setViewed([]);
  await assert.rejects(f.methods.resolveLocalPaths([[f.report]]), /not linked/);
  const [entry] = await f.methods.resolveLocalPaths([[f.report], 's1']);
  assert.ok(entry.accessToken);
});

test('registered project files keep their project addressing', async (t) => {
  const f = fixture(t);
  const [entry] = await f.methods.resolveLocalPaths([[join(f.project, 'notes.txt')]]);
  assert.equal(entry.projectPath, f.project);
  assert.equal(entry.relPath, 'notes.txt');
  assert.equal(entry.accessToken, undefined);
  const attached = await f.methods.readLocalFile([join(f.project, 'notes.txt')]);
  assert.equal(Buffer.from(attached.data, 'base64').toString(), 'project notes');
});

test('a junction inside a project does not reach the files it points at', async (t) => {
  const f = fixture(t);
  symlinkSync(f.outside, join(f.project, 'escape'), 'junction');
  // Before the fix the lexical project path read the secret through the link.
  await assert.rejects(
    f.methods.readLocalFile([join(f.project, 'escape', 'secret.txt')]),
    /outside the project|not linked/
  );
  await assert.rejects(f.methods.resolveLocalPaths([[join(f.project, 'escape', 'secret.txt')]]), /not linked/);
});

test('a linked file that is a symlink to an unlinked file is refused', async (t) => {
  const f = fixture(t);
  try {
    symlinkSync(f.secret, join(f.outside, 'link.txt'), 'file');
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('file symlinks need elevated rights on this host');
      return;
    }
    throw error;
  }
  await assert.rejects(f.methods.resolveLocalPaths([[join(f.outside, 'link.txt')]]), /symbolic link/);
});

test('a linked folder that is a junction to an unlinked folder is refused', async (t) => {
  const f = fixture(t);
  const hidden = join(f.outside, '..', 'hidden');
  mkdirSync(hidden);
  symlinkSync(hidden, join(f.outside, 'dirlink'), 'junction');
  await assert.rejects(f.methods.resolveLocalPaths([[join(f.outside, 'dirlink')]]), /symbolic link/);
});

test('a file a tool row names is readable, but secret-bearing files are refused', async (t) => {
  const f = fixture(t);
  const toolOut = join(f.outside, 'tool-out.txt');
  const [entry] = await f.methods.resolveLocalPaths([[toolOut]]);
  const read = await f.methods.readProjectFile([entry.projectPath, entry.relPath, entry.accessToken]);
  assert.equal(read.content, 'tool output');
  assert.equal(Buffer.from((await f.methods.readLocalFile([toolOut])).data, 'base64').toString(), 'tool output');
  // A template carries no secret.
  const [template] = await f.methods.resolveLocalPaths([[join(f.outside, '.env.example')]]);
  assert.ok(template.accessToken);
  // The same tool row names these too: a private key, .env, a .pem, and a
  // file reached through a junction whose target is ~/.ssh-like.
  for (const secret of [join('.ssh', 'id_rsa'), '.env', 'server.pem', join('innocent', 'config')]) {
    const path = join(f.outside, secret);
    await assert.rejects(f.methods.resolveLocalPaths([[path]]), /credentials or secrets/, secret);
    await assert.rejects(f.methods.readLocalFile([path]), /credentials or secrets|not linked/, secret);
  }
});

test('secret-bearing files inside a registered project are refused on every lane', async (t) => {
  const f = fixture(t);
  const env = join(f.project, '.env');
  await assert.rejects(f.methods.resolveLocalPaths([[env]]), /credentials or secrets/);
  await assert.rejects(f.methods.readLocalFile([env]), /credentials or secrets/);
  await assert.rejects(f.methods.readProjectFile([f.project, '.env']), /credentials or secrets/);
  await assert.rejects(
    f.methods.writeProjectFile([f.project, '.env', 'X=1', 'PROJECT_TOKEN=abc']),
    /credentials or secrets/
  );
  await assert.rejects(
    f.methods.previewProjectFileRange([f.project, '.env', undefined, 0, 16]),
    /credentials or secrets/
  );
  // The rest of the project is untouched.
  assert.equal((await f.methods.readProjectFile([f.project, 'notes.txt'])).content, 'project notes');
});

test('workspace search, git diffs and entry moves never expose or relocate a secret-bearing file', async (t) => {
  const f = fixture(t);
  const calls = [];
  const diff = [
    'diff --git a/.env b/.env',
    '--- a/.env',
    '+++ b/.env',
    '@@ -1 +1 @@',
    '-PROJECT_TOKEN=abc',
    '+PROJECT_TOKEN=def',
    'diff --git a/notes.txt b/notes.txt',
    '--- a/notes.txt',
    '+++ b/notes.txt',
    '@@ -1 +1 @@',
    '-project notes',
    '+project notes!',
    '',
  ].join('\n');
  const passthrough = f.host.invokeDesktopOperation;
  f.host.invokeDesktopOperation = async (name, args) => {
    calls.push(name);
    if (name === 'searchWorkspaceTextIn') return searchWorkspaceTextIn(...args);
    if (name === 'gitDiff' || name === 'gitReviewDiff' || name === 'gitShowDiff') return diff;
    if (name === 'gitReviewDiffs') {
      return { patches: args[1].map((file) => ({ path: file.path, patch: '' })), omitted: [] };
    }
    return passthrough(name, args);
  };
  f.host.renameProjectEntry = async (...args) => calls.push(['rename', ...args]);
  f.host.moveProjectEntry = async (...args) => calls.push(['move', ...args]);
  f.host.copyProjectEntry = async (...args) => calls.push(['copy', ...args]);

  // Before the fix the search read `.env` and returned its secret line.
  const found = await f.methods.searchWorkspaceText([f.project, { query: 'TOKEN|notes', regex: true }]);
  assert.deepEqual(
    found.files.map((file) => file.relPath),
    ['notes.txt']
  );

  // Before the fix `.env`'s diff came back verbatim.
  await assert.rejects(f.methods.gitDiff([f.project, '.env', false]), /credentials or secrets/);
  const whole = await f.methods.gitDiff([f.project, '.', false]);
  assert.doesNotMatch(whole, /\.env|PROJECT_TOKEN/);
  assert.match(whole, /project notes!/);
  const batch = await f.methods.gitReviewDiffs([
    f.project,
    [
      { path: '.env', untracked: false },
      { path: 'notes.txt', untracked: false },
    ],
    'uncommitted',
  ]);
  assert.deepEqual(
    batch.patches.map((entry) => entry.path),
    ['notes.txt']
  );
  assert.deepEqual(batch.omitted, ['.env']);

  // Before the fix the rename succeeded and readProjectFile then served
  // `public.txt` — the secret under an innocent name.
  const before = calls.length;
  await assert.rejects(f.methods.renameProjectEntry([f.project, '.env', 'public.txt']), /credentials or secrets/);
  await assert.rejects(f.methods.moveProjectEntry([f.project, '.env', 'docs']), /credentials or secrets/);
  await assert.rejects(f.methods.copyProjectEntry([f.project, '.env', 'docs']), /credentials or secrets/);
  await assert.rejects(f.methods.renameProjectEntry([f.project, 'notes.txt', '.env']), /credentials or secrets/);
  assert.equal(calls.length, before);
  await f.methods.renameProjectEntry([f.project, 'notes.txt', 'renamed.txt']);
  assert.deepEqual(calls.at(-1), ['rename', f.project, 'notes.txt', 'renamed.txt']);
});

test('renaming, moving or copying a folder refuses when it holds a secret file, and allows a normal folder', async (t) => {
  const f = fixture(t);
  const calls = [];
  f.host.renameProjectEntry = async (...args) => calls.push(['rename', ...args]);
  f.host.moveProjectEntry = async (...args) => calls.push(['move', ...args]);
  f.host.copyProjectEntry = async (...args) => calls.push(['copy', ...args]);
  mkdirSync(join(f.project, '.codex'));
  writeFileSync(join(f.project, '.codex', 'auth.json'), '{"token":"x"}');
  mkdirSync(join(f.project, 'cfg', 'deep'), { recursive: true });
  writeFileSync(join(f.project, 'cfg', 'deep', '.env'), 'TOKEN=abc');
  mkdirSync(join(f.project, 'docs'));
  writeFileSync(join(f.project, 'docs', 'a.md'), 'fine');

  const denied = /credentials or secrets/;
  await assert.rejects(f.methods.renameProjectEntry([f.project, '.codex', 'archive']), denied);
  await assert.rejects(f.methods.renameProjectEntry([f.project, 'cfg', 'plain']), denied);
  await assert.rejects(f.methods.moveProjectEntry([f.project, 'cfg', 'docs']), denied);
  await assert.rejects(f.methods.copyProjectEntry([f.project, 'cfg', 'docs']), denied);
  assert.equal(calls.length, 0);

  await f.methods.renameProjectEntry([f.project, 'docs', 'guides']);
  assert.deepEqual(calls.at(-1), ['rename', f.project, 'docs', 'guides']);
});

test('staging, committing or discarding a folder refuses when Git would include a secret file in it', async (t) => {
  const f = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: f.project, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'a@example.com');
  git('config', 'user.name', 'A');
  mkdirSync(join(f.project, 'src'));
  writeFileSync(join(f.project, 'src', 'app.ts'), 'app');
  writeFileSync(join(f.project, 'src', '.npmrc'), '//registry:_authToken=x');
  const calls = [];
  const passthrough = f.host.invokeDesktopOperation;
  f.host.invokeDesktopOperation = async (name, args) => {
    calls.push(name);
    if (name === 'gitPathspecChanges') return gitPathspecChanges(...args);
    if (name === 'gitStage') return gitStage(...args);
    return passthrough(name, args);
  };
  const staged = () => git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  // Before the fix `.` and `src` staged `.env` and `src/.npmrc`.
  await assert.rejects(f.methods.gitStage([f.project, ['.']]), /credentials or secrets/);
  await assert.rejects(f.methods.gitStage([f.project, ['src']]), /credentials or secrets/);
  await assert.rejects(f.methods.gitStage([f.project, ['*.txt', 'src/*']]), /credentials or secrets/);
  await assert.rejects(f.methods.gitCommitPaths([f.project, 'message', ['src']]), /credentials or secrets/);
  await assert.rejects(f.methods.gitRevert([f.project, 'src', true, 'all']), /credentials or secrets/);
  assert.deepEqual(staged(), []);
  assert.equal(
    calls.includes('gitStage') || calls.includes('gitCommitPaths') || calls.includes('gitRevertFile'),
    false
  );
  // Once the secrets are ignored, Git leaves them out and the folder stages.
  writeFileSync(join(f.project, '.gitignore'), '.env\n.npmrc\n');
  await f.methods.gitStage([f.project, ['.']]);
  assert.deepEqual(staged().sort(), ['.gitignore', 'notes.txt', 'src/app.ts']);
});

test("the remote search applies the authorizing process's policy, not the searching process's", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.project, 'private'));
  writeFileSync(join(f.project, 'private', 'pairing.txt'), 'TOKEN in a private root');
  writeFileSync(join(f.project, 'plain.txt'), 'TOKEN in the open');
  // A root registered where the request was authorized, never in the
  // process that runs the search (here: never registered at all).
  const policy = { ...sensitivePolicy(), registered: [[join(f.project, 'private'), []]] };
  const options = { query: 'TOKEN', matchCase: false, wholeWord: false, regex: false, maxResults: 100 };
  const found = await searchWorkspaceTextIn(f.project, { ...options, sensitivePolicy: policy });
  // Before the fix the search consulted only its own process's registrations.
  assert.deepEqual(
    found.files.map((file) => file.relPath),
    ['plain.txt']
  );
  // A malformed policy fails the search instead of searching without one.
  for (const broken of [null, {}, { ...policy, registered: 'x' }]) {
    await assert.rejects(
      searchWorkspaceTextIn(f.project, { ...options, sensitivePolicy: broken }),
      /policy is invalid/
    );
  }
});

/** Arms a one-shot swap: once `name` (a file under `folder`) passed its
 *  checks and is about to be opened, `folder` becomes a junction to `target`. */
function swapBeforeOpen(folder, name, target) {
  openedFileAuthorizationTestHooks.beforeOpen = (absolute) => {
    if (absolute !== join(folder, name)) return;
    openedFileAuthorizationTestHooks.beforeOpen = undefined;
    rmSync(folder, { recursive: true, force: true });
    symlinkSync(target, folder, 'junction');
  };
}

test('a file swapped for a link to an in-project secret between the checks and the I/O is never read or written', async (t) => {
  const f = fixture(t);
  t.after(() => {
    openedFileAuthorizationTestHooks.beforeOpen = undefined;
  });
  const docs = join(f.project, 'docs');
  const restore = () => {
    rmSync(docs, { recursive: true, force: true });
    mkdirSync(docs);
    writeFileSync(join(docs, 'notes.md'), 'plain TOKEN');
  };
  restore();
  mkdirSync(join(f.project, '.aws'));
  writeFileSync(join(f.project, '.aws', 'notes.md'), 'aws_secret TOKEN');
  assert.equal((await f.methods.readProjectFile([f.project, 'docs/notes.md'])).content, 'plain TOKEN');
  // Before the fix these read and overwrote `.aws/notes.md` through the link.
  swapBeforeOpen(docs, 'notes.md', join(f.project, '.aws'));
  await assert.rejects(f.methods.readProjectFile([f.project, 'docs/notes.md']), /credentials or secrets/);
  restore();
  swapBeforeOpen(docs, 'notes.md', join(f.project, '.aws'));
  await assert.rejects(
    f.methods.writeProjectFile([f.project, 'docs/notes.md', 'overwritten', 'aws_secret TOKEN']),
    /credentials or secrets/
  );
  assert.equal(readFileSync(join(f.project, '.aws', 'notes.md'), 'utf8'), 'aws_secret TOKEN');
  restore();
  swapBeforeOpen(docs, 'notes.md', join(f.project, '.aws'));
  const found = await f.methods.searchWorkspaceText([f.project, { query: 'TOKEN' }]);
  assert.doesNotMatch(JSON.stringify(found), /aws_secret/);
  restore();
  // Unswapped, the save goes through the authorized handle.
  await f.methods.writeProjectFile([f.project, 'docs/notes.md', 'plain TOKEN, saved', 'plain TOKEN']);
  assert.equal(readFileSync(join(docs, 'notes.md'), 'utf8'), 'plain TOKEN, saved');
});

test('editor settings read a workspace file only with provenance, by name and through its handle', async (t) => {
  const f = fixture(t);
  t.after(() => {
    openedFileAuthorizationTestHooks.beforeOpen = undefined;
  });
  writeFileSync(join(f.project, 'team.code-workspace'), JSON.stringify({ settings: { 'editor.tabSize': 7 } }));
  writeFileSync(join(f.outside, 'stray.code-workspace'), JSON.stringify({ settings: { 'editor.tabSize': 3 } }));
  const vscode = join(f.project, '.vscode');
  mkdirSync(vscode);
  writeFileSync(join(vscode, 'settings.json'), JSON.stringify({ 'editor.insertSpaces': false }));
  const settings = await f.methods.readEditorSettings([f.project, 'a.ts', join(f.project, 'team.code-workspace')]);
  assert.equal(settings.tabSize, 7);
  assert.equal(settings.insertSpaces, false);
  // Before the fix any path was read, whatever vouched for it.
  await assert.rejects(
    f.methods.readEditorSettings([f.project, 'a.ts', join(f.outside, 'stray.code-workspace')]),
    /not linked/
  );
  await assert.rejects(
    f.methods.readEditorSettings([f.project, 'a.ts', join(f.project, '.git', 'team.code-workspace')]),
    /credentials or secrets/
  );
  // The project's own settings folder swapped for a link onto a secret one.
  mkdirSync(join(f.project, '.aws'));
  writeFileSync(join(f.project, '.aws', 'settings.json'), JSON.stringify({ 'editor.tabSize': 11 }));
  swapBeforeOpen(vscode, 'settings.json', join(f.project, '.aws'));
  await assert.rejects(f.methods.readEditorSettings([f.project, 'a.ts']), /credentials or secrets/);
});

test('a referenced file and folder download unless they carry secrets', async (t) => {
  const f = fixture(t, { downloads: true });
  const phone = { deviceId: 'phone' };
  const ask = (kind, path) =>
    f.fileDownloads.authorize(phone, { source: { kind, sessionId: 's1', path }, purpose: 'save' });
  const refusedSensitive = (promise) => assert.rejects(promise, (error) => error?.code === 'file-download:sensitive');
  const grant = await ask('session', join(f.outside, 'tool-out.txt'));
  assert.equal(grant.size, 'tool output'.length);
  await f.fileDownloads.abort(phone, grant.grantId);
  for (const secret of [join('.ssh', 'id_rsa'), '.env', 'server.pem', join('innocent', 'config')]) {
    await refusedSensitive(ask('session', join(f.outside, secret)));
  }
  await refusedSensitive(ask('session', join(f.project, '.env')));
  // A denied folder is refused outright.
  await refusedSensitive(ask('folder', join(f.outside, '.ssh')));
  // Inside an ordinary folder only the denied entries are left out.
  const zipGrant = await ask('folder', join(f.outside, 'bundle'));
  const transfer = await f.fileDownloads.begin(phone, zipGrant.grantId);
  const chunk = await f.fileDownloads.readRange(phone, transfer.transferId, 0, transfer.size, transfer.version);
  const zip = Buffer.from(chunk.data, 'base64').toString('latin1');
  assert.match(zip, /ok\.txt/);
  assert.match(zip, /nested\/also-ok\.txt/);
  assert.doesNotMatch(zip, /\.env|deploy\.key/);
  await f.fileDownloads.finish(phone, transfer.transferId);
});

test('an unlinked secret outside every project is refused by name, every time', async (t) => {
  const f = fixture(t);
  // s2 links nothing: before the fix these got the generic "not linked".
  for (const secret of [join(f.outside, '.ssh', 'id_rsa'), join(f.outside, '.aws', 'credentials')]) {
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await assert.rejects(f.methods.resolveLocalPaths([[secret], 's2']), /credentials or secrets/, secret);
      await assert.rejects(f.methods.readLocalFile([secret]), /credentials or secrets/, secret);
    }
  }
  // An ordinary unlinked file keeps its own reason.
  await assert.rejects(f.methods.resolveLocalPaths([[f.secret], 's2']), /not linked/);
});

test('a linked file keeps one grant across repeat opens and the device reconnecting', async (t) => {
  const f = fixture(t);
  const deviceGrants = createSelectedFileGrants(() => false);
  const client = { credentialId: () => 'phone', connectionId: () => 'leg', viewedSessionIds: () => ['s1'] };
  const firstLeg = createRemoteMethods({ host: f.host, selectedFileGrants: deviceGrants }, client);
  const [first] = await firstLeg.resolveLocalPaths([[f.report]]);
  // Opening the link again (and more than the grant cap) reuses the token, so
  // the one a side-panel tab or cached link holds is never evicted.
  for (let open = 0; open <= MAX_SELECTED_FILE_GRANTS; open += 1) {
    const [again] = await firstLeg.resolveLocalPaths([[f.report]]);
    assert.equal(again.accessToken, first.accessToken);
  }
  // A new relay leg of the same device still honors it.
  const nextLeg = createRemoteMethods({ host: f.host, selectedFileGrants: deviceGrants }, client);
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const read = await nextLeg.readProjectFile([first.projectPath, first.relPath, first.accessToken]);
    assert.equal(read.content, 'linked report');
  }
});

test('a held link asked for again is vouched for by any conversation, never wider', async (t) => {
  const f = fixture(t);
  // The device now views s2, which links nothing; s1 links the report.
  f.setViewed(['s2']);
  await assert.rejects(f.methods.resolveLocalPaths([[f.report]]), /not linked/);
  await assert.rejects(f.methods.resolveLocalPaths([[f.report], 's2']), /not linked/);
  // Before the fix the refresh got the same "not linked".
  const any = { anyConversation: true };
  for (const session of [null, 's2']) {
    const [entry] = await f.methods.resolveLocalPaths([[f.report], session, any]);
    assert.ok(entry.accessToken);
    const read = await f.methods.readProjectFile([entry.projectPath, entry.relPath, entry.accessToken]);
    assert.equal(read.content, 'linked report');
  }
  // The policy is unchanged: a path no reply links, or a secret one, is refused.
  await assert.rejects(f.methods.resolveLocalPaths([[f.secret], null, any]), /not linked/);
  await assert.rejects(
    f.methods.resolveLocalPaths([[join(f.outside, '.ssh', 'id_rsa')], null, any]),
    /credentials or secrets/
  );
});

test('after a PC restart a held link from an unviewed conversation reopens through the client refresh', async (t) => {
  const f = fixture(t);
  const [held] = await f.methods.resolveLocalPaths([[f.report]]);
  // The PC restarted (every grant is gone) and the device views s2 now.
  const client = { credentialId: () => 'phone', connectionId: () => 'leg2', viewedSessionIds: () => ['s2'] };
  const restarted = createRemoteMethods(
    { host: f.host, selectedFileGrants: createSelectedFileGrants(() => false) },
    client
  );
  // A fresh page with no kept record, as after cleared storage.
  const call = withFileGrantRefresh(async (method, params) => restarted[method](params));
  for (let open = 0; open < 5; open += 1) {
    const read = await call('readProjectFile', [held.projectPath, held.relPath, held.accessToken]);
    assert.equal(read.content, 'linked report');
  }
});

test('a held link whose folder became a project reopens through the project route', async (t) => {
  const f = fixture(t);
  const [held] = await f.methods.resolveLocalPaths([[f.report]]);
  const roots = [f.project, f.outside];
  const host = {
    ...f.host,
    listProjects: async () => roots.map((path) => ({ path })),
    projectDirectory: async (path) => {
      if (!roots.includes(path)) throw new Error('Unknown project.');
      return path;
    },
    readProjectTextFile: (project, rel) => readProjectTextFileIn(project, rel),
  };
  const restarted = createRemoteMethods(
    { host, selectedFileGrants: createSelectedFileGrants(() => false) },
    { credentialId: () => 'phone', connectionId: () => 'leg2', viewedSessionIds: () => ['s1'] }
  );
  const call = withFileGrantRefresh(async (method, params) => restarted[method](params));
  for (let open = 0; open < 5; open += 1) {
    const read = await call('readProjectFile', [held.projectPath, held.relPath, held.accessToken]);
    assert.equal(read.content, 'linked report');
  }
});

test('a bridge grant expires', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const f = fixture(t);
  const [entry] = await f.methods.resolveLocalPaths([[f.report]]);
  t.mock.timers.tick(60 * 60 * 1000 + 1);
  assert.throws(() => f.methods.readProjectFile([entry.projectPath, entry.relPath, entry.accessToken]), /unavailable/);
  await assert.rejects(f.methods.readLocalFile([f.report]), /not linked/);
});

test('a bridge grant ends when its conversation is deleted', async (t) => {
  const f = fixture(t, { downloads: true });
  f.fileDownloads.retainSessions(['s1', 's2']);
  const [entry] = await f.methods.resolveLocalPaths([[f.report]]);
  f.fileDownloads.retainSessions(['s2']);
  assert.throws(() => f.methods.readProjectFile([entry.projectPath, entry.relPath, entry.accessToken]), /unavailable/);
});
