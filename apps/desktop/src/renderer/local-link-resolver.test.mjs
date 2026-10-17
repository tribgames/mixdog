import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveLocalLink, resolveLocalLinkForOpen, verifyLocalLink } from './local-link-resolver.ts';

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

test('a click on a verified outside-file link describes it again instead of reusing its old token', async (t) => {
  const calls = installApi(t, { [PROJECT]: ['src/app.ts'] });
  calls.window.mixdogDesktop.resolveLocalPaths = async (paths) => {
    calls.push(['resolveLocalPaths', ...paths]);
    return [{ absolutePath: paths[0], projectPath: 'C:/Outside', relPath: 'note.txt', accessToken: 'current' }];
  };
  const stale = { project: 'C:/Outside', path: 'note.txt', accessToken: 'evicted' };
  assert.deepEqual(await resolveLocalLinkForOpen(stale, PROJECT, 'C:/Outside/note.txt'), {
    project: 'C:/Outside',
    path: 'note.txt',
    accessToken: 'current',
  });
  assert.deepEqual([...calls], [['resolveLocalPaths', 'C:/Outside/note.txt']]);

  calls.length = 0;
  const inProject = { project: PROJECT, path: 'src/app.ts' };
  assert.equal(
    await resolveLocalLinkForOpen(inProject, PROJECT, 'app.ts'),
    inProject,
    'a Project file reuses its location'
  );
  assert.deepEqual([...calls], []);
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

test('a conversation folder that is not a registered Project opens its files by absolute path', async (t) => {
  const calls = installApi(t, {});
  const resolved = [];
  Object.assign(calls.window.mixdogDesktop, {
    statProjectFile: async () => {
      throw Object.assign(new Error('Project is not available.'), { code: 'PROJECT_UNAVAILABLE' });
    },
    resolveLocalPaths: async ([absolutePath]) => {
      resolved.push(absolutePath);
      return [
        {
          absolutePath,
          name: 'deck.pptx',
          dir: false,
          size: 1,
          projectPath: 'C:/Project/mixdog',
          relPath: 'out/A/deck.pptx',
        },
      ];
    },
  });
  const expected = { project: 'C:/Project/mixdog', path: 'out/A/deck.pptx' };
  assert.deepEqual(await resolveLocalLink('C:\\Project\\mixdog\\out\\A', 'deck.pptx'), expected);
  assert.deepEqual(
    await resolveLocalLink('C:\\Project\\mixdog\\out\\A', 'C:\\Project\\mixdog\\out\\A\\deck.pptx'),
    expected
  );
  assert.deepEqual(resolved, ['C:/Project/mixdog/out/A/deck.pptx', 'C:/Project/mixdog/out/A/deck.pptx']);
});

test('a registered Project whose folder is gone neither hides a match nor replaces a miss', async (t) => {
  const GONE = 'C:/Temp/deleted-project';
  const calls = installApi(t, { [PROJECT]: [], [GONE]: [], [OTHER]: ['docs/found.md'] });
  calls.window.mixdogDesktop.searchProjectFiles = async (project) => {
    if (project === GONE) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${GONE}'`), { code: 'ENOENT' });
    }
    return project === OTHER ? ['docs/found.md'] : [];
  };
  assert.deepEqual(await resolveLocalLink(PROJECT, 'docs/found.md'), { project: OTHER, path: 'docs/found.md' });
  await assert.rejects(resolveLocalLink(PROJECT, 'docs/missing.md'), /File not found in the Project/);
});

test('an access refusal while searching another Project is reported, not turned into a miss', async (t) => {
  const GUARDED = 'C:/Project/guarded';
  const calls = installApi(t, { [PROJECT]: [], [GUARDED]: ['docs/found.md'], [OTHER]: [] });
  const statFile = calls.window.mixdogDesktop.statProjectFile;
  calls.window.mixdogDesktop.statProjectFile = async (project, path) => {
    if (project === GUARDED) throw new Error('Path resolves outside the project.');
    return statFile(project, path);
  };
  await assert.rejects(resolveLocalLink(PROJECT, 'docs/found.md'), /Path resolves outside the project/);
});

test('a refusal is told by its code: a file name or message wording never turns it into a miss', async (t) => {
  const calls = installApi(t, { [PROJECT]: [], [OTHER]: [] });
  // Access was denied in a folder whose name spells ENOENT: still the answer.
  const denied = Object.assign(new Error("EACCES: permission denied, scandir 'C:/ENOENT/docs'"), { code: 'EACCES' });
  calls.window.mixdogDesktop.searchProjectFiles = async (project) => {
    if (project === OTHER) throw denied;
    return [];
  };
  await assert.rejects(resolveLocalLink(PROJECT, 'docs/found.md'), (error) => error === denied);

  // A different refusal that merely says "Project is not available" is not a missing Project.
  const refused = Object.assign(new Error('Project is not available.'), { code: 'EACCES' });
  calls.window.mixdogDesktop.statProjectFile = async () => {
    throw refused;
  };
  await assert.rejects(resolveLocalLink(PROJECT, 'docs/found.md'), (error) => error === refused);

  // The codes are enough, whatever the message says.
  calls.window.mixdogDesktop.statProjectFile = async () => {
    throw Object.assign(new Error('registry has no such entry'), { code: 'PROJECT_UNAVAILABLE' });
  };
  calls.window.mixdogDesktop.resolveLocalPaths = async ([absolutePath]) => [
    { absolutePath, projectPath: 'C:/Project/mixdog', relPath: 'docs/found.md' },
  ];
  assert.deepEqual(await resolveLocalLink(PROJECT, 'docs/found.md'), {
    project: 'C:/Project/mixdog',
    path: 'docs/found.md',
  });
  calls.window.mixdogDesktop.statProjectFile = async () => {
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  };
  calls.window.mixdogDesktop.searchProjectFiles = async () => [];
  await assert.rejects(resolveLocalLink(PROJECT, 'docs/found.md'), /File not found in the Project/);
});

test('each desktop API instance keeps its own verification results', async (t) => {
  const first = installApi(t, { [PROJECT]: ['src/app.ts'] });
  await verifyLocalLink(PROJECT, 'src/app.ts');
  const second = makeApi({ [PROJECT]: [] });
  first.window.mixdogDesktop = second.api;
  await assert.rejects(verifyLocalLink(PROJECT, 'src/app.ts'), /File not found/);
  assert.ok(first.length > 0 && second.calls.length > 0);
});
