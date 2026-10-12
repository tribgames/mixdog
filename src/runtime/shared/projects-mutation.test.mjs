import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { withFileLockSync } from './atomic-file.mjs';
import { createProjectCatalog } from '../../standalone/session-service/project-catalog.mjs';

const moduleUrl = new URL('./projects.mjs', import.meta.url).href;
let sequence = 0;
async function fixture(t, { missing = false } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'mixdog-project-mutation-'));
  const file = join(root, 'state', 'projects.json');
  const a = { name: 'A', path: join(root, 'A'), addedAt: 1 };
  const b = { name: 'B', path: join(root, 'B'), addedAt: 2 };
  const saved = [process.env.MIXDOG_PROJECTS_FILE, process.env.MIXDOG_DISABLE_PROJECT_MARKERS];
  process.env.MIXDOG_PROJECTS_FILE = file;
  process.env.MIXDOG_DISABLE_PROJECT_MARKERS = '1';
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const [i, key] of ['MIXDOG_PROJECTS_FILE', 'MIXDOG_DISABLE_PROJECT_MARKERS'].entries()) {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (!missing) {
    fs.mkdirSync(dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ projects: [a, b] }));
  }
  const store = await import(`${moduleUrl}?mutation-test=${sequence++}`);
  return { root, file, a, b, store, lock: `${file}.lock` };
}

const mutations = [
  { name: 'add', run: ({ store, root }) => store.addProject(join(root, 'C')) },
  { name: 'touch', run: ({ store, a }) => store.touchProjectSelected(a.path) },
  { name: 'rename', run: ({ store, a }) => store.renameProject(a.path, 'Renamed') },
  { name: 'remove', run: ({ store, a }) => store.removeProject(a.path) },
];
const failure = (code) => Object.assign(new Error(`injected ${code}`), { code });
function replaceIo(t, name, replace) {
  t.mock.method(fs, name, replace(fs[name]));
  syncBuiltinESMExports();
}
function assertClean({ file, lock }) {
  assert.equal(fs.existsSync(lock), false, 'the registry lock must be released');
  assert.deepEqual(fs.readdirSync(dirname(file)), ['projects.json'], 'no staged write or lock is left behind');
}

for (const mutation of mutations) {
  for (const code of ['EIO', 'EACCES']) {
    test(`${mutation.name}: unreadable state is not empty state (${code})`, async (t) => {
      const f = await fixture(t);
      const read = fs.readFileSync;
      const before = read(f.file, 'utf8');
      const error = failure(code);
      replaceIo(t, 'readFileSync', (original) => (path, ...args) => {
        if (path === f.file) throw error;
        return original(path, ...args);
      });
      assert.deepEqual(f.store.listProjects(), [], 'ordinary listing remains tolerant');
      assert.throws(
        () => mutation.run(f),
        (caught) => caught === error
      );
      assert.equal(read(f.file, 'utf8'), before);
      assertClean(f);
      t.mock.restoreAll();
      syncBuiltinESMExports();
      assert.equal(f.store.renameProject(f.a.path, 'Recovered').name, 'Recovered');
    });
  }

  test(`${mutation.name}: failed publication cannot report success`, async (t) => {
    const f = await fixture(t);
    const before = fs.readFileSync(f.file, 'utf8');
    const error = failure('EIO');
    replaceIo(t, 'renameSync', (original) => (from, to, ...args) => {
      if (to === f.file) throw error;
      return original(from, to, ...args);
    });
    assert.throws(
      () => mutation.run(f),
      (caught) => caught === error
    );
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    assertClean(f);
  });

  test(`${mutation.name}: acquires the registry lock before reading`, async (t) => {
    const f = await fixture(t);
    const lockedReads = [];
    replaceIo(t, 'readFileSync', (original) => (path, ...args) => {
      if (path === f.file) lockedReads.push(fs.existsSync(f.lock));
      return original(path, ...args);
    });
    mutation.run(f);
    assert.deepEqual(lockedReads, [true]);
    assertClean(f);
  });
}

for (const [name, document] of [
  ['truncated JSON', () => '{"projects":'],
  ['missing array', () => '{}'],
  ['null document', () => 'null'],
  ['non-array projects', () => '{"projects":{}}'],
  ['invalid entry beside valid data', (f) => JSON.stringify({ projects: [f.a, {}] })],
  ['blank path', () => '{"projects":[{"path":" "}]}'],
  ['relative stored path', () => '{"projects":[{"path":"relative"}]}'],
]) {
  test(`mutations preserve ${name} byte-for-byte`, async (t) => {
    const f = await fixture(t);
    const source = document(f);
    fs.writeFileSync(f.file, source);
    for (const mutation of mutations) {
      assert.throws(
        () => mutation.run(f),
        (error) => error instanceof SyntaxError || error instanceof TypeError
      );
      assert.equal(fs.readFileSync(f.file, 'utf8'), source);
      assertClean(f);
    }
  });
}

test('missing state initializes; synchronous results, dedupe, recency and no-ops are preserved', async (t) => {
  const f = await fixture(t, { missing: true });
  const { store, a, b } = f;
  assert.equal(store.addProject(''), null);
  assert.equal(store.removeProject(''), false);
  assert.equal(store.renameProject('', 'name'), null);
  assert.equal(store.touchProjectSelected(''), null);
  assert.equal(fs.existsSync(dirname(f.file)), false);
  assert.deepEqual(store.listProjects(), []);
  const added = store.addProject(a.path);
  assert.equal(added.path, a.path);
  assert.equal(typeof added.then, 'undefined', 'the daemon expects a synchronous store');
  store.addProject(b.path);
  assert.equal(store.renameProject(a.path, ' Alias ').name, 'Alias');
  assert.equal(store.renameProject(a.path, '').name, basename(a.path));
  const touched = store.touchProjectSelected(a.path);
  assert.ok(touched.lastSelectedAt > 0);
  assert.equal(store.listProjects()[0].path, a.path);
  const before = fs.readFileSync(f.file, 'utf8');
  replaceIo(t, 'renameSync', (original) => (from, to, ...args) => {
    if (to === f.file) throw new Error('no-op must not publish');
    return original(from, to, ...args);
  });
  const samePath = process.platform === 'win32' ? a.path.toUpperCase() : join(a.path, '.');
  assert.equal(store.addProject(samePath).path, a.path);
  assert.equal(store.removeProject(join(f.root, 'absent')), false);
  assert.equal(store.renameProject(join(f.root, 'absent'), 'name'), null);
  assert.equal(store.touchProjectSelected(join(f.root, 'absent')), null);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assertClean(f);
});

test('partial temporary-file write failure preserves existing state and releases the lock', async (t) => {
  const f = await fixture(t);
  const before = fs.readFileSync(f.file, 'utf8');
  const error = failure('ENOSPC');
  replaceIo(t, 'writeFileSync', (original) => (path, data, ...args) => {
    if (
      typeof path === 'string' &&
      dirname(path) === dirname(f.file) &&
      basename(path).includes('projects.json') &&
      path.endsWith('.tmp') &&
      !path.includes('.lock.')
    ) {
      original(path, 'partial', ...args);
      throw error;
    }
    return original(path, data, ...args);
  });
  assert.throws(
    () => f.store.addProject(join(f.root, 'C')),
    (caught) => caught === error
  );
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assertClean(f);
});

test('registry IO errors reach the actual project catalog instead of successful RPC results', async (t) => {
  const f = await fixture(t);
  const catalog = createProjectCatalog({ desktopRuntime: { loadProjects: async () => f.store } });
  const error = failure('EIO');
  replaceIo(t, 'renameSync', (original) => (from, to, ...args) => {
    if (to === f.file) throw error;
    return original(from, to, ...args);
  });
  for (const [method, path] of [
    ['addProjectEntry', join(f.root, 'C')],
    ['touchProjectEntry', f.a.path],
    ['renameProjectEntry', f.a.path],
    ['removeProjectEntry', f.a.path],
  ])
    await assert.rejects(catalog[method]({ path, name: 'Renamed' }), (caught) => caught === error);
  t.mock.restoreAll();
  syncBuiltinESMExports();
  assert.deepEqual(await catalog.removeProjectEntry({ path: f.a.path }), { removed: true });
  assert.equal(
    (await catalog.listProjectCatalog()).projects.some((row) => row.path === f.a.path),
    false
  );
  assertClean(f);
});

test('auxiliary marker failure is best-effort after publication and outside the lock', async (t) => {
  const f = await fixture(t);
  process.env.MIXDOG_DISABLE_PROJECT_MARKERS = '0';
  const path = join(f.root, 'C');
  fs.mkdirSync(path);
  let attempted = false;
  let locked = true;
  replaceIo(t, 'mkdirSync', (original) => (target, ...args) => {
    if (target === join(path, '.mixdog')) {
      attempted = true;
      locked = fs.existsSync(f.lock);
      throw failure('EACCES');
    }
    return original(target, ...args);
  });
  assert.equal(f.store.addProject(path).path, path);
  assert.equal(attempted, true);
  assert.equal(locked, false);
  assert.ok(f.store.listProjects().some((row) => row.path === path));
  assertClean(f);
});

test('failed registration does not create an auxiliary marker', async (t) => {
  const f = await fixture(t);
  process.env.MIXDOG_DISABLE_PROJECT_MARKERS = '0';
  const path = join(f.root, 'C');
  fs.mkdirSync(path);
  replaceIo(t, 'renameSync', (original) => (from, to, ...args) => {
    if (to === f.file) throw failure('EIO');
    return original(from, to, ...args);
  });
  assert.throws(() => f.store.addProject(path), { code: 'EIO' });
  assert.equal(fs.existsSync(join(path, '.mixdog')), false);
  assertClean(f);
});

// Deterministic two-process interleaving at real leaf IO. The first writer is
// paused after reading; the second acknowledges either OS-lock contention or
// its completed mutation. No scheduler timing assumption chooses the winner.
const workerSource = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const p = JSON.parse(process.argv[1]);
const store = await import(p.moduleUrl);
const read = fs.readFileSync, link = fs.linkSync, write = fs.writeFileSync;
const wait = (path) => {
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('barrier timed out: ' + path);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
let first = true;
fs.readFileSync = (path, ...args) => {
  const value = read(path, ...args);
  if (path === p.file && first) {
    first = false;
    if (p.role === 'holder') { write(p.ready, '1'); wait(p.release); }
    else write(p.readMarker, '1');
  }
  return value;
};
fs.linkSync = (from, to, ...args) => {
  try { return link(from, to, ...args); }
  catch (error) {
    if (p.role === 'contender' && to === p.file + '.lock' && error.code === 'EEXIST') write(p.ready, '1');
    throw error;
  }
};
syncBuiltinESMExports();
store[p.method](p.path, 'Renamed');
write(p.done, '1');
if (p.role === 'contender') write(p.ready, '1');
`;

function startWorker(t, f, params) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      workerSource,
      JSON.stringify({
        ...params,
        file: f.file,
        moduleUrl,
      }),
    ],
    {
      env: { ...process.env, MIXDOG_PROJECTS_FILE: f.file, MIXDOG_LOCK_TIMEOUT_MS: '10000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${output}`))));
  });
  done.catch(() => {});
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await done.catch(() => {});
  });
  return done;
}
async function waitFor(path, childDone) {
  let ended = false;
  let failure;
  childDone.then(
    () => {
      ended = true;
    },
    (error) => {
      ended = true;
      failure = error;
    }
  );
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(path)) {
    if (failure) throw failure;
    if (ended) throw new Error(`worker ended before ${path}`);
    if (Date.now() >= deadline) throw new Error(`barrier timed out: ${path}`);
    await delay(10);
  }
}

for (const [name, method] of [
  ['add', 'addProject'],
  ['touch', 'touchProjectSelected'],
  ['rename', 'renameProject'],
  ['remove', 'removeProject'],
]) {
  test(`${name}: a competing process rereads after the lock; neither update is lost`, async (t) => {
    const f = await fixture(t);
    const release = join(f.root, 'release');
    const holderReady = join(f.root, 'holder-ready');
    const contenderReady = join(f.root, 'contender-ready');
    const readMarker = join(f.root, 'contender-read');
    const holder = startWorker(t, f, {
      role: 'holder',
      method,
      path: name === 'add' ? join(f.root, 'D') : f.a.path,
      ready: holderReady,
      release,
      done: join(f.root, 'holder-done'),
    });
    let contender;
    let readBeforeRelease;
    try {
      await waitFor(holderReady, holder);
      contender = startWorker(t, f, {
        role: 'contender',
        method: 'addProject',
        path: join(f.root, 'C'),
        ready: contenderReady,
        readMarker,
        done: join(f.root, 'contender-done'),
      });
      await waitFor(contenderReady, contender);
      readBeforeRelease = fs.existsSync(readMarker);
    } finally {
      fs.writeFileSync(release, '1');
      await Promise.all([holder, contender]);
    }
    assert.equal(readBeforeRelease, false, 'the contender must not read a stale pre-lock snapshot');
    const rows = f.store.listProjects();
    assert.ok(
      rows.some((row) => row.path === join(f.root, 'C')),
      'competing addition survives'
    );
    const a = rows.find((row) => row.path === f.a.path);
    if (name === 'add') assert.ok(rows.some((row) => row.path === join(f.root, 'D')));
    if (name === 'touch') assert.ok(a.lastSelectedAt > 0);
    if (name === 'rename') assert.equal(a.name, 'Renamed');
    if (name === 'remove') assert.equal(a, undefined, 'removed project must not be resurrected');
    assertClean(f);
  });
}

test('lock contention propagates without reading or replacing the registry or deleting the live lock', async (t) => {
  const f = await fixture(t);
  const before = fs.readFileSync(f.file, 'utf8');
  withFileLockSync(f.lock, () => {
    const owner = fs.readFileSync(f.lock, 'utf8');
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const store = await import(${JSON.stringify(moduleUrl)});
      const read = fs.readFileSync;
      let reads = 0;
      fs.readFileSync = (path, ...args) => { if (path === process.env.MIXDOG_PROJECTS_FILE) reads++; return read(path, ...args); };
      syncBuiltinESMExports();
      const errors = [];
      for (const method of ['addProject','touchProjectSelected','renameProject','removeProject']) {
        try { store[method](${JSON.stringify(f.a.path)}, 'Changed'); errors.push(null); }
        catch (error) { errors.push(error.code); }
      }
      console.log(JSON.stringify({ errors, reads }));
    `,
      ],
      { env: { ...process.env, MIXDOG_LOCK_TIMEOUT_MS: '0' }, encoding: 'utf8', timeout: 15000 }
    );
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    assert.deepEqual(JSON.parse(child.stdout), { errors: Array(4).fill('ELOCKCONTENDED'), reads: 0 });
    assert.equal(fs.readFileSync(f.lock, 'utf8'), owner);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  });
  assertClean(f);
});
