// createFilesApi against a fake client: the core requests of each key are what main sent for the same IPC call
// (ipc-projects.ts, ipc-project-files.ts, ipc-file-dialogs.ts through the service and operation lanes).
import assert from 'node:assert/strict';
import test from 'node:test';

import { DIRECT_KEYS } from '../../shared/desktop-api-split.ts';
import { createFilesApi } from './api-files.ts';
import { sessionLanesOf } from './api-sessions.ts';
import { createDirectContext } from './context.ts';
import { createRendererConnection } from './renderer-connection.ts';

const refused = Object.assign(new Error('refused'), {
  name: 'ClientError',
  detail: { kind: 'rpc', data: { reason: 'permissionDenied' } },
});

function fakeClient(answer) {
  const calls = [];
  const listeners = new Set();
  const client = {
    calls,
    status: { state: 'ready' },
    server: { limits: {} },
    store: {
      sections: () => [],
      section: () => undefined,
      appFeed: () => ({ epoch: 'e1' }),
      subscribe: () => () => undefined,
    },
    async call(method, params) {
      // Every file call of a window asks for `nodeErrors` (see file-errors.test.mjs); the calls below are compared without it.
      const { nodeErrors, ...rest } = params ?? {};
      if (method.startsWith('projectFs/')) assert.equal(nodeErrors, true, `${method} asks for the plain errors`);
      calls.push({ method, params: method.startsWith('projectFs/') ? rest : params });
      return answer(method, params, client);
    },
    notify: () => undefined,
    subscribeApp: async () => undefined,
    resumeThread: async () => ({}),
    unsubscribeThread: async () => undefined,
    respond: () => undefined,
    pendingServerRequests: () => [],
    on: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    close: async () => undefined,
    emit: (event) =>
      listeners.forEach((l) => {
        l(event);
      }),
  };
  return client;
}

const defaults = (method, params) => {
  if (method === 'project/directory')
    return { path: params.standalone ? params.path : `F:/${params.path}`, standalone: params.standalone === true };
  if (method === 'project/recoveryDirectory') return { path: `F:/recovery/${params.path}` };
  return {};
};

async function world(answer = defaults) {
  const client = fakeClient(answer);
  const connection = createRendererConnection({ open: async () => client });
  await connection.start();
  const ctx = createDirectContext(connection);
  return { client, ctx, api: createFilesApi(ctx), sent: () => client.calls.map((c) => [c.method, c.params]) };
}

/** Runs `body` as a server (ssh) window: the preload's connection identity says so. */
async function inServerWindow(body) {
  globalThis.window = { mixdogDesktop: { connection: { id: 's1', kind: 'ssh', name: 'server' } } };
  try {
    await body();
  } finally {
    delete globalThis.window;
  }
}

test('every key of the group is implemented', async () => {
  const { api } = await world();
  for (const key of DIRECT_KEYS.files) assert.equal(typeof api[key], 'function', key);
  assert.equal(Object.keys(api).length, DIRECT_KEYS.files.length);
});

test('project list and lifecycle', async () => {
  const { api, sent } = await world((method) =>
    method === 'project/list' ? { projects: [{ name: 'a', path: 'P', alias: null, hidden: false }] } : {}
  );
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
  assert.deepEqual(
    sent().map(([m]) => m),
    ['project/taskWorkspace', 'project/create', 'project/touch']
  );
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
    ['projectFs/readText', { root: 'F:/proj', rel: 'a.txt', maxChars: 2097152 }],
    [
      'projectFs/writeText',
      { root: 'F:/proj', rel: 'a.txt', content: 'new', expectedContent: 'old', encoding: 'utf8' },
    ],
    ['projectFs/stat', { root: 'F:/proj', rel: 'a.txt' }],
    ['projectFs/create', { root: 'F:/proj', relDir: '', name: 'n', directory: true }],
    ['projectFs/rename', { root: 'F:/proj', rel: 'a', newName: 'b' }],
    ['projectFs/move', { root: 'F:/proj', rel: 'a', targetDirRel: 'd' }],
    ['projectFs/copy', { root: 'F:/proj', rel: 'a', targetDirRel: 'd' }],
    ['project/codeGraph', { path: 'F:/proj', mode: 'symbols', query: 'x' }],
  ]);
});

test('a file larger than one answer is read a window at a time from one read and joined', async () => {
  const windows = [
    { content: 'ab', encoding: 'utf8', readId: 'r1', nextChar: 2 },
    { content: 'cd', encoding: 'utf8', readId: 'r1', nextChar: 4 },
    { content: 'e', encoding: 'utf8' },
  ];
  const { api, sent } = await world((method, params) =>
    method === 'projectFs/readText'
      ? windows[params.fromChar === undefined ? 0 : params.fromChar / 2]
      : defaults(method, params)
  );
  assert.deepEqual(await api.readProjectFile('C:/outside', 'big.txt', 'tok'), { content: 'abcde', encoding: 'utf8' });
  assert.deepEqual(sent(), [
    ['projectFs/readText', { root: 'C:/outside', rel: 'big.txt', accessToken: 'tok', maxChars: 2097152 }],
    [
      'projectFs/readText',
      { root: 'C:/outside', rel: 'big.txt', accessToken: 'tok', readId: 'r1', fromChar: 2, maxChars: 2097152 },
    ],
    [
      'projectFs/readText',
      { root: 'C:/outside', rel: 'big.txt', accessToken: 'tok', readId: 'r1', fromChar: 4, maxChars: 2097152 },
    ],
  ]);
});

test('a one-file token goes to the core with the project path', async () => {
  const { api, sent } = await world();
  await api.readProjectFile('C:/outside', 'a.txt', 'tok');
  await api.writeProjectFile('C:/outside', 'a.txt', 'n', 'o', 'tok');
  await api.statProjectFile('C:/outside', 'a.txt', 'tok');
  await api.captureFileSnapshot('C:/outside', 'a.txt', 'tok');
  assert.deepEqual(sent(), [
    ['projectFs/readText', { root: 'C:/outside', rel: 'a.txt', accessToken: 'tok', maxChars: 2097152 }],
    [
      'projectFs/writeText',
      { root: 'C:/outside', rel: 'a.txt', content: 'n', expectedContent: 'o', accessToken: 'tok' },
    ],
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
  assert.deepEqual(
    sent().map(([m]) => m),
    ['project/directory', 'project/directory', 'projectFs/listDir']
  );
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
  const server = await world(refuse);
  await inServerWindow(async () => {
    await assert.rejects(server.api.listProjectDir('C:/loose', ''));
  });
  assert.equal(server.sent().length, 1);
});

test('trash: this PC through the window, a server window by its own trash', async () => {
  const local = await world();
  await local.api.trashProjectEntry('proj', 'a');
  assert.deepEqual(local.sent().at(-1), ['projectFs/trash', { root: 'F:/proj', rel: 'a', viaHost: true }]);
  const server = await world();
  await inServerWindow(async () => {
    await server.api.trashProjectEntry('proj', 'a', { permanent: true });
    assert.deepEqual(server.sent().at(-1), ['transfer/trash/entry', { path: 'F:/proj', rel: 'a', permanent: true }]);
    await assert.rejects(server.api.captureFileSnapshot('proj', 'a'), /not available for server files/);
  });
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
  const { api, sent } = await world((method, params) =>
    method === 'projectFs/entryPath' ? { path: 'F:/proj/a.txt' } : defaults(method, params)
  );
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

test('each window keeps its own search sessions, the @ palette apart', async () => {
  const completing = (method, params, client) => {
    if (method === 'search/update') {
      queueMicrotask(() =>
        client.emit({
          type: 'notification',
          notification: { method: 'search/completed', params: { sessionId: params.sessionId, query: params.query } },
        })
      );
    }
    return {};
  };
  const one = await world(completing);
  const two = await world(completing);
  assert.deepEqual(await one.api.searchProjectFiles('proj', 'q', undefined, false, true), []);
  assert.deepEqual(await one.api.searchProjectFiles('proj', 'q', 200), []);
  assert.deepEqual(await two.api.searchProjectFiles('proj', 'q', undefined, false, true), []);
  const starts = (w) =>
    w
      .sent()
      .filter(([m]) => m === 'search/start')
      .map(([, p]) => p);
  const [mention, files] = starts(one);
  assert.match(mention.consumer, /^mention:[0-9a-f]{16}$/);
  assert.deepEqual(mention, {
    sessionId: `search:${mention.consumer}`,
    roots: ['proj'],
    limit: 50,
    includeIgnored: false,
    includeDirectories: true,
    consumer: mention.consumer,
  });
  assert.equal(files.consumer, `files:${mention.consumer.slice('mention:'.length)}`);
  assert.deepEqual(files, {
    sessionId: `search:${files.consumer}`,
    roots: ['proj'],
    limit: 200,
    includeIgnored: false,
    includeDirectories: false,
    consumer: files.consumer,
  });
  assert.notEqual(starts(two)[0].sessionId, mention.sessionId);
});

test('lsp, local file, star, office and feedback', async () => {
  const { api, sent } = await world();
  const doc = { kind: 'open', projectPath: 'proj', relPath: 'a.ts', languageId: 'typescript', version: 1 };
  await api.lspDocument(doc);
  await api.lspRequest({
    projectPath: 'proj',
    relPath: 'a.ts',
    languageId: 'typescript',
    method: 'textDocument/hover',
  });
  await api.lspApplyWorkspaceEdit('proj', [{ relPath: 'a.ts', content: 'x', expectedContent: 'y' }]);
  await api.readLocalFile('C:/x.png');
  await api.githubStarStatus();
  await api.libreOfficeStatus(true);
  await api.submitFeedback({ id: 'i' });
  const calls = sent().filter(([m]) => m !== 'project/directory' && m !== 'feed/subscribe');
  assert.deepEqual(calls, [
    ['lsp/document', { projectPath: 'proj', root: 'F:/proj', document: doc }],
    [
      'lsp/request',
      {
        projectPath: 'proj',
        root: 'F:/proj',
        request: { relPath: 'a.ts', languageId: 'typescript', method: 'textDocument/hover', params: {} },
      },
    ],
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
  client.emit({
    type: 'notification',
    notification: { method: 'fs/changed', params: { watchId: watch.params.watchId, changedPaths: ['C:/w/a'] } },
  });
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
    notification: {
      method: 'lsp/diagnostics/updated',
      feed: { id: 'lsp:proj' },
      params: { section: 'lspDiagnostics', key: 'u', revision: 1, value: event },
    },
  });
  assert.deepEqual(diagnostics, [event]);
});

test('a core refusal comes out as the IPC path returned it', async () => {
  const bad = Object.assign(new Error('x'), {
    detail: { kind: 'rpc', data: { reason: 'invalidParams', expected: 'limit is invalid.' } },
  });
  const { api } = await world(() => {
    throw bad;
  });
  await assert.rejects(api.listProjects(), (e) => e instanceof TypeError && e.message === 'limit is invalid.');
});

test('a start call publishes its blank snapshot as the window shell snapshot', async () => {
  const { api, ctx } = await world((method, params) =>
    method === 'project/taskWorkspace'
      ? { path: 'T' }
      : method === 'project/create'
        ? { project: { path: params.path } }
        : {}
  );
  const seen = [];
  sessionLanesOf(ctx).shell.subscribe((snapshot) => seen.push(snapshot.cwd));
  await api.startTask();
  assert.deepEqual(seen, ['T']);
  assert.equal(sessionLanesOf(ctx).shell.get().cwd, 'T');
});

test('a document preview is the hosts to convert and register in a server window too, never converted or read here', async () => {
  const asked = [];
  const reply = {
    url: 'mixdog-media://preview/t/a.pdf',
    kind: 'pdf',
    mime: 'application/pdf',
    format: 'docx',
    mtimeMs: 1,
    size: 3,
  };
  const host = {
    previewConvertedDocument: async (...args) => {
      asked.push(args);
      return reply;
    },
  };
  await inServerWindow(async () => {
    const client = fakeClient(() => ({}));
    const connection = createRendererConnection({ open: async () => client });
    await connection.start();
    const api = createFilesApi(createDirectContext(connection), { host });
    assert.deepEqual(await api.previewDocumentFile('proj', 'a.docx'), reply);
    assert.deepEqual(asked, [['proj', 'a.docx', undefined]]);
    assert.equal(
      client.calls.some((c) => c.method === 'document/preview' || c.method === 'projectFs/previewRange'),
      false
    );
  });
});

test('a window without the host cannot show a document preview and says so', async () => {
  const { api } = await world((method, params) =>
    method === 'document/preview'
      ? { path: 'C:/cache/a.pdf', format: 'docx', mtimeMs: 1, size: 3 }
      : defaults(method, params)
  );
  await assert.rejects(() => api.previewDocumentFile('proj', 'a.docx'), /cannot show a document preview/);
});

/** A core that holds a read of `total` code points and answers it a window at a time, as readwindow.rs does. */
function windowedCore(total) {
  return (method, params) => {
    if (method !== 'projectFs/readText') return defaults(method, params);
    const from = params.fromChar ?? 0;
    const end = Math.min(total, from + params.maxChars);
    return {
      content: 'x'.repeat(end - from),
      encoding: 'utf8',
      ...(end < total ? { readId: 'r', nextChar: end } : {}),
    };
  };
}

test('a 1 MiB text opens in one call and a 10 MB text in five', async () => {
  for (const [chars, calls] of [
    [1_048_576, 1],
    [10_000_000, 5],
  ]) {
    const { api, sent } = await world(windowedCore(chars));
    const file = await api.readProjectFile('C:/outside', 'big.txt', 'tok');
    assert.equal(file.content.length, chars);
    assert.equal(sent().length, calls);
  }
});

test('a document preview in a PC window is the hosts conversion with the file token passed on', async () => {
  const asked = [];
  const reply = {
    url: 'mixdog-media://preview/t/a.pdf',
    kind: 'pdf',
    mime: 'application/pdf',
    format: 'docx',
    mtimeMs: 1,
    size: 3,
  };
  const host = {
    previewConvertedDocument: async (...args) => {
      asked.push(args);
      return reply;
    },
  };
  const client = fakeClient(() => ({}));
  const connection = createRendererConnection({ open: async () => client });
  await connection.start();
  const api = createFilesApi(createDirectContext(connection), { host });
  assert.deepEqual(await api.previewDocumentFile('proj', 'a.docx', 'tok'), reply);
  assert.deepEqual(asked, [['proj', 'a.docx', 'tok']]);
  assert.equal(
    client.calls.some((c) => c.method === 'document/preview'),
    false
  );
});

test('entry operations in a standalone folder go to the core with the folder as root, trash included', async () => {
  const { api, sent } = await world((method, params) => {
    if (method === 'project/directory' && !params.standalone) throw refused;
    return defaults(method, params);
  });
  const folder = 'C:/loose/folder';
  await api.listProjectDir(folder, 'sub');
  await api.createProjectEntry(folder, '', 'a.txt', false);
  await api.renameProjectEntry(folder, 'a.txt', 'b.txt');
  await api.moveProjectEntry(folder, 'b.txt', 'sub');
  await api.copyProjectEntry(folder, 'sub/b.txt', '');
  await api.trashProjectEntry(folder, 'sub/b.txt');
  const roots = sent()
    .filter(([m]) => m !== 'project/directory')
    .map(([m, p]) => [m, p.root ?? p.path]);
  assert.deepEqual(roots, [
    ['projectFs/listDir', folder],
    ['projectFs/create', folder],
    ['projectFs/rename', folder],
    ['projectFs/move', folder],
    ['projectFs/copy', folder],
    ['projectFs/trash', folder],
  ]);
});

test('project add, rename and remove announce the settings-changed event so phones refresh', async () => {
  const { api, sent } = await world();
  await api.addProject('C:/a');
  await api.renameProject('C:/a', 'A');
  await api.removeProject('C:/a');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent().filter(([m]) => m === 'ui/settings/announce').length, 3);
});

test('reopening a removed project re-subscribes to its LSP feed and receives updates', async () => {
  const { api, client } = await world();
  const diagnostics = [];
  api.subscribeLspDiagnostics((event) => diagnostics.push(event));

  const openDoc = () =>
    api.lspDocument({ kind: 'open', projectPath: 'C:/proj', relPath: 'a.ts', languageId: 'typescript', version: 1 });
  const subscribes = () =>
    client.calls.filter((c) => c.method === 'feed/subscribe' && c.params.feedId === 'lsp:C:/proj').length;

  await openDoc();
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribes(), 1);

  await api.removeProject('C:/proj');
  await new Promise((r) => setImmediate(r));
  assert.ok(client.calls.some((c) => c.method === 'feed/unsubscribe' && c.params.feedId === 'lsp:C:/proj'));

  await api.addProject('C:/proj');
  await openDoc();
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribes(), 2, 're-adding a removed project must subscribe to the new LSP publisher');

  const event = {
    projectPath: 'C:/proj',
    relPath: 'a.ts',
    uri: 'file:///C:/proj/a.ts',
    server: 'ts',
    diagnostics: [{ message: 'after reopen' }],
  };
  client.emit({
    type: 'notification',
    notification: {
      method: 'lsp/diagnostics/updated',
      feed: { id: 'lsp:C:/proj' },
      params: { section: 'lspDiagnostics', key: event.uri, revision: 1, value: event },
    },
  });
  assert.deepEqual(diagnostics, [event]);
});

test('external project removal via projects section clears stale LSP follow for reopen', async () => {
  const storeListeners = new Set();
  let projectsValue = [{ path: 'C:/ext', name: 'ext' }];
  const client = fakeClient(defaults);
  client.store = {
    sections: () => [],
    section: (name) =>
      name === 'projects' ? { section: 'projects', key: null, revision: 1, value: projectsValue } : undefined,
    appFeed: () => ({ epoch: 'e1' }),
    subscribe: (listener) => {
      storeListeners.add(listener);
      return () => storeListeners.delete(listener);
    },
  };
  const connection = createRendererConnection({ open: async () => client });
  await connection.start();
  const api = createFilesApi(createDirectContext(connection));

  const openDoc = () =>
    api.lspDocument({ kind: 'open', projectPath: 'C:/ext', relPath: 'a.ts', languageId: 'typescript', version: 1 });
  const subscribes = () =>
    client.calls.filter((c) => c.method === 'feed/subscribe' && c.params.feedId === 'lsp:C:/ext').length;

  await openDoc();
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribes(), 1);

  projectsValue = [];
  for (const listener of storeListeners) listener({ type: 'section', section: 'projects', key: null });
  await new Promise((r) => setImmediate(r));

  projectsValue = [{ path: 'C:/ext', name: 'ext' }];
  for (const listener of storeListeners) listener({ type: 'section', section: 'projects', key: null });
  await openDoc();
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribes(), 2, 'reopening after external removal re-subscribes');
});

test('closing a document evicts mirror rows and clears editor-language-store markers without stopped status', async () => {
  const client = fakeClient(defaults);
  const connection = createRendererConnection({ open: async () => client });
  await connection.start();
  const api = createFilesApi(createDirectContext(connection));
  const previousWindow = globalThis.window;
  globalThis.window = { mixdogDesktop: api };
  try {
    const { ensureEditorLanguageStore, getEditorLanguageSnapshot } = await import('../editor-language-store.ts');
    ensureEditorLanguageStore();

    const project = 'C:/mirror-proj';
    const uriA = 'file:///C:/mirror-proj/src/a.rs';
    const uriB = 'file:///C:/mirror-proj/src/b.rs';
    await api.lspDocument({ kind: 'open', projectPath: project, relPath: 'src/a.rs', languageId: 'rust', version: 1 });
    await new Promise((r) => setImmediate(r));

    const emit = (method, params) =>
      client.emit({ type: 'notification', notification: { method, feed: { id: `lsp:${project}` }, params } });
    const diag = (relPath, uri, message) => ({
      projectPath: project,
      relPath,
      uri,
      server: 'rust-analyzer',
      diagnostics: message
        ? [{ message, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
        : [],
    });

    emit('lsp/status/updated', {
      section: 'lspStatus',
      key: 'rust\0src/a.rs',
      revision: 1,
      value: {
        projectPath: project,
        languageId: 'rust',
        relPath: 'src/a.rs',
        status: 'ready',
        available: true,
        server: 'rust-analyzer',
      },
    });
    emit('lsp/diagnostics/updated', {
      section: 'lspDiagnostics',
      key: uriA,
      revision: 1,
      value: diag('src/a.rs', uriA, 'err a'),
    });
    emit('lsp/status/updated', {
      section: 'lspStatus',
      key: 'rust\0src/b.rs',
      revision: 2,
      value: {
        projectPath: project,
        languageId: 'rust',
        relPath: 'src/b.rs',
        status: 'ready',
        available: true,
        server: 'rust-analyzer',
      },
    });
    emit('lsp/diagnostics/updated', {
      section: 'lspDiagnostics',
      key: uriB,
      revision: 2,
      value: diag('src/b.rs', uriB, 'err b'),
    });

    assert.equal(getEditorLanguageSnapshot().problems.filter((p) => p.projectPath === project).length, 2);

    // Server close sequence: status removed, empty diagnostics clear, diagnostics removed.
    emit('lsp/status/updated', { section: 'lspStatus', key: 'rust\0src/a.rs', revision: 3, removed: true });
    emit('lsp/diagnostics/updated', {
      section: 'lspDiagnostics',
      key: uriA,
      revision: 3,
      value: diag('src/a.rs', uriA, null),
    });
    emit('lsp/diagnostics/updated', { section: 'lspDiagnostics', key: uriA, revision: 4, removed: true });

    const held = connection
      .snapshot()
      .entries.filter((e) => e.section === 'lspStatus' || e.section === 'lspDiagnostics');
    assert.deepEqual(
      held.map((e) => [e.section, e.key]),
      [
        ['lspStatus', 'rust\0src/b.rs'],
        ['lspDiagnostics', uriB],
      ],
      'closed document leaves no stale status or diagnostics rows in the live mirror'
    );
    const problems = getEditorLanguageSnapshot().problems.filter((p) => p.projectPath === project);
    assert.deepEqual(
      problems.map((p) => p.uri),
      [uriB],
      'closed document diagnostics clear while sibling document diagnostics stay intact'
    );
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('stale watchFeed completion after remove and reopen does not unwatch replacement feed', async () => {
  const firstSubscribe = Promise.withResolvers();
  let subscribeCount = 0;
  const { api, client } = await world((method, params) => {
    if (method === 'feed/subscribe' && params.feedId === 'lsp:C:/race') {
      subscribeCount += 1;
      if (subscribeCount === 1) return firstSubscribe.promise;
    }
    return defaults(method, params);
  });
  const diagnostics = [];
  api.subscribeLspDiagnostics((event) => diagnostics.push(event));

  const openDoc = () =>
    api.lspDocument({ kind: 'open', projectPath: 'C:/race', relPath: 'a.ts', languageId: 'typescript', version: 1 });

  await openDoc();
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribeCount, 1);

  await api.removeProject('C:/race');
  await new Promise((r) => setImmediate(r));
  const unsubscribesAfterRemove = client.calls.filter(
    (c) => c.method === 'feed/unsubscribe' && c.params.feedId === 'lsp:C:/race'
  ).length;
  assert.equal(unsubscribesAfterRemove, 1);

  await api.addProject('C:/race');
  await openDoc();
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribeCount, 2);

  // Now the stale first watchFeed resolves after the replacement watch is active.
  firstSubscribe.resolve({});
  await new Promise((r) => setImmediate(r));

  const unsubscribesAfterStaleResolve = client.calls.filter(
    (c) => c.method === 'feed/unsubscribe' && c.params.feedId === 'lsp:C:/race'
  ).length;
  assert.equal(unsubscribesAfterStaleResolve, unsubscribesAfterRemove, 'stale watchFeed must not unwatch replacement');

  const event = {
    projectPath: 'C:/race',
    relPath: 'a.ts',
    uri: 'file:///C:/race/a.ts',
    server: 'ts',
    diagnostics: [{ message: 'live' }],
  };
  client.emit({
    type: 'notification',
    notification: {
      method: 'lsp/diagnostics/updated',
      feed: { id: 'lsp:C:/race' },
      params: { section: 'lspDiagnostics', key: event.uri, revision: 1, value: event },
    },
  });
  assert.deepEqual(diagnostics, [event]);
});

test('addProject does not unwatch an already-followed project or followed child project', async () => {
  const { api, client } = await world();
  const diagnostics = [];
  api.subscribeLspDiagnostics((event) => diagnostics.push(event));

  await api.lspDocument({
    kind: 'open',
    projectPath: 'C:/existing',
    relPath: 'a.ts',
    languageId: 'typescript',
    version: 1,
  });
  await api.lspDocument({
    kind: 'open',
    projectPath: 'C:/parent/child',
    relPath: 'b.ts',
    languageId: 'typescript',
    version: 1,
  });
  await new Promise((r) => setImmediate(r));

  await api.addProject('C:/existing');
  await api.addProject('C:/parent');
  await new Promise((r) => setImmediate(r));

  assert.equal(
    client.calls.filter((c) => c.method === 'feed/unsubscribe').length,
    0,
    'addProject must not unwatch live LSP feeds'
  );

  const e1 = {
    projectPath: 'C:/existing',
    relPath: 'a.ts',
    uri: 'file:///C:/existing/a.ts',
    server: 'ts',
    diagnostics: [],
  };
  const e2 = {
    projectPath: 'C:/parent/child',
    relPath: 'b.ts',
    uri: 'file:///C:/parent/child/b.ts',
    server: 'ts',
    diagnostics: [],
  };
  client.emit({
    type: 'notification',
    notification: {
      method: 'lsp/diagnostics/updated',
      feed: { id: 'lsp:C:/existing' },
      params: { section: 'lspDiagnostics', key: e1.uri, revision: 1, value: e1 },
    },
  });
  client.emit({
    type: 'notification',
    notification: {
      method: 'lsp/diagnostics/updated',
      feed: { id: 'lsp:C:/parent/child' },
      params: { section: 'lspDiagnostics', key: e2.uri, revision: 1, value: e2 },
    },
  });
  assert.deepEqual(diagnostics, [e1, e2]);
});

test('rejected stale watchFeed after remove and reopen does not clobber replacement LSP route', async () => {
  const firstSubscribe = Promise.withResolvers();
  let subscribeCount = 0;
  const { api, client } = await world((method, params) => {
    if (method === 'feed/subscribe' && params.feedId === 'lsp:C:/race-reject') {
      subscribeCount += 1;
      if (subscribeCount === 1) return firstSubscribe.promise;
    }
    return defaults(method, params);
  });
  const diagnostics = [];
  api.subscribeLspDiagnostics((event) => diagnostics.push(event));

  const openDoc = () =>
    api.lspDocument({
      kind: 'open',
      projectPath: 'C:/race-reject',
      relPath: 'a.ts',
      languageId: 'typescript',
      version: 1,
    });

  await openDoc();
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribeCount, 1);

  await api.removeProject('C:/race-reject');
  await new Promise((r) => setImmediate(r));
  await api.addProject('C:/race-reject');
  await openDoc();
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribeCount, 2);

  // Stale watchFeed rejects after replacement watch is already active.
  firstSubscribe.reject(new Error('connectionClosed'));
  await new Promise((r) => setImmediate(r));

  const event = {
    projectPath: 'C:/race-reject',
    relPath: 'a.ts',
    uri: 'file:///C:/race-reject/a.ts',
    server: 'ts',
    diagnostics: [{ message: 'still alive' }],
  };
  client.emit({
    type: 'notification',
    notification: {
      method: 'lsp/diagnostics/updated',
      feed: { id: 'lsp:C:/race-reject' },
      params: { section: 'lspDiagnostics', key: event.uri, revision: 1, value: event },
    },
  });
  assert.deepEqual(diagnostics, [event]);
});

test('reconnect snapshot and empty snapshot clear stale diagnostics in editor-language-store', async () => {
  const client = fakeClient(defaults);
  const connection = createRendererConnection({ open: async () => client });
  await connection.start();
  const api = createFilesApi(createDirectContext(connection));
  const previousWindow = globalThis.window;
  globalThis.window = { mixdogDesktop: api };
  try {
    const { ensureEditorLanguageStore, getEditorLanguageSnapshot } = await import('../editor-language-store.ts');
    ensureEditorLanguageStore();

    const project = '/reconnect-diag-proj';
    const uriCleared = 'file:///reconnect-diag-proj/src/cleared.rs';
    const uriKept = 'file:///reconnect-diag-proj/src/kept.rs';
    await api.lspDocument({
      kind: 'open',
      projectPath: project,
      relPath: 'src/cleared.rs',
      languageId: 'rust',
      version: 1,
    });
    await new Promise((r) => setImmediate(r));

    const diag = (relPath, uri, message) => ({
      projectPath: project,
      relPath,
      uri,
      server: 'rust-analyzer',
      diagnostics: [{ message, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
    });
    const emit = (method, params) =>
      client.emit({ type: 'notification', notification: { method, feed: { id: `lsp:${project}` }, params } });

    emit('lsp/diagnostics/updated', {
      section: 'lspDiagnostics',
      key: uriCleared,
      revision: 1,
      value: diag('src/cleared.rs', uriCleared, 'stale err'),
    });
    emit('lsp/diagnostics/updated', {
      section: 'lspDiagnostics',
      key: uriKept,
      revision: 2,
      value: diag('src/kept.rs', uriKept, 'still broken'),
    });
    assert.equal(getEditorLanguageSnapshot().problems.filter((p) => p.projectPath === project).length, 2);

    // Reconnect snapshot omits uriCleared because its diagnostic cleared while disconnected.
    client.emit({ type: 'status', status: { state: 'reconnecting' } });
    client.emit({ type: 'status', status: { state: 'ready' } });
    emit('feed/snapshot', {
      feedId: `lsp:${project}`,
      state: {
        lspDiagnostics: {
          [uriKept]: { revision: 2, value: diag('src/kept.rs', uriKept, 'still broken') },
        },
      },
    });
    assert.deepEqual(
      getEditorLanguageSnapshot()
        .problems.filter((p) => p.projectPath === project)
        .map((p) => p.uri),
      [uriKept],
      'diagnostic cleared while disconnected disappears on reconnect snapshot'
    );

    // An empty snapshot clears all remaining diagnostics for the feed.
    emit('feed/snapshot', { feedId: `lsp:${project}`, state: {} });
    assert.equal(
      getEditorLanguageSnapshot().problems.filter((p) => p.projectPath === project).length,
      0,
      'empty reconnect snapshot clears all stale diagnostics'
    );
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('worktree release and recreate at same path resubscribes on next open or request', async () => {
  const { api, client } = await world();
  const diagnostics = [];
  api.subscribeLspDiagnostics((event) => diagnostics.push(event));

  const worktree = '/repo/.mixdog/worktrees/wt-1';
  const subscribes = () =>
    client.calls.filter((c) => c.method === 'feed/subscribe' && c.params.feedId === `lsp:${worktree}`).length;

  // Case 1: worktree release stops all LSP servers and closes the publisher; next lspRequest resubscribes.
  await api.lspDocument({
    kind: 'open',
    projectPath: worktree,
    relPath: 'src/a.rs',
    languageId: 'rust',
    version: 1,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribes(), 1);

  client.emit({
    type: 'notification',
    notification: {
      method: 'lsp/status/updated',
      feed: { id: `lsp:${worktree}` },
      params: {
        section: 'lspStatus',
        key: 'rust',
        revision: 1,
        value: { projectPath: worktree, languageId: 'rust', status: 'ready', available: true, server: 'ra' },
      },
    },
  });
  client.emit({
    type: 'notification',
    notification: {
      method: 'lsp/status/updated',
      feed: { id: `lsp:${worktree}` },
      params: {
        section: 'lspStatus',
        key: 'rust',
        revision: 2,
        value: { projectPath: worktree, languageId: 'rust', status: 'stopped', available: false, server: 'ra' },
      },
    },
  });
  await new Promise((r) => setImmediate(r));

  await api.lspRequest({
    projectPath: worktree,
    relPath: 'src/a.rs',
    languageId: 'rust',
    method: 'textDocument/hover',
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribes(), 2, 'recreated worktree resubscribes after all servers stopped');

  // Case 2: silent publisher close (no projects change and no stopped status); next document open still resubscribes.
  await api.lspDocument({
    kind: 'open',
    projectPath: worktree,
    relPath: 'src/b.rs',
    languageId: 'rust',
    version: 1,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribes(), 3, 'document open refreshes subscription for recreated worktree publisher');

  const event = {
    projectPath: worktree,
    relPath: 'src/b.rs',
    uri: `file://${worktree}/src/b.rs`,
    server: 'ra',
    diagnostics: [{ message: 'fresh worktree diag' }],
  };
  client.emit({
    type: 'notification',
    notification: {
      method: 'lsp/diagnostics/updated',
      feed: { id: `lsp:${worktree}` },
      params: { section: 'lspDiagnostics', key: event.uri, revision: 1, value: event },
    },
  });
  assert.deepEqual(diagnostics, [event]);

  // Case 3: stopping one language while another remains ready does not unfollow the project.
  const multi = '/repo/.mixdog/worktrees/wt-multi';
  await api.lspDocument({ kind: 'open', projectPath: multi, relPath: 'a.rs', languageId: 'rust', version: 1 });
  await new Promise((r) => setImmediate(r));
  client.emit({
    type: 'notification',
    notification: {
      method: 'lsp/status/updated',
      feed: { id: `lsp:${multi}` },
      params: {
        section: 'lspStatus',
        key: 'rust',
        revision: 1,
        value: { projectPath: multi, languageId: 'rust', status: 'ready', available: true, server: 'ra' },
      },
    },
  });
  client.emit({
    type: 'notification',
    notification: {
      method: 'lsp/status/updated',
      feed: { id: `lsp:${multi}` },
      params: {
        section: 'lspStatus',
        key: 'typescript',
        revision: 2,
        value: { projectPath: multi, languageId: 'typescript', status: 'ready', available: true, server: 'ts' },
      },
    },
  });
  client.emit({
    type: 'notification',
    notification: {
      method: 'lsp/status/updated',
      feed: { id: `lsp:${multi}` },
      params: {
        section: 'lspStatus',
        key: 'typescript',
        revision: 3,
        value: { projectPath: multi, languageId: 'typescript', status: 'stopped', available: false, server: 'ts' },
      },
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(
    client.calls.filter((c) => c.method === 'feed/unsubscribe' && c.params.feedId === `lsp:${multi}`).length,
    0,
    'stopping one language must not unfollow while another language server is still live'
  );
});

test('POSIX paths stay case-sensitive and root / matches itself while Windows paths fold case', async () => {
  const storeListeners = new Set();
  let projectsValue = [{ path: '/srv/Foo' }, { path: '/srv/foo' }, { path: '/' }];
  const client = fakeClient(defaults);
  client.store = {
    sections: () => [],
    section: (name) =>
      name === 'projects' ? { section: 'projects', key: null, revision: 1, value: projectsValue } : undefined,
    appFeed: () => ({ epoch: 'e1' }),
    subscribe: (listener) => {
      storeListeners.add(listener);
      return () => storeListeners.delete(listener);
    },
  };
  const connection = createRendererConnection({ open: async () => client });
  await connection.start();
  const api = createFilesApi(createDirectContext(connection));
  const diagnostics = [];
  api.subscribeLspDiagnostics((event) => diagnostics.push(event));

  await api.lspDocument({
    kind: 'open',
    projectPath: '/srv/Foo',
    relPath: 'a.ts',
    languageId: 'typescript',
    version: 1,
  });
  await api.lspDocument({
    kind: 'open',
    projectPath: '/srv/foo',
    relPath: 'b.ts',
    languageId: 'typescript',
    version: 1,
  });
  await api.lspDocument({ kind: 'open', projectPath: '/', relPath: 'c.ts', languageId: 'typescript', version: 1 });
  await api.lspDocument({
    kind: 'open',
    projectPath: 'C:\\WinProj\\Sub',
    relPath: 'd.ts',
    languageId: 'typescript',
    version: 1,
  });
  await new Promise((r) => setImmediate(r));

  // Removing Linux /srv/Foo must not unfollow /srv/foo even on Windows.
  await api.removeProject('/srv/Foo');
  projectsValue = [{ path: '/srv/foo' }, { path: '/' }];
  for (const listener of storeListeners) listener({ type: 'section', section: 'projects', key: null });
  await new Promise((r) => setImmediate(r));

  assert.equal(
    client.calls.filter((c) => c.method === 'feed/unsubscribe' && c.params.feedId === 'lsp:/srv/Foo').length,
    1
  );
  assert.equal(
    client.calls.filter((c) => c.method === 'feed/unsubscribe' && c.params.feedId === 'lsp:/srv/foo').length,
    0,
    '/srv/foo must remain followed when /srv/Foo is removed'
  );

  const liveLower = {
    projectPath: '/srv/foo',
    relPath: 'b.ts',
    uri: 'file:///srv/foo/b.ts',
    server: 'ts',
    diagnostics: [{ message: 'still followed' }],
  };
  client.emit({
    type: 'notification',
    notification: {
      method: 'lsp/diagnostics/updated',
      feed: { id: 'lsp:/srv/foo' },
      params: { section: 'lspDiagnostics', key: liveLower.uri, revision: 1, value: liveLower },
    },
  });
  assert.deepEqual(diagnostics, [liveLower]);

  // Windows path removal folds case and slashes.
  await api.removeProject('c:/winproj');
  await new Promise((r) => setImmediate(r));
  assert.equal(
    client.calls.filter((c) => c.method === 'feed/unsubscribe' && c.params.feedId === 'lsp:C:\\WinProj\\Sub').length,
    1
  );

  // Removing POSIX root / must unfollow / and its child /srv/foo.
  await api.removeProject('/');
  await new Promise((r) => setImmediate(r));
  assert.equal(
    client.calls.filter((c) => c.method === 'feed/unsubscribe' && c.params.feedId === 'lsp:/').length,
    1,
    'POSIX root / must match itself'
  );
  assert.equal(
    client.calls.filter((c) => c.method === 'feed/unsubscribe' && c.params.feedId === 'lsp:/srv/foo').length,
    1,
    'POSIX root / must match child paths'
  );

  // Forward-slash UNC paths fold case like Windows UNC paths.
  await api.lspDocument({
    kind: 'open',
    projectPath: '//server/share/Foo',
    relPath: 'a.ts',
    languageId: 'typescript',
    version: 1,
  });
  await api.lspDocument({
    kind: 'open',
    projectPath: '\\\\server\\share\\Foo\\Sub',
    relPath: 'b.ts',
    languageId: 'typescript',
    version: 1,
  });
  await new Promise((r) => setImmediate(r));

  await api.removeProject('//server/share/foo');
  await new Promise((r) => setImmediate(r));
  assert.equal(
    client.calls.filter((c) => c.method === 'feed/unsubscribe' && c.params.feedId === 'lsp://server/share/Foo').length,
    1,
    'removing //server/share/foo unfollows //server/share/Foo'
  );
  assert.equal(
    client.calls.filter((c) => c.method === 'feed/unsubscribe' && c.params.feedId === 'lsp:\\\\server\\share\\Foo\\Sub')
      .length,
    1,
    'removing //server/share/foo unfollows backslash UNC descendant'
  );
});

test('failed refresh watchFeed does not orphan route and ordinary lspRequest retries subscribe', async () => {
  let failNext = false;
  const { api, client } = await world((method, params) => {
    if (method === 'feed/subscribe' && params.feedId === 'lsp:/retry-proj' && failNext) {
      failNext = false;
      throw new Error('subscribe failed');
    }
    return defaults(method, params);
  });
  const diagnostics = [];
  api.subscribeLspDiagnostics((event) => diagnostics.push(event));

  const subscribes = () =>
    client.calls.filter((c) => c.method === 'feed/subscribe' && c.params.feedId === 'lsp:/retry-proj').length;

  await api.lspDocument({
    kind: 'open',
    projectPath: '/retry-proj',
    relPath: 'a.ts',
    languageId: 'typescript',
    version: 1,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribes(), 1);

  // Trigger a refresh on open that fails with a non-absent error.
  failNext = true;
  await api.lspDocument({
    kind: 'open',
    projectPath: '/retry-proj',
    relPath: 'b.ts',
    languageId: 'typescript',
    version: 1,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribes(), 2);

  // An ordinary lspRequest (non-refresh) must resubscribe instead of hitting a stale cached route.
  await api.lspRequest({
    projectPath: '/retry-proj',
    relPath: 'b.ts',
    languageId: 'typescript',
    method: 'textDocument/hover',
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribes(), 3, 'ordinary lspRequest resubscribes after a failed refresh');

  const event = {
    projectPath: '/retry-proj',
    relPath: 'b.ts',
    uri: 'file:///retry-proj/b.ts',
    server: 'ts',
    diagnostics: [{ message: 'recovered' }],
  };
  client.emit({
    type: 'notification',
    notification: {
      method: 'lsp/diagnostics/updated',
      feed: { id: 'lsp:/retry-proj' },
      params: { section: 'lspDiagnostics', key: event.uri, revision: 1, value: event },
    },
  });
  assert.deepEqual(diagnostics, [event]);
});

test('reconnect snapshot omitting a previously ready language allows all-stopped unfollow', async () => {
  const { api, client } = await world();
  const project = '/wt-reconnect-langs';
  const sibling = '/wt-sibling-langs';
  const subscribes = (p) =>
    client.calls.filter((c) => c.method === 'feed/subscribe' && c.params.feedId === `lsp:${p}`).length;
  const unsubscribes = (p) =>
    client.calls.filter((c) => c.method === 'feed/unsubscribe' && c.params.feedId === `lsp:${p}`).length;

  await api.lspDocument({ kind: 'open', projectPath: project, relPath: 'a.rs', languageId: 'rust', version: 1 });
  await api.lspDocument({ kind: 'open', projectPath: sibling, relPath: 's.rs', languageId: 'rust', version: 1 });
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribes(project), 1);

  const emit = (p, method, params) =>
    client.emit({ type: 'notification', notification: { method, feed: { id: `lsp:${p}` }, params } });

  const rustReady = (p) => ({
    projectPath: p,
    languageId: 'rust',
    status: 'ready',
    available: true,
    server: 'ra',
  });
  const tsReady = {
    projectPath: project,
    languageId: 'typescript',
    status: 'ready',
    available: true,
    server: 'ts',
  };

  emit(project, 'lsp/status/updated', { section: 'lspStatus', key: 'rust', revision: 1, value: rustReady(project) });
  emit(project, 'lsp/status/updated', { section: 'lspStatus', key: 'typescript', revision: 2, value: tsReady });
  emit(sibling, 'lsp/status/updated', { section: 'lspStatus', key: 'rust', revision: 1, value: rustReady(sibling) });

  // Reconnect snapshot for `project` omits `rust` and only retains `typescript`.
  emit(project, 'feed/snapshot', {
    feedId: `lsp:${project}`,
    state: {
      lspStatus: {
        typescript: { revision: 2, value: tsReady },
      },
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(unsubscribes(project), 0, 'still live because typescript remains ready');

  // Now the last real server (`typescript`) stops: `rust` was cleared by the snapshot so unfollow must run.
  emit(project, 'lsp/status/updated', {
    section: 'lspStatus',
    key: 'typescript',
    revision: 3,
    value: { ...tsReady, status: 'stopped', available: false },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(unsubscribes(project), 1, 'stopping last remaining language unfollows after snapshot omitted rust');
  assert.equal(unsubscribes(sibling), 0, 'sibling project with same language key stays followed');

  // Recreated worktree resubscribes on next request.
  await api.lspRequest({
    projectPath: project,
    relPath: 'a.rs',
    languageId: 'rust',
    method: 'textDocument/hover',
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribes(project), 2);

  // If a reconnect snapshot omits the only live language, unfollow runs immediately.
  emit(sibling, 'feed/snapshot', { feedId: `lsp:${sibling}`, state: {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(unsubscribes(sibling), 1, 'empty snapshot omitting last ready language unfollows immediately');

  // If a reconnect snapshot omits the last live document-scoped lspStatus key, unfollow runs too.
  const docScoped = '/wt-doc-scoped-status';
  await api.lspDocument({ kind: 'open', projectPath: docScoped, relPath: 'src/a.rs', languageId: 'rust', version: 1 });
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribes(docScoped), 1);

  emit(docScoped, 'lsp/status/updated', {
    section: 'lspStatus',
    key: 'rust\0src/a.rs',
    revision: 1,
    value: { ...rustReady(docScoped), relPath: 'src/a.rs' },
  });
  emit(docScoped, 'feed/snapshot', { feedId: `lsp:${docScoped}`, state: {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(
    unsubscribes(docScoped),
    1,
    'omitting the last live document-scoped lspStatus key unfollows the project'
  );

  await api.lspRequest({
    projectPath: docScoped,
    relPath: 'src/a.rs',
    languageId: 'rust',
    method: 'textDocument/hover',
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribes(docScoped), 2, 'next ordinary lspRequest resubscribes after document-scoped key omission');
});

test('removing POSIX root / does not unfollow UNC projects', async () => {
  const { api, client } = await world();

  await api.lspDocument({ kind: 'open', projectPath: '/', relPath: 'a.ts', languageId: 'typescript', version: 1 });
  await api.lspDocument({
    kind: 'open',
    projectPath: '/srv/app',
    relPath: 'b.ts',
    languageId: 'typescript',
    version: 1,
  });
  await api.lspDocument({
    kind: 'open',
    projectPath: '//server/share/proj',
    relPath: 'c.ts',
    languageId: 'typescript',
    version: 1,
  });
  await api.lspDocument({
    kind: 'open',
    projectPath: '\\\\server\\share\\other',
    relPath: 'd.ts',
    languageId: 'typescript',
    version: 1,
  });
  await new Promise((r) => setImmediate(r));

  await api.removeProject('/');
  await new Promise((r) => setImmediate(r));

  const unsubCount = (feedId) =>
    client.calls.filter((c) => c.method === 'feed/unsubscribe' && c.params.feedId === feedId).length;
  assert.equal(unsubCount('lsp:/'), 1, 'POSIX root / unfollows itself');
  assert.equal(unsubCount('lsp:/srv/app'), 1, 'POSIX root / unfollows POSIX descendant');
  assert.equal(unsubCount('lsp://server/share/proj'), 0, 'POSIX root / must not unfollow forward-slash UNC project');
  assert.equal(unsubCount('lsp:\\\\server\\share\\other'), 0, 'POSIX root / must not unfollow backslash UNC project');
});
