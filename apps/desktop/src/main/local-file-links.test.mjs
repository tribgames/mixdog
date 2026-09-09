import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DESKTOP_IPC } from '../shared/contract';
import { registerDesktopIpc } from './ipc';

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
  const remove = registerDesktopIpc({ webContents, isDestroyed: () => false }, {
    subscribe: () => () => {},
    subscribeSessionStates: () => () => {},
  }, {
    app: { quit() {} },
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener),
      removeHandler: (channel) => handlers.delete(channel),
      on() {},
      removeListener() {},
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: {
      openPath: async (file) => { opened.push(file); return failure; },
      openExternal: async () => {},
    },
  });
  t.after(remove);
  const event = { sender: webContents, senderFrame: mainFrame };
  const handler = handlers.get(DESKTOP_IPC.openLocalFileLink);
  assert.equal(typeof handler, 'function');
  return {
    directory, project, opened, handler, event,
    invoke: (href, root = project) => handler(event, root, href),
    fail: (message) => { failure = message; },
  };
}

test('chat file IPC opens relative, absolute and file URLs with decoded document names', async (t) => {
  const f = await fixture(t);
  const names = ['제안서 100% #1.pptx', 'preview.pdf', 'verification-summary.md'];
  for (const name of names) {
    const file = join(f.project, 'output', name);
    await writeFile(file, 'sample');
    const canonical = await realpath(file);
    for (const href of [
      `output/${encodeURIComponent(name)}`,
      pathToFileURL(file).href,
      file.replace(/\\/g, '/').replace(/%/g, '%25').replace(/#/g, '%23'),
    ]) {
      await f.invoke(href);
      assert.equal(f.opened.at(-1), canonical);
    }
  }
  await f.invoke('./output/preview.pdf?download=1#page=2');
  assert.equal(f.opened.at(-1), await realpath(join(f.project, 'output', 'preview.pdf')));
  await f.invoke('output%5Cverification-summary.md');
  assert.equal(f.opened.at(-1), await realpath(join(f.project, 'output', names[2])));
});

test('chat file IPC rejects traversal, network paths, schemes and malformed paths before launch', async (t) => {
  const f = await fixture(t);
  const outside = join(f.directory, 'outside.pdf');
  await writeFile(outside, 'outside');
  for (const href of [
    '../outside.pdf', '%2e%2e%2foutside.pdf',
    outside, pathToFileURL(outside).href,
    '//server/share/document.pdf', '\\\\server\\share\\document.pdf',
    'file://server/share/document.pdf', 'https://example.com/document.pdf',
    'javascript:alert(1)', 'data:text/plain,hello',
    'C:relative.pdf', 'output/preview.pdf:run.exe',
    'output/%00.pdf', 'output/%FF.pdf', '', 42,
  ]) {
    await assert.rejects(async () => f.invoke(href), undefined, String(href));
  }
  await assert.rejects(async () => f.invoke('output/preview.pdf', ''), /project directory/);
  assert.equal(f.opened.length, 0);
});

test('chat file IPC blocks executable, shortcut and macro-enabled types plus missing files', async (t) => {
  const f = await fixture(t);
  for (const extension of ['exe', 'cmd', 'bat', 'ps1', 'js', 'vbs', 'lnk', 'url', 'appref-ms', 'scf', 'pptm']) {
    const name = `output/payload.${extension}`;
    await writeFile(join(f.project, name), 'untrusted');
    await assert.rejects(f.invoke(name), /file type/);
  }
  await mkdir(join(f.project, 'output', 'folder.pdf'));
  await assert.rejects(f.invoke('output/folder.pdf'), /non-executable file/);
  await assert.rejects(f.invoke('output/missing.pdf'), /ENOENT/);
  assert.equal(f.opened.length, 0);
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
