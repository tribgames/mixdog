import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DESKTOP_IPC } from '../shared/contract';
import { ipcErrorFromEnvelope } from '../shared/coded-error';
import { registerDesktopIpc } from './ipc';
import * as projectFiles from './project-files';
import { createCoreLocalPages, setCoreLocalPages } from './core-local-pages';
import { localPageUrl } from './local-page-server';
import { SelectedFileAccess } from './selected-file-access';

// The core stands behind these two clients; here the in-process twins answer the same calls.
setCoreLocalPages(
  createCoreLocalPages(async (name, [root, rel, , ownerId]) => {
    if (name === 'localPageUrlIn') return localPageUrl(root, rel, { scope: 'project', owner: { ownerId }, authorize: async () => {} });
    throw new Error(`unexpected core call ${name}`);
  })
);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-file-links-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  await mkdir(join(project, 'output'), { recursive: true });
  const handlers = new Map();
  const mainFrame = {};
  const webContents = { mainFrame, isDestroyed: () => false, send() {}, on() {}, once() {}, removeListener() {} };
  const opened = [];
  const revealed = [];
  const trashed = [];
  // The core's grant store (grantDescribe / grantRedeem), answered by the in-process twin.
  const grants = new SelectedFileAccess({ storePath: '', listProjects: async () => [] });
  const remove = registerDesktopIpc(
    { webContents, isDestroyed: () => false },
    {
      subscribe: () => () => {},
      subscribeSessionStates: () => () => {},
      listProjects: async () => [],
      // No folder is a registered Project here.
      ...Object.fromEntries(
        [
          'projectDirectory',
          'listProjectDir',
          'readProjectTextFile',
          'writeProjectTextFile',
          'statProjectFile',
          'createProjectEntry',
          'renameProjectEntry',
          'moveProjectEntry',
          'copyProjectEntry',
          'projectEntryPath',
        ].map((name) => [
          name,
          async () => {
            // Uncoded, as an older runtime without listProjectsStrict refuses.
            throw new Error('Project is not available.');
          },
        ])
      ),
      invokeDesktopOperation: async (method, args) => {
        // A folder outside every Project is a root of its own; the core claims a trashed path, then the OS trash takes it.
        if (method === 'standaloneRoot') return (await stat(args[0]).catch(() => null))?.isDirectory() ? args[0] : null;
        if (method === 'trashProjectEntryIn') return void trashed.push(projectFiles.projectEntryPathIn(...args));
        if (method === 'grantDescribe') return grants.describe(args[0], args[1] !== false);
        if (method === 'grantRedeem') return grants.requireGrant(...args);
        return projectFiles[method](...args);
      },
    },
    {
      app: { quit() {} },
      ipcMain: {
        handle: (channel, listener) => handlers.set(channel, listener),
        removeHandler: (channel) => handlers.delete(channel),
        on() {},
        removeListener() {},
      },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      shell: {
        openPath: async (file) => {
          opened.push(file);
          return '';
        },
        openExternal: async () => {},
        showItemInFolder: (file) => revealed.push(file),
        trashItem: async (file) => trashed.push(file),
      },
    }
  );
  t.after(remove);
  const event = { sender: webContents, senderFrame: mainFrame };
  return {
    directory,
    project,
    opened,
    revealed,
    trashed,
    event,
    handlers,
  };
}

test('reveal validates the project boundary and reveals the real file', async (t) => {
  const f = await fixture(t);
  const file = join(f.project, 'output', 'report.pdf');
  await writeFile(file, 'sample');
  const reveal = f.handlers.get(DESKTOP_IPC.revealFile);
  await reveal(f.event, f.project, 'output/report.pdf');
  assert.deepEqual(
    f.revealed.map((p) => p.replace(/\\/g, '/')),
    [file.replace(/\\/g, '/')]
  );
  await assert.rejects(async () => reveal(f.event, f.project, '../outside.pdf'));
  // A token main does not grant is refused with its code in the IPC envelope.
  assert.equal(
    ipcErrorFromEnvelope(await reveal(f.event, f.project, '../../outside.pdf', 'bad-token')).code,
    'SELECTED_FILE_GRANT_UNAVAILABLE'
  );
  assert.equal(f.revealed.length, 1);
  assert.deepEqual(f.opened, []);
});

test('external chat files use existing selected-file access for reading and saving without registering a Project', async (t) => {
  const f = await fixture(t);
  const file = join(f.directory, 'external.ts');
  await writeFile(file, 'export const value = 1;\n');
  const invoke = (channel, ...args) => f.handlers.get(channel)(f.event, ...args);
  const [target] = await invoke(DESKTOP_IPC.resolveLocalPaths, [file]);
  assert.ok(target.accessToken);
  assert.equal(target.absolutePath, file);
  const read = () => invoke(DESKTOP_IPC.readProjectFile, target.projectPath, target.relPath, target.accessToken);
  const initial = await read();
  assert.equal(initial.content, 'export const value = 1;\n');
  assert.equal(initial.binary, false);
  await invoke(DESKTOP_IPC.statProjectFile, target.projectPath, target.relPath, target.accessToken);
  await invoke(
    DESKTOP_IPC.writeProjectFile,
    target.projectPath,
    target.relPath,
    'export const value = 2;\n',
    initial.content,
    target.accessToken,
    initial.encoding
  );
  assert.equal((await read()).content, 'export const value = 2;\n');
  await assert.rejects(
    invoke(DESKTOP_IPC.readProjectFile, target.projectPath, 'other.ts', target.accessToken),
    /does not match/
  );
  assert.deepEqual(f.opened, []);
});

test('a folder outside every Project is a Project-like root for every tree operation, wherever it is', async (t) => {
  const f = await fixture(t);
  const folder = join(f.directory, 'outside-docs');
  await mkdir(join(folder, 'nested'), { recursive: true });
  await writeFile(join(folder, 'nested', 'note.md'), '# note\n');
  await writeFile(join(f.directory, 'secret.txt'), 'not linked');
  const invoke = (channel, ...args) => f.handlers.get(channel)(f.event, ...args);
  const link = (path) => invoke(DESKTOP_IPC.resolveLocalPaths, [path], 's1', { chatLink: true });

  // No registration, conversation or transcript is involved: the folder is
  // its own root, and so a restored tree lists it with nothing re-clicked.
  assert.deepEqual(await invoke(DESKTOP_IPC.listProjectDir, folder, ''), [{ name: 'nested', dir: true }]);
  const [entry] = await link(folder);
  assert.equal(entry.dir, true);
  assert.deepEqual(await invoke(DESKTOP_IPC.listProjectDir, folder, 'nested'), [{ name: 'note.md', dir: false }]);

  // A file of its tree opens by (folder, relative path), no token.
  const [file] = await link(join(folder, 'nested', 'note.md'));
  assert.equal(file.accessToken, undefined);
  assert.equal(file.projectPath, join(folder, 'nested'));
  const read = await invoke(DESKTOP_IPC.readProjectFile, file.projectPath, file.relPath);
  assert.equal(read.content, '# note\n');
  await invoke(DESKTOP_IPC.statProjectFile, file.projectPath, file.relPath);
  await invoke(
    DESKTOP_IPC.writeProjectFile,
    file.projectPath,
    file.relPath,
    '# edited\n',
    read.content,
    undefined,
    read.encoding
  );
  assert.equal((await invoke(DESKTOP_IPC.readProjectFile, folder, 'nested/note.md')).content, '# edited\n');

  // Creating, renaming, moving, copying and trashing go through the same root.
  await invoke(DESKTOP_IPC.createProjectEntry, folder, '', 'made', true);
  await invoke(DESKTOP_IPC.createProjectEntry, folder, 'made', 'a.txt', false);
  await invoke(DESKTOP_IPC.renameProjectEntry, folder, 'made/a.txt', 'b.txt');
  await invoke(DESKTOP_IPC.moveProjectEntry, folder, 'made/b.txt', 'nested');
  const copied = await invoke(DESKTOP_IPC.copyProjectEntry, folder, 'nested/b.txt', 'made');
  assert.equal(copied.name, 'b.txt');
  assert.deepEqual(
    (await invoke(DESKTOP_IPC.listProjectDir, folder, 'nested')).map((entry) => entry.name),
    ['b.txt', 'note.md']
  );
  await invoke(DESKTOP_IPC.trashProjectEntry, folder, 'made/b.txt');
  assert.deepEqual(f.trashed, [join(folder, 'made', 'b.txt')]);
  // A root is a boundary: traversal out of it, and a missing folder, are refused.
  await assert.rejects(async () => invoke(DESKTOP_IPC.renameProjectEntry, folder, '../secret.txt', 'y.txt'));
  await assert.rejects(async () => invoke(DESKTOP_IPC.readProjectFile, folder, '../secret.txt'), /outside the project/);
  await assert.rejects(
    async () => invoke(DESKTOP_IPC.listProjectDir, join(f.directory, 'missing'), ''),
    /not available/
  );
});

test('an outside HTML page loads its relative assets like a Project page', async (t) => {
  const f = await fixture(t);
  const folder = join(f.directory, 'site');
  await mkdir(folder);
  await writeFile(join(folder, 'index.html'), '<link rel="stylesheet" href="app.css">');
  await writeFile(join(folder, 'app.css'), 'p{}');
  const invoke = (channel, ...args) => f.handlers.get(channel)(f.event, ...args);
  const [entry] = await invoke(DESKTOP_IPC.resolveLocalPaths, [join(folder, 'index.html')], 's1', { chatLink: true });
  assert.equal(entry.accessToken, undefined);
  const url = await invoke(DESKTOP_IPC.localPageUrl, entry.projectPath, entry.relPath);
  const status = (name) => fetch(new URL(name, url)).then((response) => response.status);
  assert.equal(await status('index.html'), 200);
  assert.equal(await status('app.css'), 200);
});

test('chat links to any number of outside files take no grant and nothing is persisted', async (t) => {
  const f = await fixture(t);
  const invoke = (channel, ...args) => f.handlers.get(channel)(f.event, ...args);
  const names = Array.from({ length: 120 }, (_, index) => join(f.directory, `f-${index}.txt`));
  await Promise.all(names.map((name) => writeFile(name, 'x')));
  const [first] = await invoke(DESKTOP_IPC.resolveLocalPaths, [names[0]], 's1', { chatLink: true });
  for (const name of names) await invoke(DESKTOP_IPC.resolveLocalPaths, [name], 's1', { chatLink: true });
  // However many links were described, the first still reads with no token.
  assert.equal((await invoke(DESKTOP_IPC.readProjectFile, first.projectPath, first.relPath)).content, 'x');
  assert.equal(first.accessToken, undefined);
});

test('file IPC carries a structured refusal code through the envelope Electron would otherwise strip', async (t) => {
  const f = await fixture(t);
  const file = join(f.directory, 'external.ts');
  await writeFile(file, 'export const value = 1;\n');
  const invoke = (channel, ...args) => f.handlers.get(channel)(f.event, ...args);
  const [target] = await invoke(DESKTOP_IPC.resolveLocalPaths, [file]);
  // A held token the main process no longer grants: the refusal arrives as an envelope with its code.
  const gone = ipcErrorFromEnvelope(
    await invoke(DESKTOP_IPC.readProjectFile, target.projectPath, target.relPath, 'dropped-token')
  );
  assert.equal(gone.code, 'SELECTED_FILE_GRANT_UNAVAILABLE');
  assert.equal(gone.message, 'The selected-file permission is unavailable.');
  // The same wrapper covers open and reveal, and a filesystem fault keeps its errno code.
  for (const channel of [DESKTOP_IPC.openFilePath, DESKTOP_IPC.revealFile]) {
    const refused = ipcErrorFromEnvelope(await invoke(channel, target.projectPath, target.relPath, 'dropped-token'));
    assert.equal(refused?.code, 'SELECTED_FILE_GRANT_UNAVAILABLE', channel);
  }
  await rm(file);
  const missing = ipcErrorFromEnvelope(
    await invoke(DESKTOP_IPC.readProjectFile, target.projectPath, target.relPath, target.accessToken)
  );
  assert.equal(missing.code, 'ENOENT');
  // A refusal without a structured code still rejects as before.
  await assert.rejects(
    invoke(DESKTOP_IPC.readProjectFile, target.projectPath, 'other.ts', target.accessToken),
    /does not match/
  );
});

test('external selected executables need the same confirmation through editor IPC', async (t) => {
  const f = await fixture(t);
  const file = join(f.directory, 'external.exe');
  await writeFile(file, 'sample');
  const [target] = await f.handlers.get(DESKTOP_IPC.resolveLocalPaths)(f.event, [file]);
  const open = (confirmedPath) =>
    f.handlers.get(DESKTOP_IPC.openFilePath)(
      f.event,
      target.projectPath,
      target.relPath,
      target.accessToken,
      confirmedPath
    );
  const canonical = await realpath(file);
  assert.deepEqual(await open(), { confirmationPath: canonical });
  assert.deepEqual(f.opened, []);
  await open(canonical);
  assert.deepEqual(f.opened, [canonical]);
});
