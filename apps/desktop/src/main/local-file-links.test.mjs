import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DESKTOP_IPC } from '../shared/contract';
import { ipcErrorFromEnvelope } from '../shared/coded-error';
import { registerDesktopIpc } from './ipc';
import * as projectFiles from './project-files';

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
  let failure = '';
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
      invokeDesktopOperation: async (method, args) => projectFiles[method](...args),
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
          return failure;
        },
        openExternal: async () => {},
        showItemInFolder: (file) => revealed.push(file),
        trashItem: async (file) => trashed.push(file),
      },
    }
  );
  t.after(remove);
  const event = { sender: webContents, senderFrame: mainFrame };
  const handler = handlers.get(DESKTOP_IPC.openLocalFileLink);
  assert.equal(typeof handler, 'function');
  return {
    directory,
    project,
    opened,
    revealed,
    trashed,
    handler,
    event,
    handlers,
    invoke: (href, root = project, confirmedPath) => handler(event, root, href, confirmedPath),
    fail: (message) => {
      failure = message;
    },
  };
}

test('chat file IPC opens relative, absolute and file URLs with decoded document names', async (t) => {
  const f = await fixture(t);
  const names = ['제안서 100% #1.tiff', 'scan.TIF', 'archive file.zip'];
  for (const name of names) {
    const file = join(f.project, 'output', name);
    await writeFile(file, 'sample');
    const canonical = await realpath(file);
    for (const href of [
      `output/${encodeURIComponent(name)}`,
      pathToFileURL(file).href,
      file.replace(/\\/g, '/').replace(/%/g, '%25').replace(/#/g, '%23'),
    ]) {
      assert.equal(await f.invoke(href), 'file');
      assert.equal(f.opened.at(-1), canonical);
    }
  }
  await f.invoke('output%5Cscan.TIF');
  assert.equal(f.opened.at(-1), await realpath(join(f.project, 'output', 'scan.TIF')));
});

test('chat links to images, SVG, PDF, media and Office documents open in the editor with zero OS launches', async (t) => {
  const f = await fixture(t);
  const names = [
    '제안서 100% #1.pptx',
    'preview.pdf',
    'verification-summary.docx',
    '도표 #1.svg',
    'Chart.SVG',
    'shot.png',
    'song.mp3',
    'clip.mp4',
    'sheet.xlsx',
    'Legacy.DOC',
  ];
  for (const name of names) {
    const file = join(f.project, 'output', name);
    await writeFile(file, 'sample');
    for (const href of [
      `output/${encodeURIComponent(name)}`,
      pathToFileURL(file).href,
      file.replace(/\\/g, '/').replace(/%/g, '%25').replace(/#/g, '%23'),
    ]) {
      assert.equal(await f.invoke(href), 'editor', name);
    }
  }
  assert.equal(await f.invoke('./output/preview.pdf?download=1#page=2'), 'editor');
  assert.deepEqual(f.opened, []);
});

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
  assert.equal(await f.invoke(target.relPath, target.projectPath), 'editor');
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
  await assert.rejects(async () => invoke(DESKTOP_IPC.listProjectDir, join(f.directory, 'missing'), ''), /not available/);
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

test('chat file IPC rejects traversal, network paths, schemes and malformed paths before launch', async (t) => {
  const f = await fixture(t);
  const outside = join(f.directory, 'outside.pdf');
  await writeFile(outside, 'outside');
  for (const href of [
    '../outside.pdf',
    '%2e%2e%2foutside.pdf',
    outside,
    pathToFileURL(outside).href,
    '//server/share/document.pdf',
    '\\\\server\\share\\document.pdf',
    'file://server/share/document.pdf',
    'https://example.com/document.pdf',
    'javascript:alert(1)',
    'data:text/plain,hello',
    'C:relative.pdf',
    'output/preview.pdf:run.exe',
    'output/%00.pdf',
    'output/%FF.pdf',
    '',
    42,
  ]) {
    await assert.rejects(async () => f.invoke(href), undefined, String(href));
  }
  await assert.rejects(async () => f.invoke('output/preview.pdf', ''), /project directory/);
  assert.equal(f.opened.length, 0);
});

test('chat file IPC requires confirmation for executables and installers but not archives', async (t) => {
  const f = await fixture(t);
  for (const name of ['setup.exe', 'installer.msi', 'archive.zip', 'disk.iso']) {
    const file = join(f.project, 'output', name);
    await writeFile(file, 'sample');
    const canonical = await realpath(file);
    if (name.endsWith('.exe') || name.endsWith('.msi')) {
      const before = f.opened.length;
      assert.deepEqual(await f.invoke(`output/${name}`), { confirmationPath: canonical });
      assert.equal(f.opened.length, before, 'a request alone never launches');
      assert.deepEqual(await f.invoke(`output/${name}`, f.project, 'wrong-path'), { confirmationPath: canonical });
      assert.equal(await f.invoke(`output/${name}`, f.project, canonical), 'file');
    } else {
      assert.equal(await f.invoke(`output/${name}`), 'file', name);
    }
    assert.equal(f.opened.at(-1), await realpath(file), name);
  }
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

test('application directories request confirmation instead of launching as ordinary folders', async (t) => {
  const f = await fixture(t);
  const app = join(f.project, 'Tool.app');
  await mkdir(app);
  const canonical = await realpath(app);
  assert.deepEqual(await f.invoke('Tool.app'), { confirmationPath: canonical });
  assert.deepEqual(f.opened, []);
  assert.equal(await f.invoke('Tool.app', f.project, canonical), 'folder');
  assert.deepEqual(f.opened, [canonical]);
});

test('chat file IPC never launches scripts, shortcuts, macro-enabled or text files; it hands them to the editor', async (t) => {
  const f = await fixture(t);
  for (const name of ['cmd', 'bat', 'ps1', 'js', 'vbs', 'lnk', 'url', 'appref-ms', 'scf', 'pptm', 'md', 'json', 'ts']
    .map((extension) => `output/payload.${extension}`)
    .concat('output/Dockerfile')) {
    await writeFile(join(f.project, name), 'untrusted');
    assert.equal(await f.invoke(name), 'editor', name);
  }
  await assert.rejects(f.invoke('output/preview.pdf'), /^Error: The file no longer exists: output\/preview\.pdf$/);
  await writeFile(join(f.project, 'output', 'preview.pdf'), 'sample');
  assert.equal(await f.invoke('output/preview.pdf'), 'editor');
  assert.deepEqual(f.opened, []);
});

test('chat file IPC opens folders in the file manager, with or without a trailing separator', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.project, 'output', 'report 2026'));
  assert.equal(await f.invoke('output/report%202026/'), 'folder');
  assert.equal(await f.invoke('output/report 2026'), 'folder');
  assert.equal(await f.invoke('./'), 'folder');
  assert.deepEqual(f.opened, [
    await realpath(join(f.project, 'output', 'report 2026')),
    await realpath(join(f.project, 'output', 'report 2026')),
    await realpath(f.project),
  ]);
  await assert.rejects(f.invoke('../'), /escapes the project/);
});

test('chat file IPC cannot escape through a directory junction or symbolic link', async (t) => {
  const f = await fixture(t);
  const outside = join(f.directory, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.pdf'), 'outside');
  await symlink(outside, join(f.project, 'output', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.invoke('output/linked/secret.pdf'), /escapes the project/);
  assert.equal(f.opened.length, 0);
});

test('chat file IPC propagates default-app failures and rejects foreign senders', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'output', 'preview.zip'), 'sample');
  f.fail('No application is associated with this file.');
  await assert.rejects(f.invoke('output/preview.zip'), /No application is associated/);
  assert.throws(() => f.handler({ ...f.event, sender: {} }, f.project, 'output/preview.zip'), /rejected/);
  assert.throws(() => f.handler({ ...f.event, senderFrame: {} }, f.project, 'output/preview.zip'), /rejected/);
  assert.equal(f.opened.length, 1);
});
