import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { readConfig, updateConfig, updateSection } from './config.mjs';
import {
  backupUserData,
  backupUserDataAsync,
  hasUserDataInitMarker,
  loadLatestMixdogConfigFromBackup,
  markUserDataInitialized,
} from './user-data-guard.mjs';

process.env.MIXDOG_SETUP_QUIET = '1';
delete process.env.MIXDOG_SKIP_USER_DATA_BACKUP;

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-user-data-guard-'));
  const saved = {
    MIXDOG_DATA_DIR: process.env.MIXDOG_DATA_DIR,
    MIXDOG_USER_DATA_BACKUP_ROOT: process.env.MIXDOG_USER_DATA_BACKUP_ROOT,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const backupRoot = join(root, 'backups');
  process.env.MIXDOG_USER_DATA_BACKUP_ROOT = backupRoot;
  const dir = (name) => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  const scopes = () => readdirSync(backupRoot).filter((name) => name.startsWith('scope-'));
  return { backupRoot, dir, scopes };
}

const use = (dataDir) => {
  process.env.MIXDOG_DATA_DIR = dataDir;
};
const configFile = (dataDir) => join(dataDir, 'mixdog-config.json');
const complete = (tag) => ({ agent: { tag }, ui: { theme: tag } });
const write = (tag) => updateConfig(() => complete(tag));
const tag = () => readConfig().agent?.tag;

function writeLegacyBackup(backupRoot, name, config, manifest) {
  const dir = join(backupRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'mixdog-config.json'), JSON.stringify(config));
  if (manifest) writeFileSync(join(dir, 'backup.json'), JSON.stringify(manifest));
  return dir;
}

test('two data dirs sharing a backup root never restore each other', async (t) => {
  const { dir, scopes, backupRoot } = sandbox(t);
  const a = dir('a');
  const b = dir('b');
  use(b);
  write('B');
  use(a);
  write('A'); // newest backup in the shared root
  assert.equal(scopes().length, 2);
  for (const scope of scopes()) {
    for (const backup of readdirSync(join(backupRoot, scope))) {
      const manifest = JSON.parse(readFileSync(join(backupRoot, scope, backup, 'backup.json'), 'utf8'));
      assert.ok([resolve(a), resolve(b)].includes(manifest.dataDir));
      assert.equal(typeof manifest.instanceId, 'string');
    }
  }
  const asyncBackup = await backupUserDataAsync(a, 'async');
  assert.equal(JSON.parse(readFileSync(join(asyncBackup.dir, 'backup.json'), 'utf8')).dataDir, resolve(a));

  use(b);
  rmSync(configFile(b));
  assert.equal(tag(), 'B');

  // An initialized data dir with no backups of its own restores nothing.
  const c = dir('c');
  markUserDataInitialized(c);
  use(c);
  assert.equal(loadLatestMixdogConfigFromBackup(c), null);
  assert.deepEqual(readConfig(), {});
});

test('a recreated profile at the same path is fresh, never a restore case', (t) => {
  const { dir } = sandbox(t);
  const a = dir('a');
  use(a);
  write('old');
  rmSync(a, { recursive: true, force: true });
  mkdirSync(a);
  assert.equal(hasUserDataInitMarker(a), false);
  assert.deepEqual(readConfig(), {});
  updateSection('ui', { theme: 'new' });
  const stored = JSON.parse(readFileSync(configFile(a), 'utf8'));
  assert.equal(stored.agent, undefined);
  assert.equal(stored.ui.theme, 'new');

  // Even once the new incarnation is initialized, the old one's backups in the
  // same scope are not its own.
  const b = dir('b');
  use(b);
  write('old-b');
  rmSync(b, { recursive: true, force: true });
  mkdirSync(b);
  markUserDataInitialized(b);
  assert.equal(loadLatestMixdogConfigFromBackup(b), null);
  assert.deepEqual(readConfig(), {});
});

test('pruning keeps N backups per scope and never evicts another scope or legacy entries', (t) => {
  const { dir, backupRoot } = sandbox(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const installed = dir('installed');
  const dev = dir('dev');
  writeFileSync(configFile(installed), JSON.stringify(complete('installed')));
  writeFileSync(configFile(dev), JSON.stringify(complete('dev')));
  const legacy = writeLegacyBackup(backupRoot, '2020-01-01T00-00-00-000Z-legacy', complete('legacy'));
  const installedDirs = [1, 2, 3].map((i) => backupUserData(installed, `installed-${i}`).dir);
  const devDirs = Array.from({ length: 45 }, (_, i) => backupUserData(dev, `dev-${String(i).padStart(2, '0')}`).dir);
  for (const path of installedDirs) assert.equal(existsSync(path), true, path);
  assert.equal(existsSync(legacy), true);
  assert.equal(readdirSync(join(devDirs[0], '..')).length, 40);
  assert.equal(
    devDirs.slice(5).every((path) => existsSync(path)),
    true
  );
});

test('legacy unscoped backups are ignored unless their manifest matches this data dir', (t) => {
  const { dir, backupRoot } = sandbox(t);
  const a = dir('a');
  writeFileSync(configFile(a), JSON.stringify(complete('a')));
  const instanceId = markUserDataInitialized(a);
  // Newest first: three non-matching entries shadow one matching entry.
  const entries = [
    writeLegacyBackup(backupRoot, '2020-01-04T00-00-00-000Z-none', complete('none')),
    writeLegacyBackup(backupRoot, '2020-01-03T00-00-00-000Z-other', complete('other'), {
      dataDir: dir('other'),
      instanceId,
    }),
    writeLegacyBackup(backupRoot, '2020-01-02T00-00-00-000Z-stale', complete('stale'), {
      dataDir: a,
      instanceId: 'previous-incarnation',
    }),
    writeLegacyBackup(backupRoot, '2020-01-01T00-00-00-000Z-match', complete('match'), { dataDir: a, instanceId }),
  ];
  use(a);
  rmSync(configFile(a));
  assert.equal(tag(), 'match');

  const b = dir('b');
  writeFileSync(configFile(b), JSON.stringify(complete('b')));
  markUserDataInitialized(b);
  rmSync(configFile(b));
  use(b);
  assert.deepEqual(readConfig(), {});
  for (const path of entries) assert.equal(existsSync(path), true, path);
});

function writeLegacyMarker(backupRoot, dataDir) {
  mkdirSync(backupRoot, { recursive: true });
  const id = createHash('sha256').update(String(dataDir)).digest('hex').slice(0, 16);
  writeFileSync(join(backupRoot, `.initialized-${id}.json`), JSON.stringify({ dataDir }));
}

test('upgrade with config missing restores from a legacy backup verified to belong to this data dir', (t) => {
  const { dir, backupRoot } = sandbox(t);
  const a = dir('a');
  writeLegacyMarker(backupRoot, a);
  writeLegacyBackup(backupRoot, '2020-01-03T00-00-00-000Z-none', complete('none'));
  writeLegacyBackup(backupRoot, '2020-01-02T00-00-00-000Z-other', complete('other'), { dataDir: dir('other') });
  writeLegacyBackup(backupRoot, '2020-01-01T00-00-00-000Z-match', complete('match'), { dataDir: a });
  use(a);
  assert.equal(hasUserDataInitMarker(a), false);
  assert.equal(tag(), 'match');
  assert.equal(JSON.parse(readFileSync(configFile(a), 'utf8')).agent.tag, 'match');
  assert.equal(hasUserDataInitMarker(a), true);
  updateSection('ui', { theme: 'after' });
  const stored = JSON.parse(readFileSync(configFile(a), 'utf8'));
  assert.equal(stored.agent.tag, 'match');
  assert.equal(stored.ui.theme, 'after');
});

test('upgrade with config missing and only non-matching legacy backups refuses RMW writes', (t) => {
  const { dir, backupRoot } = sandbox(t);
  const a = dir('a');
  writeLegacyMarker(backupRoot, a);
  writeLegacyBackup(backupRoot, '2020-01-02T00-00-00-000Z-none', complete('none'));
  writeLegacyBackup(backupRoot, '2020-01-01T00-00-00-000Z-other', complete('other'), { dataDir: dir('other') });
  use(a);
  assert.deepEqual(readConfig(), {});
  assert.throws(
    () => updateSection('ui', { theme: 'fresh' }),
    (err) => err.code === 'EUSERDATARECOVERY' && /older Mixdog build/.test(err.message)
  );
  assert.throws(() => updateConfig(() => complete('fresh')), { code: 'EUSERDATARECOVERY' });
  assert.equal(existsSync(configFile(a)), false);
  assert.equal(hasUserDataInitMarker(a), false);
});

test('a fresh data dir with unrelated legacy backups stays a fresh install', (t) => {
  const { dir, backupRoot } = sandbox(t);
  writeLegacyMarker(backupRoot, dir('other'));
  writeLegacyBackup(backupRoot, '2020-01-01T00-00-00-000Z-none', complete('none'));
  const a = dir('a');
  use(a);
  assert.deepEqual(readConfig(), {});
  updateSection('ui', { theme: 'fresh' });
  const stored = JSON.parse(readFileSync(configFile(a), 'utf8'));
  assert.equal(stored.agent, undefined);
  assert.equal(stored.ui.theme, 'fresh');
});

test('readAll reuses one restore lookup until this process writes again', (t) => {
  const { dir, backupRoot } = sandbox(t);
  const a = dir('a');
  use(a);
  write('v1');
  rmSync(configFile(a));
  const original = fs.readdirSync;
  let scans = 0;
  fs.readdirSync = (path, ...args) => {
    if (String(path).startsWith(backupRoot)) scans += 1;
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(tag(), 'v1');
    const first = scans;
    assert.ok(first > 0);
    for (let i = 0; i < 5; i += 1) assert.equal(tag(), 'v1');
    assert.equal(scans, first);
  } finally {
    fs.readdirSync = original;
    syncBuiltinESMExports();
  }
  write('v2');
  rmSync(configFile(a));
  assert.equal(tag(), 'v2');
});

test('a plain read restores a deleted config once, persists it and later reads hit the file', (t) => {
  const { dir, backupRoot, scopes } = sandbox(t);
  const a = dir('a');
  use(a);
  write('v1');
  rmSync(configFile(a));
  const lines = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, ...args) => {
    if (String(chunk).startsWith('[config]')) lines.push(String(chunk));
    return originalWrite.call(process.stderr, chunk, ...args);
  };
  try {
    assert.equal(tag(), 'v1');
    assert.equal(JSON.parse(readFileSync(configFile(a), 'utf8')).agent.tag, 'v1');
    for (let i = 0; i < 20; i += 1) assert.equal(tag(), 'v1');
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(lines.length, 1, lines.join(''));
  assert.match(lines[0], /restored mixdog-config\.json .* and saved it/);
  const backups = readdirSync(join(backupRoot, scopes()[0]));
  assert.ok(
    backups.some((name) => name.endsWith('-post-restore')),
    backups.join(',')
  );
});

test('crash recovery restores the latest backup of the same data dir', (t) => {
  const { dir } = sandbox(t);
  // Pre/post-write snapshots must retain creation order even at one clock tick.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const a = dir('a');
  use(a);
  write('v1');
  write('v2');
  writeFileSync(configFile(a), '{broken');
  assert.equal(tag(), 'v2');
  updateSection('ui', { theme: 'after-restore' });
  const stored = JSON.parse(readFileSync(configFile(a), 'utf8'));
  assert.equal(stored.agent.tag, 'v2');
  assert.equal(stored.ui.theme, 'after-restore');
});

for (const [firstKind, secondKind] of [
  ['sync', 'sync'],
  ['sync', 'async'],
  ['async', 'sync'],
  ['async', 'async'],
]) {
  test(`${firstKind}/${secondKind} snapshots in one millisecond preserve both versions and restore the latest`, async (t) => {
    const { dir } = sandbox(t);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const a = dir('a');
    const writers = { sync: backupUserData, async: backupUserDataAsync };
    writeFileSync(configFile(a), JSON.stringify(complete('v1')));
    const first = await writers[firstKind](a, 'snapshot');
    writeFileSync(configFile(a), JSON.stringify(complete('v2')));
    const second = await writers[secondKind](a, 'snapshot');
    assert.notEqual(first.dir, second.dir);
    for (const backup of [first, second]) {
      assert.match(basename(backup.dir), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+-snapshot$/);
    }
    assert.equal(JSON.parse(readFileSync(join(first.dir, 'mixdog-config.json'), 'utf8')).agent.tag, 'v1');
    assert.equal(JSON.parse(readFileSync(join(second.dir, 'mixdog-config.json'), 'utf8')).agent.tag, 'v2');
    assert.equal(loadLatestMixdogConfigFromBackup(a).agent.tag, 'v2');
  });
}

for (const kind of ['sync', 'async']) {
  test(`${kind} snapshots keep their order within a process when the clock moves backwards`, async (t) => {
    const { dir } = sandbox(t);
    const now = Date.now();
    t.mock.timers.enable({ apis: ['Date'], now });
    const a = dir('a');
    const writeBackup = kind === 'sync' ? backupUserData : backupUserDataAsync;
    writeFileSync(configFile(a), JSON.stringify(complete('v1')));
    await writeBackup(a, 'z-reason');
    t.mock.timers.setTime(now - 1_000);
    writeFileSync(configFile(a), JSON.stringify(complete('v2')));
    await writeBackup(a, 'a-reason');
    assert.equal(loadLatestMixdogConfigFromBackup(a).agent.tag, 'v2');
  });
}

for (const kind of ['sync', 'async']) {
  test(`overlapping async/${kind} snapshots at one clock tick get distinct backup paths`, async (t) => {
    const { dir } = sandbox(t);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const a = dir('a');
    writeFileSync(configFile(a), JSON.stringify(complete('v1')));
    const writeBackup = kind === 'sync' ? backupUserData : backupUserDataAsync;
    const backups = await Promise.all([backupUserDataAsync(a, 'snapshot'), writeBackup(a, 'snapshot')]);
    assert.notEqual(backups[0].dir, backups[1].dir);
    for (const backup of backups) {
      assert.equal(JSON.parse(readFileSync(join(backup.dir, 'mixdog-config.json'), 'utf8')).agent.tag, 'v1');
    }
    assert.equal(loadLatestMixdogConfigFromBackup(a).agent.tag, 'v1');
  });
}

// A writer that starts after `a` wrote: its own module state, as in another process.
let writerGeneration = 0;
const otherProcess = () => import(`./user-data-guard.mjs?writer=${++writerGeneration}`);
const backupsOf = (backupRoot, scopes) => readdirSync(join(backupRoot, scopes()[0]));

for (const kind of ['sync', 'async']) {
  for (const shift of [0, -1_000]) {
    test(`a later ${kind} writer's backup restores as the newest with a ${shift}ms clock shift`, async (t) => {
      const { dir } = sandbox(t);
      const now = Date.now();
      t.mock.timers.enable({ apis: ['Date'], now });
      const a = dir('a');
      writeFileSync(configFile(a), JSON.stringify(complete('v1')));
      for (let i = 0; i < 3; i += 1) backupUserData(a, 'snapshot');
      t.mock.timers.setTime(now + shift);
      const later = await otherProcess();
      writeFileSync(configFile(a), JSON.stringify(complete('v2')));
      await (kind === 'sync' ? later.backupUserData : later.backupUserDataAsync)(a, 'a-reason');
      assert.equal(later.loadLatestMixdogConfigFromBackup(a).agent.tag, 'v2');
      assert.equal(loadLatestMixdogConfigFromBackup(a, { fresh: true }).agent.tag, 'v2');
    });
  }

  test(`a later ${kind} writer keeps its backup when the retention ring is full`, async (t) => {
    const { dir, backupRoot, scopes } = sandbox(t);
    const now = Date.now();
    t.mock.timers.enable({ apis: ['Date'], now });
    const a = dir('a');
    writeFileSync(configFile(a), JSON.stringify(complete('v1')));
    for (let i = 0; i < 40; i += 1) backupUserData(a, 'snapshot');
    t.mock.timers.setTime(now - 60_000);
    const later = await otherProcess();
    writeFileSync(configFile(a), JSON.stringify(complete('v2')));
    const written = await (kind === 'sync' ? later.backupUserData : later.backupUserDataAsync)(a, 'snapshot');
    assert.equal(existsSync(written.dir), true);
    assert.equal(backupsOf(backupRoot, scopes).length, 40);
    assert.equal(later.loadLatestMixdogConfigFromBackup(a).agent.tag, 'v2');
  });
}

test('ordering follows an older build name and ignores names that are no backup', async (t) => {
  const { dir, backupRoot, scopes } = sandbox(t);
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  // A writer whose clock never ran ahead of `now`.
  const writer = await otherProcess();
  const a = dir('a');
  writeFileSync(configFile(a), JSON.stringify(complete('v1')));
  const scope = join(backupDir(writer.backupUserData(a, 'snapshot')), '..');
  // An older build's unsequenced name at this very millisecond sorts after
  // every sequenced one; a later backup must still sort after it.
  const instanceId = markUserDataInitialized(a);
  writeLegacyBackup(scope, '2026-01-01T00-00-00-000Z-legacy', complete('legacy'), { dataDir: a, instanceId });
  // Neither an impossible date nor an unrelated name or a file moves the order.
  mkdirSync(join(scope, '2026-99-99T99-99-99-999Z-0000000000-bogus'));
  mkdirSync(join(scope, 'unrelated'));
  writeFileSync(join(scope, 'note.txt'), 'x');
  writeFileSync(configFile(a), JSON.stringify(complete('v2')));
  const written = writer.backupUserData(a, 'snapshot');
  assert.match(basename(written.dir), /^2026-01-01T00-00-00-001Z-/);
  assert.equal(loadLatestMixdogConfigFromBackup(a).agent.tag, 'v2');
  assert.ok(backupsOf(backupRoot, scopes).includes(basename(written.dir)));
});

function backupDir(result) {
  assert.ok(result.dir);
  return result.dir;
}

test('a fresh restore lookup sees a newer backup another writer made after a cached one', async (t) => {
  const { dir } = sandbox(t);
  const a = dir('a');
  writeFileSync(configFile(a), JSON.stringify(complete('v1')));
  backupUserData(a, 'snapshot');
  assert.equal(loadLatestMixdogConfigFromBackup(a).agent.tag, 'v1');
  const other = await otherProcess();
  writeFileSync(configFile(a), JSON.stringify(complete('v2')));
  other.backupUserData(a, 'snapshot');
  // A plain read may reuse this process's lookup; an RMW write never does.
  assert.equal(loadLatestMixdogConfigFromBackup(a).agent.tag, 'v1');
  assert.equal(loadLatestMixdogConfigFromBackup(a, { fresh: true }).agent.tag, 'v2');
  assert.equal(loadLatestMixdogConfigFromBackup(a).agent.tag, 'v2');

  // The RMW path: a write over a missing config builds on the newest backup.
  const third = await otherProcess();
  writeFileSync(configFile(a), JSON.stringify(complete('v3')));
  third.backupUserData(a, 'snapshot');
  use(a);
  rmSync(configFile(a));
  updateSection('ui', { theme: 'after' });
  assert.equal(JSON.parse(readFileSync(configFile(a), 'utf8')).agent.tag, 'v3');
});

function failingFs(t, method, matches) {
  const original = fs[method];
  let armed = true;
  fs[method] = (path, ...args) => {
    if (armed && matches(String(path))) {
      throw Object.assign(new Error(`EIO: i/o error, ${method} '${path}'`), { code: 'EIO' });
    }
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  const restore = () => {
    armed = false;
    fs[method] = original;
    syncBuiltinESMExports();
  };
  t.after(restore);
  return restore;
}

for (const [label, method, target] of [
  ['listing the scope', 'readdirSync', (path, { scope }) => path === scope],
  ['reading the newest manifest', 'readFileSync', (path, { newest }) => path === join(newest, 'backup.json')],
  ['reading the newest config', 'readFileSync', (path, { newest }) => path === join(newest, 'mixdog-config.json')],
]) {
  test(`a transient failure ${label} is never taken for an older or a missing backup`, (t) => {
    const { dir } = sandbox(t);
    const a = dir('a');
    writeFileSync(configFile(a), JSON.stringify(complete('v1')));
    backupUserData(a, 'snapshot');
    writeFileSync(configFile(a), JSON.stringify(complete('v2')));
    const newest = backupDir(backupUserData(a, 'snapshot'));
    const scope = join(newest, '..');
    const restore = failingFs(t, method, (path) => target(path, { scope, newest }));
    assert.throws(() => loadLatestMixdogConfigFromBackup(a, { fresh: true }), { code: 'EIO' });
    // A plain read stays empty instead of restoring v1, and caches nothing.
    use(a);
    rmSync(configFile(a));
    assert.deepEqual(readConfig(), {});
    restore();
    assert.equal(tag(), 'v2');
  });
}

const configAsides = (dataDir) =>
  readdirSync(dataDir)
    .filter((name) => name.startsWith('mixdog-config.json.corrupt-'))
    .map((name) => join(dataDir, name));

for (const [order, trigger] of [
  ['a read quarantines it first', () => assert.deepEqual(readConfig(), {})],
  ['the save finds it itself', () => {}],
]) {
  test(`a NUL config with no backup never blocks a settings save (${order})`, (t) => {
    const { dir } = sandbox(t);
    const a = dir('a');
    markUserDataInitialized(a); // initialized, but no backup was ever taken
    const damaged = Buffer.alloc(96);
    writeFileSync(configFile(a), damaged);
    use(a);
    trigger();
    updateSection('ui', { theme: 'saved' });
    assert.equal(JSON.parse(readFileSync(configFile(a), 'utf8')).ui.theme, 'saved');
    assert.ok(
      configAsides(a).some((copy) => readFileSync(copy).equals(damaged)),
      'the damaged bytes are kept'
    );
  });
}

for (const [order, trigger] of [
  ['a read quarantines it first', () => assert.deepEqual(readConfig(), {})],
  ['the save finds it itself', () => {}],
]) {
  test(`a non-empty malformed config with no backup is kept aside and a save proceeds (${order})`, (t) => {
    const { dir } = sandbox(t);
    const a = dir('a');
    markUserDataInitialized(a);
    const damaged = Buffer.from('{"agent": {"tag": "half-wri');
    writeFileSync(configFile(a), damaged);
    use(a);
    trigger();
    updateSection('ui', { theme: 'saved' });
    assert.equal(JSON.parse(readFileSync(configFile(a), 'utf8')).ui.theme, 'saved');
    assert.ok(configAsides(a).some((copy) => readFileSync(copy).equals(damaged)));
  });
}

test('a config that cannot be read still refuses a save instead of starting empty', (t) => {
  const { dir } = sandbox(t);
  const a = dir('a');
  use(a);
  write('v1');
  const restore = failingFs(t, 'readFileSync', (path) => path === configFile(a));
  assert.throws(() => updateSection('ui', { theme: 'x' }), { code: 'EIO' });
  restore();
  assert.equal(tag(), 'v1');
});

test('a NUL config is restored from the latest backup', (t) => {
  const { dir } = sandbox(t);
  const a = dir('a');
  use(a);
  write('v1');
  writeFileSync(configFile(a), Buffer.alloc(64));
  assert.equal(tag(), 'v1');
  writeFileSync(configFile(a), Buffer.alloc(64));
  updateSection('ui', { theme: 'after' });
  const stored = JSON.parse(readFileSync(configFile(a), 'utf8'));
  assert.equal(stored.agent.tag, 'v1');
  assert.equal(stored.ui.theme, 'after');
});

test('a hand-edited config with a byte order mark loads and is not quarantined', (t) => {
  const { dir } = sandbox(t);
  const a = dir('a');
  writeFileSync(configFile(a), `\uFEFF${JSON.stringify(complete('bom'))}`);
  use(a);
  assert.equal(tag(), 'bom');
  updateSection('ui', { theme: 'saved' });
  const stored = JSON.parse(readFileSync(configFile(a), 'utf8'));
  assert.equal(stored.agent.tag, 'bom');
  assert.equal(stored.ui.theme, 'saved');
  assert.deepEqual(configAsides(a), []);
});

test('backup copies and their manifest are flushed through the handle that wrote them', (t) => {
  const { dir } = sandbox(t);
  const a = dir('a');
  writeFileSync(configFile(a), JSON.stringify(complete('v1')));
  const original = fs.fsyncSync;
  let syncs = 0;
  fs.fsyncSync = (fd) => {
    syncs += 1;
    return original(fd);
  };
  syncBuiltinESMExports();
  let backup;
  try {
    backup = backupUserData(a, 'snapshot');
  } finally {
    fs.fsyncSync = original;
    syncBuiltinESMExports();
  }
  assert.ok(syncs >= 3, `config copy, init marker and manifest are each flushed (saw ${syncs})`);
  assert.equal(JSON.parse(readFileSync(join(backup.dir, 'mixdog-config.json'), 'utf8')).agent.tag, 'v1');
  assert.equal(JSON.parse(readFileSync(join(backup.dir, 'backup.json'), 'utf8')).dataDir, resolve(a));
});

test('a backup is not written when its scope cannot be listed', (t) => {
  const { dir } = sandbox(t);
  const a = dir('a');
  writeFileSync(configFile(a), JSON.stringify(complete('v1')));
  const first = backupDir(backupUserData(a, 'snapshot'));
  const scope = join(first, '..');
  const restore = failingFs(t, 'readdirSync', (path) => path === scope);
  assert.throws(() => backupUserData(a, 'snapshot'), { code: 'EIO' });
  restore();
  assert.deepEqual(
    fs.readdirSync(scope).filter((name) => name !== basename(first)),
    []
  );
});
