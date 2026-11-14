import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';
import { registerProjectFileIpc } from './ipc-project-files.ts';
import { createCoreLocalPages, setCoreLocalPages } from './core-local-pages.ts';
import { LocalAccessDeniedError } from './local-access-denied.ts';
import { DESKTOP_IPC } from '../shared/contract';

// The real registrar against a fake desktop-operation invoke: the core is the
// only place pages are minted, so what is checked here is what the main process
// asks it for (the root, the token, the owner) and what it refuses on its own.
const ROOT = resolve('/work/proj');
const FOLDER = resolve('/loose/folder');

function owner() {
  const sender = new EventEmitter();
  sender.id = 7;
  sender.closed = false;
  sender.isDestroyed = () => sender.closed;
  sender.close = () => {
    sender.closed = true;
    sender.emit('destroyed');
  };
  return sender;
}

function harness(t, { server = null, standalone = null } = {}) {
  const handlers = new Map();
  const calls = [];
  const hostCalls = [];
  const invoke = async (name, args) => {
    calls.push([name, args]);
    if (name === 'standaloneRoot') return standalone && args[0] === standalone ? standalone : null;
    if (name === 'localPageUrlIn') return `http://127.0.0.1:1/p/${args[1]}`;
    if (name === 'localPageRevokeOwner') return undefined;
    return undefined;
  };
  setCoreLocalPages(createCoreLocalPages(invoke));
  t.after(() => setCoreLocalPages(null));
  registerProjectFileIpc({
    app: {},
    shell: {},
    server,
    handle: (name, run) => handlers.set(name, run),
    invokeDesktopOperation: invoke,
    host: {
      async projectDirectory(path) {
        hostCalls.push(path);
        if (path !== ROOT) throw new LocalAccessDeniedError('project is not registered');
        return ROOT;
      },
    },
    async grantedFile() {
      throw new Error('the core redeems a file token, not the main process');
    },
  });
  return {
    calls,
    hostCalls,
    run: (name, sender, ...args) => handlers.get(name)({ sender }, ...args),
    pageCalls: () => calls.filter(([name]) => name === 'localPageUrlIn'),
  };
}

test('a Project page is asked of the core with the Project root and the window as owner', async (t) => {
  const h = harness(t);
  const sender = owner();
  const url = await h.run(DESKTOP_IPC.localPageUrl, sender, ROOT, 'page.html');
  assert.equal(url, 'http://127.0.0.1:1/p/page.html');
  assert.deepEqual(h.pageCalls(), [['localPageUrlIn', [ROOT, 'page.html', undefined, 'wc:7']]]);
});

test('a file token goes to the core with the path the renderer named, never a broader root', async (t) => {
  const h = harness(t);
  await h.run(DESKTOP_IPC.localPageUrl, owner(), ROOT, 'page.html', 'selected-secret-token');
  assert.deepEqual(h.pageCalls(), [['localPageUrlIn', [ROOT, 'page.html', 'selected-secret-token', 'wc:7']]]);
  assert.equal(h.hostCalls.length, 0, 'a token must not ask for project authority');
});

test('an empty token is no grant', async (t) => {
  const h = harness(t);
  await h.run(DESKTOP_IPC.localPageUrl, owner(), ROOT, 'page.html', '');
  assert.equal(h.pageCalls()[0][1][2], undefined);
});

test('a folder outside every Project is its own root, with no token', async (t) => {
  const h = harness(t, { standalone: FOLDER });
  await h.run(DESKTOP_IPC.localPageUrl, owner(), FOLDER, 'index.html');
  assert.deepEqual(h.pageCalls()[0][1].slice(0, 3), [FOLDER, 'index.html', undefined]);
  assert.ok(h.calls.some(([name, args]) => name === 'standaloneRoot' && args[0] === FOLDER));
});

test('a path that is neither a Project nor a folder is refused with the host error', async (t) => {
  const h = harness(t);
  await assert.rejects(h.run(DESKTOP_IPC.localPageUrl, owner(), FOLDER, 'index.html'), LocalAccessDeniedError);
  assert.equal(h.pageCalls().length, 0);
});

test('a server window never treats a folder as a root of this PC', async (t) => {
  const h = harness(t, { server: { previews: {} }, standalone: FOLDER });
  await assert.rejects(h.run(DESKTOP_IPC.localPageUrl, owner(), FOLDER, 'index.html'), LocalAccessDeniedError);
  assert.ok(!h.calls.some(([name]) => name === 'standaloneRoot'));
});

test('a registered Project keeps the host route and never asks the core to classify it', async (t) => {
  const h = harness(t, { standalone: ROOT });
  await h.run(DESKTOP_IPC.localPageUrl, owner(), ROOT, 'page.html');
  assert.ok(!h.calls.some(([name]) => name === 'standaloneRoot'));
});

test('a closed owner gets no URL, and closing one owner revokes only its pages', async (t) => {
  const h = harness(t);
  const first = owner();
  const second = owner();
  second.id = 8;
  await h.run(DESKTOP_IPC.localPageUrl, first, ROOT, 'a.html');
  await h.run(DESKTOP_IPC.localPageUrl, second, ROOT, 'b.html');
  first.close();
  await new Promise((resolve) => setImmediate(resolve));
  const revokes = h.calls.filter(([name]) => name === 'localPageRevokeOwner');
  assert.deepEqual(revokes, [['localPageRevokeOwner', ['wc:7']]]);
  await assert.rejects(h.run(DESKTOP_IPC.localPageUrl, first, ROOT, 'c.html'), LocalAccessDeniedError);
});

test('entry operations in a standalone folder go to the core with the folder as root', async (t) => {
  const h = harness(t, { standalone: FOLDER });
  const sender = owner();
  await h.run(DESKTOP_IPC.listProjectDir, sender, FOLDER, 'sub');
  await h.run(DESKTOP_IPC.createProjectEntry, sender, FOLDER, '', 'a.txt', false);
  await h.run(DESKTOP_IPC.renameProjectEntry, sender, FOLDER, 'a.txt', 'b.txt');
  await h.run(DESKTOP_IPC.moveProjectEntry, sender, FOLDER, 'b.txt', 'sub');
  await h.run(DESKTOP_IPC.copyProjectEntry, sender, FOLDER, 'sub/b.txt', '');
  await h.run(DESKTOP_IPC.trashProjectEntry, sender, FOLDER, 'sub/b.txt');
  const ops = h.calls.filter(([name]) => name !== 'standaloneRoot');
  assert.deepEqual(ops, [
    ['listProjectDirIn', [FOLDER, 'sub']],
    ['createProjectEntryIn', [FOLDER, '', 'a.txt', false]],
    ['renameProjectEntryIn', [FOLDER, 'a.txt', 'b.txt']],
    ['moveProjectEntryIn', [FOLDER, 'b.txt', 'sub']],
    ['copyProjectEntryIn', [FOLDER, 'sub/b.txt', '']],
    ['trashProjectEntryIn', [FOLDER, 'sub/b.txt']],
  ]);
});

test('trash in a Project goes through the core with the Project directory', async (t) => {
  const h = harness(t);
  await h.run(DESKTOP_IPC.trashProjectEntry, owner(), ROOT, 'old.txt');
  assert.deepEqual(h.calls, [['trashProjectEntryIn', [ROOT, 'old.txt']]]);
});
