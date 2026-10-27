// PC-level parity of the remote file lanes: a paired device is the user's own,
// so it opens, reads, saves, searches, diffs and downloads exactly what the
// desktop does, under the desktop's own rules — a registered project's paths
// stay inside it (projectEntryPathIn), and a file outside every project is
// reached through a one-file grant the device gets by describing it, as the
// desktop's SelectedFileAccess does. No remote-only deny list (secret-bearing
// names), no link provenance.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createRemoteMethods, createSelectedFileGrants } from './remote-methods.ts';
import { MAX_SELECTED_FILE_GRANTS } from './selected-file-grants.ts';
import { SelectedFileAccess } from './selected-file-access.ts';
import { withFileGrantRefresh } from '../renderer/remote-file-grant-refresh.ts';
import { createFileDownloadService } from './file-downloads.ts';
import { readLocalFileAbs, statLocalEntryAbs } from './local-files.ts';
import { readProjectTextFileIn, statProjectFileIn, writeProjectTextFileIn } from './project-files.ts';
import { searchWorkspaceTextIn } from './workspace-search.ts';
import { readScopedEditorSettings } from './workspace-config.ts';
import * as remoteProjectFiles from './remote-project-files.ts';
import { openedFileAuthorizationTestHooks } from './opened-file-authorization.ts';
import { gitStage } from './git-mutations.ts';
import { execFileSync } from 'node:child_process';

import { makeTempDirSync, redirectSystemTemp } from '../../../../scripts/lib/scoped-temp.mjs';

redirectSystemTemp('tmp-root');
const slash = (path) => path.replace(/\\/g, '/');

function fixture(t, { downloads = false } = {}) {
  const base = realpathSync(makeTempDirSync('remote-file-access'));
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
    readScopedEditorSettings,
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

test('a host file outside every project opens and attaches like on the desktop, linked or not', async (t) => {
  const f = fixture(t);
  // No reply links secret.txt (only a prompt names it). Before parity both
  // lanes refused it as "not linked"; the desktop serves it.
  const desktop = new SelectedFileAccess({ storePath: '', listProjects: f.host.listProjects });
  assert.equal(Buffer.from((await readLocalFileAbs(f.secret)).data, 'base64').toString(), 'host secret');
  assert.equal(Buffer.from((await f.methods.readLocalFile([f.secret])).data, 'base64').toString(), 'host secret');
  const [mine] = await desktop.describe([f.secret]);
  const [entry] = await f.methods.resolveLocalPaths([[f.secret]]);
  assert.deepEqual([entry.projectPath, entry.relPath, entry.dir], [mine.projectPath, mine.relPath, mine.dir]);
  assert.ok(entry.accessToken);
  const read = await f.methods.readProjectFile([entry.projectPath, entry.relPath, entry.accessToken]);
  assert.equal(read.content, 'host secret');
  const range = await f.methods.previewProjectFileRange([entry.projectPath, entry.relPath, entry.accessToken, 0, 64]);
  assert.equal(Buffer.from(range.data, 'base64').toString(), 'host secret');
  // A token the device was never given is refused, as the desktop refuses one.
  assert.throws(() => f.methods.readProjectFile([f.outside, 'secret.txt', 'forged-token']), /unavailable/);
  await assert.rejects(desktop.requireGrant('forged-token', f.outside, 'secret.txt'), /unavailable/);
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

test('a file is described the same whatever conversation the device names or views', async (t) => {
  const f = fixture(t);
  const [linked] = await f.methods.resolveLocalPaths([[f.report], 's1']);
  // Before parity these were refused: s2 links nothing, and nothing is viewed.
  const [other] = await f.methods.resolveLocalPaths([[f.report], 's2']);
  f.setViewed([]);
  const [none] = await f.methods.resolveLocalPaths([[f.report]]);
  const [retry] = await f.methods.resolveLocalPaths([[f.report], null, { anyConversation: true }]);
  assert.ok(linked.accessToken);
  assert.deepEqual(
    [other.accessToken, none.accessToken, retry.accessToken],
    [linked.accessToken, linked.accessToken, linked.accessToken]
  );
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

test('a junction inside a project is held to the project boundary on both surfaces', async (t) => {
  const f = fixture(t);
  symlinkSync(f.outside, join(f.project, 'escape'), 'junction');
  const through = join(f.project, 'escape', 'secret.txt');
  const desktop = new SelectedFileAccess({ storePath: '', listProjects: f.host.listProjects });
  // Described as the project's file, as the desktop describes it…
  const [mine] = await desktop.describe([through]);
  const [entry] = await f.methods.resolveLocalPaths([[through]]);
  assert.deepEqual([entry.projectPath, entry.relPath, entry.accessToken], [f.project, 'escape/secret.txt', undefined]);
  assert.deepEqual([mine.projectPath, mine.relPath], [entry.projectPath, entry.relPath]);
  // …so the project route refuses what leaves the project, on the desktop too.
  await assert.rejects(readProjectTextFileIn(f.project, entry.relPath), /outside the project/);
  await assert.rejects(f.methods.readProjectFile([entry.projectPath, entry.relPath]), /outside the project/);
  // The attachment lane reads the path like the desktop's readLocalFileAbs.
  assert.equal(Buffer.from((await f.methods.readLocalFile([through])).data, 'base64').toString(), 'host secret');
});

test('a file reached through a symlink opens like on the desktop', async (t) => {
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
  // Before parity: refused as a symbolic link to an unlinked file.
  const [entry] = await f.methods.resolveLocalPaths([[join(f.outside, 'link.txt')]]);
  const read = await f.methods.readProjectFile([entry.projectPath, entry.relPath, entry.accessToken]);
  assert.equal(read.content, 'host secret');
});

test('a folder reached through a junction is described like on the desktop', async (t) => {
  const f = fixture(t);
  const hidden = join(f.outside, '..', 'hidden');
  mkdirSync(hidden);
  symlinkSync(hidden, join(f.outside, 'dirlink'), 'junction');
  // Before parity: refused as a symbolic link to an unlinked folder.
  const [entry] = await f.methods.resolveLocalPaths([[join(f.outside, 'dirlink')]]);
  assert.deepEqual([entry.dir, entry.accessToken], [true, undefined]);
});

test('secret-bearing files outside every project open and attach like any other file', async (t) => {
  const f = fixture(t);
  for (const [secret, bytes] of [
    [join('.ssh', 'id_rsa'), 'private key'],
    ['.env', 'TOKEN=abc'],
    ['server.pem', 'pem'],
    [join('innocent', 'config'), 'Host box'],
  ]) {
    const path = join(f.outside, secret);
    // Before parity each was refused as "credentials or secrets".
    const [entry] = await f.methods.resolveLocalPaths([[path]]);
    const read = await f.methods.readProjectFile([entry.projectPath, entry.relPath, entry.accessToken]);
    assert.equal(read.content, bytes, secret);
    assert.equal(Buffer.from((await f.methods.readLocalFile([path])).data, 'base64').toString(), bytes, secret);
  }
});

test('secret-bearing files inside a registered project are served on every lane, as on the desktop', async (t) => {
  const f = fixture(t);
  const env = join(f.project, '.env');
  // Before parity every one of these was refused as "credentials or secrets".
  const [entry] = await f.methods.resolveLocalPaths([[env]]);
  assert.deepEqual([entry.projectPath, entry.relPath], [f.project, '.env']);
  assert.equal(Buffer.from((await f.methods.readLocalFile([env])).data, 'base64').toString(), 'PROJECT_TOKEN=abc');
  assert.equal((await f.methods.readProjectFile([f.project, '.env'])).content, 'PROJECT_TOKEN=abc');
  // A previewable file in a secret folder streams its range.
  mkdirSync(join(f.project, '.ssh'), { recursive: true });
  writeFileSync(join(f.project, '.ssh', 'key.png'), 'png key');
  const range = await f.methods.previewProjectFileRange([f.project, '.ssh/key.png', undefined, 0, 64]);
  assert.equal(Buffer.from(range.data, 'base64').toString(), 'png key');
  await f.methods.writeProjectFile([f.project, '.env', 'PROJECT_TOKEN=def', 'PROJECT_TOKEN=abc']);
  assert.equal(readFileSync(env, 'utf8'), 'PROJECT_TOKEN=def');
  // What the desktop refuses stays refused: a path out of the project.
  await assert.rejects(readProjectTextFileIn(f.project, '../outside/secret.txt'), /outside the project/);
  await assert.rejects(f.methods.readProjectFile([f.project, '../outside/secret.txt']), /outside the project/);
});

test('workspace search, git diffs and entry moves treat a secret-bearing file like any other', async (t) => {
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

  // Before parity the search left `.env` out.
  const found = await f.methods.searchWorkspaceText([f.project, { query: 'TOKEN|notes', regex: true }]);
  assert.deepEqual(found.files.map((file) => file.relPath).sort(), ['.env', 'notes.txt']);

  // Before parity `.env`'s diff was refused or cut out of a folder's.
  assert.equal(await f.methods.gitDiff([f.project, '.env', false]), diff);
  assert.equal(await f.methods.gitDiff([f.project, '.', false]), diff);
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
    ['.env', 'notes.txt']
  );
  assert.deepEqual(batch.omitted, []);

  // Before parity these renames, moves and copies were refused.
  await f.methods.renameProjectEntry([f.project, '.env', 'public.txt']);
  await f.methods.moveProjectEntry([f.project, '.env', 'docs']);
  await f.methods.copyProjectEntry([f.project, '.env', 'docs']);
  await f.methods.renameProjectEntry([f.project, 'notes.txt', '.env']);
  assert.deepEqual(calls.slice(-4), [
    ['rename', f.project, '.env', 'public.txt'],
    ['move', f.project, '.env', 'docs'],
    ['copy', f.project, '.env', 'docs'],
    ['rename', f.project, 'notes.txt', '.env'],
  ]);
});

test('a folder holding a secret file is renamed, moved and copied like any other', async (t) => {
  const f = fixture(t);
  const calls = [];
  f.host.renameProjectEntry = async (...args) => calls.push(['rename', ...args]);
  f.host.moveProjectEntry = async (...args) => calls.push(['move', ...args]);
  f.host.copyProjectEntry = async (...args) => calls.push(['copy', ...args]);
  mkdirSync(join(f.project, '.codex'));
  writeFileSync(join(f.project, '.codex', 'auth.json'), '{"token":"x"}');
  mkdirSync(join(f.project, 'cfg', 'deep'), { recursive: true });
  writeFileSync(join(f.project, 'cfg', 'deep', '.env'), 'TOKEN=abc');

  // Before parity each was refused as "credentials or secrets".
  await f.methods.renameProjectEntry([f.project, '.codex', 'archive']);
  await f.methods.renameProjectEntry([f.project, 'cfg', 'plain']);
  await f.methods.moveProjectEntry([f.project, 'cfg', 'docs']);
  await f.methods.copyProjectEntry([f.project, 'cfg', 'docs']);
  assert.deepEqual(calls, [
    ['rename', f.project, '.codex', 'archive'],
    ['rename', f.project, 'cfg', 'plain'],
    ['move', f.project, 'cfg', 'docs'],
    ['copy', f.project, 'cfg', 'docs'],
  ]);
});

test('staging, committing or discarding a folder lets Git include a secret file, as on the desktop', async (t) => {
  const f = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: f.project, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'a@example.com');
  git('config', 'user.name', 'A');
  mkdirSync(join(f.project, 'src'));
  writeFileSync(join(f.project, 'src', 'app.ts'), 'app');
  writeFileSync(join(f.project, 'src', '.npmrc'), '//registry:_authToken=x');
  const passthrough = f.host.invokeDesktopOperation;
  f.host.invokeDesktopOperation = async (name, args) =>
    name === 'gitStage' ? gitStage(...args) : passthrough(name, args);
  const staged = () => git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  // Before parity `.` was refused because Git would stage `.env` and `src/.npmrc`.
  await f.methods.gitStage([f.project, ['.']]);
  assert.deepEqual(staged().sort(), ['.env', 'notes.txt', 'src/.npmrc', 'src/app.ts']);
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

test('a file swapped for a link out of the project between the checks and the I/O is never read or written', async (t) => {
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
  const elsewhere = join(f.outside, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'notes.md'), 'outside TOKEN');
  assert.equal((await f.methods.readProjectFile([f.project, 'docs/notes.md'])).content, 'plain TOKEN');
  // The desktop's project boundary, held at the open: the swapped-in link
  // leads out of the project.
  swapBeforeOpen(docs, 'notes.md', elsewhere);
  await assert.rejects(f.methods.readProjectFile([f.project, 'docs/notes.md']), /outside the project/);
  restore();
  swapBeforeOpen(docs, 'notes.md', elsewhere);
  await assert.rejects(
    f.methods.writeProjectFile([f.project, 'docs/notes.md', 'overwritten', 'outside TOKEN']),
    /outside the project/
  );
  assert.equal(readFileSync(join(elsewhere, 'notes.md'), 'utf8'), 'outside TOKEN');
  restore();
  // Unswapped, the save goes through the authorized handle.
  await f.methods.writeProjectFile([f.project, 'docs/notes.md', 'plain TOKEN, saved', 'plain TOKEN']);
  assert.equal(readFileSync(join(docs, 'notes.md'), 'utf8'), 'plain TOKEN, saved');
});

test('editor settings read any workspace file, as the desktop handler does', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.project, 'team.code-workspace'), JSON.stringify({ settings: { 'editor.tabSize': 7 } }));
  writeFileSync(join(f.outside, 'stray.code-workspace'), JSON.stringify({ settings: { 'editor.tabSize': 3 } }));
  const vscode = join(f.project, '.vscode');
  mkdirSync(vscode);
  writeFileSync(join(vscode, 'settings.json'), JSON.stringify({ 'editor.insertSpaces': false }));
  const settings = await f.methods.readEditorSettings([f.project, 'a.ts', join(f.project, 'team.code-workspace')]);
  assert.equal(settings.tabSize, 7);
  assert.equal(settings.insertSpaces, false);
  // Before parity: refused as "not linked".
  const stray = join(f.outside, 'stray.code-workspace');
  const remote = await f.methods.readEditorSettings([f.project, 'a.ts', stray]);
  assert.equal(remote.tabSize, 3);
  assert.deepEqual(remote, await readScopedEditorSettings('', f.project, 'a.ts', stray));
});

test('a referenced file and folder download whatever they hold, as the desktop opens them', async (t) => {
  const f = fixture(t, { downloads: true });
  const phone = { deviceId: 'phone' };
  const ask = (kind, path) =>
    f.fileDownloads.authorize(phone, { source: { kind, sessionId: 's1', path }, purpose: 'save' });
  const read = async (grant) => {
    const transfer = await f.fileDownloads.begin(phone, grant.grantId);
    const chunk = await f.fileDownloads.readRange(phone, transfer.transferId, 0, transfer.size, transfer.version);
    await f.fileDownloads.finish(phone, transfer.transferId);
    return Buffer.from(chunk.data, 'base64');
  };
  assert.equal((await read(await ask('session', join(f.outside, 'tool-out.txt')))).toString(), 'tool output');
  // Before parity each of these was refused as `sensitive`.
  for (const [secret, bytes] of [
    [join('.ssh', 'id_rsa'), 'private key'],
    ['.env', 'TOKEN=abc'],
    ['server.pem', 'pem'],
    [join('innocent', 'config'), 'Host box'],
  ]) {
    assert.equal((await read(await ask('session', join(f.outside, secret)))).toString(), bytes, secret);
  }
  assert.equal((await read(await ask('session', join(f.project, '.env')))).toString(), 'PROJECT_TOKEN=abc');
  // A folder zips whole: before parity `.ssh` was refused and `.env` and
  // `deploy.key` were left out of `bundle`.
  assert.match((await read(await ask('folder', join(f.outside, '.ssh')))).toString('latin1'), /id_rsa/);
  const zipGrant = await ask('folder', join(f.outside, 'bundle'));
  assert.deepEqual(zipGrant.leftOut, { ignored: 0, secret: 0 });
  const zip = (await read(zipGrant)).toString('latin1');
  for (const entry of [/ok\.txt/, /nested\/also-ok\.txt/, /\.env/, /deploy\.key/]) assert.match(zip, entry);
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
  // Describing the file again (the client's refresh) hands out a live grant.
  const [again] = await f.methods.resolveLocalPaths([[f.report]]);
  assert.equal(
    (await f.methods.readProjectFile([again.projectPath, again.relPath, again.accessToken])).content,
    'linked report'
  );
});

test("a described file's grant outlives the conversation it was opened from, like the desktop's", async (t) => {
  const f = fixture(t, { downloads: true });
  f.fileDownloads.retainSessions(['s1', 's2']);
  const [entry] = await f.methods.resolveLocalPaths([[f.report], 's1']);
  f.fileDownloads.retainSessions(['s2']);
  // Before parity the grant ended with s1.
  const read = await f.methods.readProjectFile([entry.projectPath, entry.relPath, entry.accessToken]);
  assert.equal(read.content, 'linked report');
});
