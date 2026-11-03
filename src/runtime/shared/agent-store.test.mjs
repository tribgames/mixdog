import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { botStoreActive, readBotRoute, readMixyRoute, writeBotRoute, writeMixyRoute } from './agent-store.mjs';
import { _resetWatchedFileCachesForTest } from './watched-file-cache.mjs';
import { eventually, settle, spySyncFs } from './watched-file-cache.test-helpers.mjs';

function storeFixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-agent-store-'));
  t.after(() => {
    _resetWatchedFileCachesForTest();
    rmSync(dataDir, { recursive: true, force: true });
  });
  mkdirSync(join(dataDir, 'bots', 'tool-bot'), { recursive: true });
  writeFileSync(join(dataDir, 'bots', 'migration.json'), JSON.stringify({ version: 1, bots: ['tool-bot'] }));
  const file = join(dataDir, 'bots', 'tool-bot', 'agent.json');
  const asides = (dir) => readdirSync(dir).filter((name) => name.includes('.corrupt-'));
  return { dataDir, file, asides };
}

const route = (model) => ({ provider: 'openai', model });

test('a damaged agent.json with no good copy stays in place and never blocks its bot route', async (t) => {
  const { dataDir, file, asides } = storeFixture(t);
  writeBotRoute(dataDir, 'tool-bot', route('one'));
  assert.deepEqual(readBotRoute(dataDir, 'tool-bot'), route('one'));
  const damaged = Buffer.alloc(7);
  writeFileSync(file, damaged);
  await eventually(() => readBotRoute(dataDir, 'tool-bot') === null);
  // Left in place: the connector policy reader treats a missing agent.json as
  // "every connector on", so moving it aside would fail open.
  assert.equal(readFileSync(file).equals(damaged), true, 'the damaged bytes stay where they were');
  assert.equal(asides(join(file, '..')).length, 0);
  writeBotRoute(dataDir, 'tool-bot', route('two'));
  assert.deepEqual(readBotRoute(dataDir, 'tool-bot'), route('two'));
});

test('a damaged agent.json is restored from the version the last route write replaced', async (t) => {
  const { dataDir, file } = storeFixture(t);
  writeBotRoute(dataDir, 'tool-bot', route('one'));
  writeBotRoute(dataDir, 'tool-bot', route('two'));
  writeFileSync(file, '{"route":');
  await eventually(() => readBotRoute(dataDir, 'tool-bot')?.model === 'one');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).route.model, 'one');
});

test('a damaged bot-store manifest reads as no store, not as an error', async (t) => {
  const { dataDir } = storeFixture(t);
  assert.equal(botStoreActive(dataDir), true);
  writeFileSync(join(dataDir, 'bots', 'migration.json'), Buffer.alloc(40));
  await eventually(() => botStoreActive(dataDir) === false);
});

function mixyFixture(t) {
  const fixture = storeFixture(t);
  mkdirSync(join(fixture.dataDir, 'bots', 'mixy'), { recursive: true });
  return { ...fixture, mixyFile: join(fixture.dataDir, 'bots', 'mixy', 'agent.json') };
}

test('warm bot-store reads touch no filesystem; a route write is visible at once', (t) => {
  const { dataDir } = mixyFixture(t);
  writeMixyRoute(dataDir, route('one'));
  assert.equal(botStoreActive(dataDir), true);
  const calls = spySyncFs(t);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(botStoreActive(dataDir), true);
    assert.deepEqual(readMixyRoute(dataDir), route('one'));
  }
  assert.deepEqual(calls.splice(0), []);
  calls.paused = true;
  writeMixyRoute(dataDir, route('two'));
  calls.paused = false;
  assert.deepEqual(readMixyRoute(dataDir), route('two'));
  assert.deepEqual([...calls], [], 'the write-through value, not a disk read');
});

test('another process’s route write is seen through the directory watch', async (t) => {
  const { dataDir, mixyFile } = mixyFixture(t);
  writeMixyRoute(dataDir, route('one'));
  assert.deepEqual(readMixyRoute(dataDir), route('one'));
  writeFileSync(mixyFile, JSON.stringify({ route: route('foreign') }));
  await eventually(() => readMixyRoute(dataDir)?.model === 'foreign');
});

// Every read of `file` (sync, and through fs/promises) fails as a sharing violation.
function refuseReads(t, file) {
  const refused = { count: 0 };
  const refuse = (original) =>
    function (target, ...rest) {
      if (String(target) !== file) return original.call(this, target, ...rest);
      refused.count += 1;
      throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' });
    };
  t.mock.method(fs, 'readFileSync', refuse(fs.readFileSync));
  const readFile = refuse(fsp.readFile);
  t.mock.method(fsp, 'readFile', async (...args) => readFile(...args));
  syncBuiltinESMExports();
  t.after(() => syncBuiltinESMExports());
  return refused;
}

test('a route re-read that cannot read the file keeps the last route', async (t) => {
  const { dataDir, mixyFile } = mixyFixture(t);
  writeFileSync(mixyFile, JSON.stringify({ route: route('kept') }));
  assert.deepEqual(readMixyRoute(dataDir), route('kept'));
  const refused = refuseReads(t, mixyFile);
  writeFileSync(mixyFile, JSON.stringify({ route: route('unread') }));
  await eventually(() => refused.count > 0);
  await settle(100);
  assert.deepEqual(readMixyRoute(dataDir), route('kept'), 'a failed read is no missing file');
});

test('a synchronous route write right after its file changed lands: no re-read keeps the file open', async (t) => {
  const { dataDir, mixyFile } = mixyFixture(t);
  writeMixyRoute(dataDir, route('one'));
  assert.deepEqual(readMixyRoute(dataDir), route('one'));
  // An async read of the file, should the re-read make one, holds a real
  // handle on it until the test ends: Windows then refuses any rename over it.
  const readFile = fsp.readFile;
  let held = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(fsp, 'readFile', async (target, ...rest) => {
    if (String(target) !== mixyFile) return readFile(target, ...rest);
    const handle = await fsp.open(target, 'r');
    held = true;
    try {
      await gate;
      return await handle.readFile(...rest);
    } finally {
      await handle.close();
    }
  });
  syncBuiltinESMExports();
  t.after(() => {
    release();
    syncBuiltinESMExports();
  });
  writeFileSync(mixyFile, JSON.stringify({ route: route('foreign') }));
  await eventually(() => held || readMixyRoute(dataDir)?.model === 'foreign');
  writeMixyRoute(dataDir, route('two'));
  assert.deepEqual(readMixyRoute(dataDir), route('two'));
  assert.equal(held, false, 'the re-read closed the file before returning');
});

