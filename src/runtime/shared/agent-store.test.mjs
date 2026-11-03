import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import fs from 'node:fs';
import { botStoreActive, readBotRoute, readMixyRoute, writeBotRoute, writeMixyRoute } from './agent-store.mjs';
import { SAFETY_RECHECK_MS, _resetWatchedFileCachesForTest } from './watched-file-cache.mjs';
import { eventually, gateFirstAsyncStat, settle, spySyncFs } from './watched-file-cache.test-helpers.mjs';

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

test('without watch events the safety re-check sees a foreign route, and a late re-check never clobbers a local write', async (t) => {
  t.mock.method(fs, 'watch', () => {
    throw Object.assign(new Error('no watch'), { code: 'ENOSYS' });
  });
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { dataDir, mixyFile } = mixyFixture(t);
  writeFileSync(mixyFile, JSON.stringify({ route: route('one') }));
  assert.deepEqual(readMixyRoute(dataDir), route('one'));
  writeFileSync(mixyFile, JSON.stringify({ route: route('foreign') }));
  await settle();
  assert.deepEqual(readMixyRoute(dataDir), route('one'), 'no re-check before its interval');
  t.mock.timers.tick(SAFETY_RECHECK_MS);
  await eventually(() => readMixyRoute(dataDir)?.model === 'foreign');

  t.mock.timers.tick(SAFETY_RECHECK_MS);
  const releaseStat = gateFirstAsyncStat(t);
  assert.deepEqual(readMixyRoute(dataDir), route('foreign'));
  writeMixyRoute(dataDir, route('local'));
  assert.deepEqual(readMixyRoute(dataDir), route('local'));
  await settle();
  assert.deepEqual(readMixyRoute(dataDir), route('local'));
  releaseStat();
  await settle();
  const calls = spySyncFs(t);
  assert.deepEqual(readMixyRoute(dataDir), route('local'), 'the late re-check did not replace the local write');
  assert.deepEqual([...calls], [], 'nor forced a reload');
});
