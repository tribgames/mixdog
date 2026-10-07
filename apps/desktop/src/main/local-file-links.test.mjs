import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DESKTOP_IPC } from '../shared/contract';
import { registerDesktopIpc } from './ipc';
import * as projectFiles from './project-files';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-file-links-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  await mkdir(join(project, 'output'), { recursive: true });
  const handlers = new Map();
  const mainFrame = {};
  const webContents = { mainFrame, isDestroyed: () => false, send() {} };
  const opened = [];
  let failure = '';
  const remove = registerDesktopIpc(
    { webContents, isDestroyed: () => false },
    {
      subscribe: () => () => {},
      subscribeSessionStates: () => () => {},
      listProjects: async () => [],
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
  const names = ['제안서 100% #1.pptx', 'preview.pdf', 'verification-summary.docx', '도표 #1.svg', 'Chart.SVG'];
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
  await f.invoke('./output/preview.pdf?download=1#page=2');
  assert.equal(f.opened.at(-1), await realpath(join(f.project, 'output', 'preview.pdf')));
  await f.invoke('output%5Cverification-summary.docx');
  assert.equal(f.opened.at(-1), await realpath(join(f.project, 'output', names[2])));
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
      f.event, target.projectPath, target.relPath, target.accessToken, confirmedPath
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
  for (const name of [
    'cmd',
    'bat',
    'ps1',
    'js',
    'vbs',
    'lnk',
    'url',
    'appref-ms',
    'scf',
    'pptm',
    'md',
    'json',
    'ts',
  ]
    .map((extension) => `output/payload.${extension}`)
    .concat('output/Dockerfile')) {
    await writeFile(join(f.project, name), 'untrusted');
    assert.equal(await f.invoke(name), 'editor', name);
  }
  await assert.rejects(f.invoke('output/preview.pdf'), /^Error: The file no longer exists: output\/preview\.pdf$/);
  await writeFile(join(f.project, 'output', 'preview.pdf'), 'sample');
  assert.equal(await f.invoke('output/preview.pdf'), 'file');
  assert.deepEqual(f.opened, [await realpath(join(f.project, 'output', 'preview.pdf'))]);
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
  await writeFile(join(f.project, 'output', 'preview.pdf'), 'sample');
  f.fail('No application is associated with this file.');
  await assert.rejects(f.invoke('output/preview.pdf'), /No application is associated/);
  assert.throws(() => f.handler({ ...f.event, sender: {} }, f.project, 'output/preview.pdf'), /rejected/);
  assert.throws(() => f.handler({ ...f.event, senderFrame: {} }, f.project, 'output/preview.pdf'), /rejected/);
  assert.equal(f.opened.length, 1);
});
