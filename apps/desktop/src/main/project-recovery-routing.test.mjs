import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { registerProjectFileIpc } from './ipc-project-files.ts';
import { createRemoteMethods, executeRemoteFrame } from './remote-methods.ts';
import { createDesktopOperations } from './desktop-operations.ts';

for (const transport of ['ipc', 'remote']) {
  test(`${transport} recovery resolves the registry root and uses only host-owned storage`, async (t) => {
    const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'mixdog-recovery-route-')));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const root = join(base, 'project'),
      data = join(base, 'host-data'),
      injected = join(base, 'client-data');
    await fs.mkdir(root);
    await fs.mkdir(data);
    await fs.mkdir(injected);
    await fs.writeFile(join(root, 'a.txt'), 'A0');
    await fs.writeFile(join(root, 'b.txt'), 'B0');
    const scopes = [], events = [];
    const operations = createDesktopOperations({ userDataPath: data, emit(event) { events.push(event); },
      withRecoveryStore: async (root, action, run) => { scopes.push([root, action]); return run(); },
    });
    t.after(() => operations.dispose());
    const host = {
      projectDirectory: async (project) => {
        if (project !== 'registered-project') throw new Error('Unknown project');
        return root;
      },
      invokeDesktopOperation: (name, args) => operations.invoke(name, args),
    };
    let invoke;
    if (transport === 'ipc') {
      const handlers = new Map();
      registerProjectFileIpc({
        app: {},
        handle: (name, fn) => handlers.set(name, fn),
        host,
        invokeDesktopOperation: host.invokeDesktopOperation,
        shell: {},
        grantedFile: async () => {
          throw new Error('no grant');
        },
      });
      invoke = (name, ...args) => handlers.get(DESKTOP_IPC[name])({}, ...args);
    } else {
      const methods = createRemoteMethods({ host, userDataPath: injected });
      invoke = async (name, ...args) => {
        const reply = await executeRemoteFrame(methods, JSON.stringify({ id: 1, method: name, params: args }));
        if (!reply.ok) throw new Error(reply.error);
        return reply.value;
      };
    }
    await assert.rejects(invoke('projectRecovery', 'unregistered', { action: 'list' }), /Unknown project/);
    await assert.rejects(
      invoke('projectRecovery', 'registered-project', { action: 'inspect', id: '../escape' }),
      /Invalid recovery ID/
    );
    const rename = fs.rename;
    const mock = t.mock.method(fs, 'rename', (from, to) => {
      if (to === join(root, 'b.txt')) throw new Error('second save denied');
      return rename(from, to);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        invoke('lspApplyWorkspaceEdit', 'registered-project', [
          { relPath: 'a.txt', expectedContent: 'A0', content: 'A1' },
          { relPath: 'b.txt', expectedContent: 'B0', content: 'B1' },
        ])
      );
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(await fs.readdir(injected), [], 'a client data path never owns the journal');
    const { records } = await invoke('projectRecovery', 'registered-project', {
      action: 'list',
      userDataPath: injected,
    });
    assert.equal(records.length, 1);
    const { detail } = await invoke('projectRecovery', 'registered-project', { action: 'inspect', id: records[0].id });
    assert.deepEqual(
      detail.files.map((f) => f.status),
      ['restored', 'original']
    );
    await invoke('projectRecovery', 'registered-project', {
      action: 'discard',
      id: detail.id,
      revision: detail.revision,
    });
    assert.deepEqual((await invoke('projectRecovery', 'registered-project', { action: 'list' })).records, []);
    assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'A0');
    // The other production batch entry point uses the same host-owned journal.
    const searchMock = t.mock.method(fs, 'rename', (from, to) => {
      if (to === join(root, 'b.txt')) throw new Error('search batch denied');
      return rename(from, to);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        operations.invoke('replaceWorkspaceTextIn', [
          root,
          { query: '0', regex: false, matchCase: true, wholeWord: false },
          '1',
          undefined,
          injected,
        ])
      );
    } finally {
      searchMock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal((await invoke('projectRecovery', 'registered-project', { action: 'list' })).records.length, 1);
    assert.deepEqual(await fs.readdir(injected), []);
    assert.equal(scopes.filter(([, action]) => action === 'write').length, 2);
    assert.ok(scopes.some(([path, action]) => path === root && action === 'discard'));
    assert.ok(scopes.every(([path]) => path === root));
    assert.equal(events.filter((event) => event.name === 'folder-changed' && event.value === root).length, 3);
  });
}
