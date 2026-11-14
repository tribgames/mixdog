// createFilesApi against a fake client: the core requests of each key are what main sent for the same IPC call
// (ipc-projects.ts, ipc-project-files.ts, ipc-file-dialogs.ts through the service and operation lanes).
import assert from 'node:assert/strict';
import test from 'node:test';

import { DIRECT_KEYS } from '../../shared/desktop-api-split.ts';
import { createFilesApi } from './api-files.ts';
import { createDirectContext } from './context.ts';
import { createRendererConnection } from './renderer-connection.ts';

const refused = Object.assign(new Error('refused'), { name: 'ClientError', detail: { kind: 'rpc', data: { reason: 'permissionDenied' } } });

function fakeClient(answer) {
  const calls = [];
  const listeners = new Set();
  const client = {
    calls,
    status: { state: 'ready' },
    server: { limits: {} },
    store: { sections: () => [], section: () => undefined, appFeed: () => ({ epoch: 'e1' }), subscribe: () => () => undefined },
    async call(method, params) {
      calls.push({ method, params });
      return answer(method, params, client);
    },
    notify: () => undefined,
    subscribeApp: async () => undefined,
    resumeThread: async () => ({}),
    unsubscribeThread: async () => undefined,
    respond: () => undefined,
    pendingServerRequests: () => [],
    on: (l) => (listeners.add(l), () => listeners.delete(l)),
    close: async () => undefined,
    emit: (event) => listeners.forEach((l) => l(event)),
  };
  return client;
}

const defaults = (method, params) => {
  if (method === 'project/directory') return { path: params.standalone ? params.path : `F:/${params.path}`, standalone: params.standalone === true };
  if (method === 'project/recoveryDirectory') return { path: `F:/recovery/${params.path}` };
  return {};
};

async function world(answer = defaults, role) {
  const client = fakeClient(answer);
  const connection = createRendererConnection({ open: async () => client });
  await connection.start();
  const ctx = createDirectContext(connection);
  if (role) ctx.window = () => ({ role });
  return { client, api: createFilesApi(ctx), sent: () => client.calls.map((c) => [c.method, c.params]) };
}

test('every key of the group is implemented', async () => {
  const { api } = await world();
  for (const key of DIRECT_KEYS.files) assert.equal(typeof api[key], 'function', key);
  assert.equal(Object.keys(api).length, DIRECT_KEYS.files.length);
});

test('project list and lifecycle', async () => {
  const { api, sent } = await world((method) => (method === 'project/list' ? { projects: [{ name: 'a', path: 'P', alias: null, hidden: false }] } : {}));
  assert.deepEqual(await api.listProjects(), [{ name: 'a', path: 'P', alias: null }]);
  await api.addProject('C:/a');
  await api.renameProject('C:/a', 'A');
  await api.removeProject('C:/a');
  const methods = sent().map(([m]) => m);
  assert.deepEqual(methods.slice(0, 2), ['project/list', 'project/create']);
  assert.ok(methods.includes('project/update') && methods.includes('project/delete'));
  assert.deepEqual(sent()[1][1], { path: 'C:/a' });
  assert.deepEqual(sent().find(([m]) => m === 'project/update')[1], { path: 'C:/a', alias: 'A' });
});

test('start calls compose the blank snapshot', async () => {
  const { api, sent } = await world((method, params) => {
    if (method === 'project/taskWorkspace') return { path: 'T' };
    if (method === 'project/create') return { project: { path: params.path } };
    return {};
  });
  assert.equal((await api.startTask()).cwd, 'T');
  assert.equal((await api.startProject('C:/p')).currentProject, 'C:/p');
  assert.deepEqual(sent().map(([m]) => m), ['project/taskWorkspace', 'project/create', 'project/touch']);
});

test('file calls resolve the project folder first', async () => {
  const { api, sent } = await world();
  await api.listProjectDir('proj', 'src');
  await api.readProjectFile('proj', 'a.txt');
  await api.writeProjectFile('proj', 'a.txt', 'new', 'old', undefined, 'utf8');
  await api.statProjectFile('proj', 'a.txt');
  await api.createProjectEntry('proj', '', 'n', true);
  await api.renameProjectEntry('proj', 'a', 'b');
  await api.moveProjectEntry('proj', 'a', 'd');
  await api.copyProjectEntry('proj', 'a', 'd');
  await api.codeGraphQuery('proj', 'symbols', 'x');
  const calls = sent().filter(([m]) => m !== 'project/directory');
  assert.deepEqual(calls, [
    ['projectFs/listDir', { root: 'F:/proj', rel: 'src' }],
    ['projectFs/readText', { root: 'F:/proj', rel: 'a.txt' }],
    ['projectFs/writeText', { root: 'F:/proj', rel: 'a.txt', content: 'new', expectedContent: 'old', encoding: 'utf8' }],
    ['projectFs/stat', { root: 'F:/proj', rel: 'a.txt' }],
    ['projectFs/create', { root: 'F:/proj', relDir: '', name: 'n', directory: true }],
    ['projectFs/rename', { root: 'F:/proj', rel: 'a', newName: 'b' }],
    ['projectFs/move', { root: 'F:/proj', rel: 'a', targetDirRel: 'd' }],
    ['projectFs/copy', { root: 'F:/proj', rel: 'a', targetDirRel: 'd' }],
    ['project/codeGraph', { path: 'F:/proj', mode: 'symbols', query: 'x' }],
  ]);
});

test('a one-file token goes to the core with the project path', async () => {
  const { api, sent } = await world();
  await api.readProjectFile('C:/outside', 'a.txt', 'tok');
  await api.writeProjectFile('C:/outside', 'a.txt', 'n', 'o', 'tok');
  await api.statProjectFile('C:/outside', 'a.txt', 'tok');
  await api.captureFileSnapshot('C:/outside', 'a.txt', 'tok');
  assert.deepEqual(sent(), [
    ['projectFs/readText', { root: 'C:/outside', rel: 'a.txt', accessToken: 'tok' }],
    ['projectFs/writeText', { root: 'C:/outside', rel: 'a.txt', content: 'n', expectedContent: 'o', accessToken: 'tok' }],
    ['projectFs/stat', { root: 'C:/outside', rel: 'a.txt', accessToken: 'tok' }],
    ['projectFs/captureSnapshot', { root: 'C:/outside', rel: 'a.txt', accessToken: 'tok' }],
  ]);
});

test('a path that is no Project answers as its own folder', async () => {
  const { api, sent } = await world((method, params) => {
    if (method === 'project/directory' && !params.standalone) throw refused;
    return defaults(method, params);
  });
  await api.listProjectDir('C:/loose', '');
  assert.deepEqual(sent().map(([m]) => m), ['project/directory', 'project/directory', 'projectFs/listDir']);
  assert.deepEqual(sent()[1][1], { path: 'C:/loose', standalone: true });
  assert.deepEqual(sent()[2][1], { root: 'C:/loose', rel: '' });
});

test('a relative path or a server window gets no standalone folder', async () => {
  const refuse = (method, params) => {
    if (method === 'project/directory') throw refused;
    return defaults(method, params);
  };
  const local = await world(refuse);
  await assert.rejects(local.api.listProjectDir('relative', ''));
  assert.equal(local.sent().length, 1);
  const server = await world(refuse, 'server:s1');
  await assert.rejects(server.api.listProjectDir('C:/loose', ''));
  assert.equal(server.sent().length, 1);
});

test('trash: this PC through the window, a server window by its own trash', async () => {
  const local = await world();
  await local.api.trashProjectEntry('proj', 'a');
  assert.deepEqual(local.sent().at(-1), ['projectFs/trash', { root: 'F:/proj', rel: 'a', viaHost: true }]);
  const server = await world(defaults, 'server:s1');
  await server.api.trashProjectEntry('proj', 'a', { permanent: true });
  assert.deepEqual(server.sent().at(-1), ['transfer/trash/entry', { path: 'F:/proj', rel: 'a', permanent: true }]);
  await assert.rejects(server.api.captureFileSnapshot('proj', 'a'), /not available for server files/);
});

test('workspace search, replace, editor settings and recovery', async () => {
  const { api, sent } = await world();
  await api.searchWorkspaceText('proj', { query: 'q' });
  await api.replaceWorkspaceText('proj', { query: 'q' }, 'r', ['a']);
  await api.readEditorSettings('proj', 'a.ts', ' ');
  await api.projectRecovery('proj', { action: 'restore', id: '1', revision: '2' });
  const calls = sent().filter(([m]) => m !== 'project/directory' && m !== 'project/recoveryDirectory');
  assert.deepEqual(calls, [
    ['projectFs/searchText', { root: 'F:/proj', options: { query: 'q' } }],
    ['projectFs/replaceText', { root: 'F:/proj', options: { query: 'q' }, replacement: 'r', relPaths: ['a'] }],
    ['projectFs/readEditorSettings', { root: 'F:/proj', rel: 'a.ts' }],
    ['projectFs/recovery', { root: 'F:/recovery/proj', action: 'restore', id: '1', revision: '2' }],
  ]);
});

test('editor backups name the entry path', async () => {
  const { api, sent } = await world((method, params) => (method === 'projectFs/entryPath' ? { path: 'F:/proj/a.txt' } : defaults(method, params)));
  await api.readEditorBackup('proj', 'a.txt');
  await api.writeEditorBackup('proj', 'a.txt', 'c', 'e');
  await api.deleteEditorBackup('proj', 'a.txt', 'tok');
  const calls = sent().filter(([m]) => m !== 'project/directory');
  assert.deepEqual(calls, [
    ['projectFs/entryPath', { root: 'F:/proj', rel: 'a.txt' }],
    ['projectFs/backup/read', { sourcePath: 'F:/proj/a.txt' }],
    ['projectFs/entryPath', { root: 'F:/proj', rel: 'a.txt' }],
    ['projectFs/backup/write', { sourcePath: 'F:/proj/a.txt', content: 'c', expectedContent: 'e' }],
    ['projectFs/entryPath', { root: 'proj', rel: 'a.txt', accessToken: 'tok' }],
    ['projectFs/backup/delete', { sourcePath: 'F:/proj/a.txt' }],
  ]);
});

test('search keeps one session per window for the @ palette', async () => {
  const { api, sent } = await world((method, _params, client) => {
    if (method === 'search/update') {
      queueMicrotask(() =>
        client.emit({ type: 'notification', notification: { method: 'search/completed', params: { sessionId: 'search:mention', query: 'q' } } })
      );
    }
    return {};
  });
  assert.deepEqual(await api.searchProjectFiles('proj', 'q', undefined, false, true), []);
  assert.equal(sent()[0][0], 'search/start');
  assert.deepEqual(sent()[0][1], { sessionId: 'search:mention', roots: ['proj'], limit: 50, includeIgnored: false, includeDirectories: true, consumer: 'mention' });
});

test('lsp, local file, star, office and feedback', async () => {
  const { api, sent } = await world();
  const doc = { kind: 'open', projectPath: 'proj', relPath: 'a.ts', languageId: 'typescript', version: 1 };
  await api.lspDocument(doc);
  await api.lspRequest({ projectPath: 'proj', relPath: 'a.ts', languageId: 'typescript', method: 'textDocument/hover' });
  await api.lspApplyWorkspaceEdit('proj', [{ relPath: 'a.ts', content: 'x', expectedContent: 'y' }]);
  await api.readLocalFile('C:/x.png');
  await api.githubStarStatus();
  await api.libreOfficeStatus(true);
  await api.submitFeedback({ id: 'i' });
  const calls = sent().filter(([m]) => m !== 'project/directory' && m !== 'feed/subscribe');
  assert.deepEqual(calls, [
    ['lsp/document', { projectPath: 'proj', root: 'F:/proj', document: doc }],
    ['lsp/request', { projectPath: 'proj', root: 'F:/proj', request: { relPath: 'a.ts', languageId: 'typescript', method: 'textDocument/hover', params: {} } }],
    ['projectFs/writeTextBatch', { root: 'F:/proj', files: [{ relPath: 'a.ts', content: 'x', expectedContent: 'y' }] }],
    ['projectFs/readLocal', { path: 'C:/x.png' }],
    ['github/starStatus', {}],
    ['document/libreOfficeStatus', { refresh: true }],
    ['feedback/upload', { input: { id: 'i' } }],
  ]);
});

test('folder watch events and lsp feed events reach their listeners', async () => {
  const { api, client } = await world();
  const dirs = [];
  const off = api.subscribeFolderChanges((dir) => dirs.push(dir));
  await api.folderWatch('C:/w', true);
  const watch = client.calls.find((c) => c.method === 'fs/watch');
  assert.equal(watch.params.path, 'C:/w');
  client.emit({ type: 'notification', notification: { method: 'fs/changed', params: { watchId: watch.params.watchId, changedPaths: ['C:/w/a'] } } });
  assert.deepEqual(dirs, ['C:/w']);
  off();
  const diagnostics = [];
  api.subscribeLspDiagnostics((event) => diagnostics.push(event));
  await api.lspDocument({ kind: 'open', projectPath: 'proj', relPath: 'a.ts', languageId: 'typescript', version: 1 });
  await new Promise((r) => setImmediate(r));
  assert.ok(client.calls.some((c) => c.method === 'feed/subscribe' && c.params.feedId === 'lsp:proj'));
  const event = { projectPath: 'proj', relPath: 'a.ts', uri: 'u', server: 's', diagnostics: [] };
  client.emit({
    type: 'notification',
    notification: { method: 'lsp/diagnostics/updated', feed: { id: 'lsp:proj' }, params: { section: 'lspDiagnostics', key: 'u', revision: 1, value: event } },
  });
  assert.deepEqual(diagnostics, [event]);
});

test('a core refusal comes out as the IPC path returned it', async () => {
  const bad = Object.assign(new Error('x'), { detail: { kind: 'rpc', data: { reason: 'invalidParams', expected: 'limit is invalid.' } } });
  const { api } = await world(() => {
    throw bad;
  });
  await assert.rejects(api.listProjects(), (e) => e instanceof TypeError && e.message === 'limit is invalid.');
});
