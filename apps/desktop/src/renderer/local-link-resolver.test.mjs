import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveLocalLink, verifyLocalLink } from './local-link-resolver.ts';

const PROJECT = 'C:/Project/conversation';
const OTHER = 'C:/Project/other';

function makeApi(entries, gate) {
  const calls = [];
  const api = {
    listProjects: async () => {
      calls.push(['listProjects']);
      return Object.keys(entries).map((path) => ({ path, name: path }));
    },
    statProjectFile: async (project, path) => {
      calls.push(['statProjectFile', project, path]);
      await gate?.promise;
      if (entries[project]?.includes(path)) return { size: 1, mtimeMs: 1 };
      throw Object.assign(new Error(`ENOENT: ${project}/${path}`), { code: 'ENOENT' });
    },
    searchProjectFiles: async (project, query) => {
      calls.push(['searchProjectFiles', project, query]);
      return entries[project] || [];
    },
  };
  return { api, calls };
}

function installApi(t, entries, gate) {
  const { api, calls } = makeApi(entries, gate);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const window = { mixdogDesktop: api };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  });
  return Object.assign(calls, { window });
}

test('verification resolves in the conversation Project first, then in other Projects', async (t) => {
  const calls = installApi(t, { [PROJECT]: ['src/app.ts'], [OTHER]: ['lib/other.ts'] });
  assert.deepEqual(await verifyLocalLink(PROJECT, 'app.ts'), { project: PROJECT, path: 'src/app.ts' });
  // Found in its own Project: other Projects are never listed or searched.
  assert.ok(calls.every(([method, project]) => method !== 'listProjects' && project === PROJECT));

  calls.length = 0;
  assert.deepEqual(await verifyLocalLink(PROJECT, 'other.ts'), { project: OTHER, path: 'lib/other.ts' });
  assert.deepEqual(
    calls.filter(([method]) => method === 'searchProjectFiles'),
    [
      ['searchProjectFiles', PROJECT, 'other.ts'],
      ['searchProjectFiles', OTHER, 'other.ts'],
    ]
  );
  await assert.rejects(verifyLocalLink(PROJECT, 'nowhere.ts'), /File not found/);
});

test('an explicit open resolves the same way as verification', async (t) => {
  installApi(t, { [PROJECT]: ['src/app.ts'], [OTHER]: ['lib/other.ts'] });
  assert.deepEqual(await resolveLocalLink(PROJECT, 'other.ts'), { project: OTHER, path: 'lib/other.ts' });
});

test('verification dedupes concurrent and repeated checks; missing results expire sooner', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const gate = Promise.withResolvers();
  const calls = installApi(t, { [PROJECT]: ['src/app.ts'] }, gate);
  const concurrent = Array.from({ length: 5 }, () => verifyLocalLink(PROJECT, 'app.ts'));
  gate.resolve();
  for (const match of await Promise.all(concurrent)) {
    assert.deepEqual(match, { project: PROJECT, path: 'src/app.ts' });
  }
  const found = calls.length;
  assert.deepEqual(
    calls.filter(([method]) => method === 'searchProjectFiles'),
    [['searchProjectFiles', PROJECT, 'app.ts']]
  );
  await verifyLocalLink(PROJECT, 'app.ts');
  assert.equal(calls.length, found);

  await assert.rejects(verifyLocalLink(PROJECT, 'missing.ts'), /File not found/);
  const missing = calls.length;
  await assert.rejects(verifyLocalLink(PROJECT, 'missing.ts'), /File not found/);
  assert.equal(calls.length, missing);

  t.mock.timers.tick(5_000);
  await assert.rejects(verifyLocalLink(PROJECT, 'missing.ts'), /File not found/);
  assert.ok(calls.length > missing);
  const retried = calls.length;
  await verifyLocalLink(PROJECT, 'app.ts');
  assert.equal(calls.length, retried);

  t.mock.timers.tick(60_000);
  await verifyLocalLink(PROJECT, 'app.ts');
  assert.ok(calls.length > retried);
});

test('each desktop API instance keeps its own verification results', async (t) => {
  const first = installApi(t, { [PROJECT]: ['src/app.ts'] });
  await verifyLocalLink(PROJECT, 'src/app.ts');
  const second = makeApi({ [PROJECT]: [] });
  first.window.mixdogDesktop = second.api;
  await assert.rejects(verifyLocalLink(PROJECT, 'src/app.ts'), /File not found/);
  assert.ok(first.length > 0 && second.calls.length > 0);
});
