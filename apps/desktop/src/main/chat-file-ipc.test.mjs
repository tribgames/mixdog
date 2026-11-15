import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { DESKTOP_IPC } from '../shared/contract';
import { ipcErrorFromEnvelope } from '../shared/coded-error';
import { registerDesktopIpc } from './ipc';
import * as projectFiles from './project-files';
import { LocalAccessDeniedError } from './local-access-denied';
import { SELECTED_FILE_GRANT_UNAVAILABLE } from '../shared/file-error-codes';

// The core's grant store (grantDescribe / grantRedeem) is answered here by a minimal stand-in: a file outside every
// Project described with grant gets a token; a chat link (grant false) gets none.
function fakeGrants() {
  const granted = new Map();
  return {
    async describe(paths, grant) {
      const rows = [];
      for (const path of paths) {
        const absolutePath = resolve(path);
        const info = await stat(absolutePath);
        const row = { absolutePath, name: basename(absolutePath), dir: info.isDirectory(), size: Number(info.size) || 0 };
        if (!row.dir) {
          row.projectPath = dirname(absolutePath);
          row.relPath = basename(absolutePath);
          if (grant) {
            row.accessToken = randomUUID();
            granted.set(row.accessToken, absolutePath);
          }
        }
        rows.push(row);
      }
      return rows;
    },
    async requireGrant(token, projectPath, relPath) {
      const file = granted.get(token);
      if (!file) throw new LocalAccessDeniedError('The selected-file permission is unavailable.', SELECTED_FILE_GRANT_UNAVAILABLE);
      if (resolve(projectPath, relPath) !== file) throw new LocalAccessDeniedError('The selected-file permission does not match this path.');
      return { root: dirname(file), rel: basename(file), absolute: file };
    },
  };
}

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
  const grants = fakeGrants();
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
