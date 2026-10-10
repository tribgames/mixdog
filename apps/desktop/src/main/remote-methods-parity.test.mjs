import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRemoteMethods, executeRemoteFrame } from './remote-methods.ts';

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
