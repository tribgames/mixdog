import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { botStoreActive, readBotRoute, writeBotRoute } from './agent-store.mjs';

function storeFixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-agent-store-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(join(dataDir, 'bots', 'tool-bot'), { recursive: true });
  writeFileSync(join(dataDir, 'bots', 'migration.json'), JSON.stringify({ version: 1, bots: ['tool-bot'] }));
  const file = join(dataDir, 'bots', 'tool-bot', 'agent.json');
  const asides = (dir) => readdirSync(dir).filter((name) => name.includes('.corrupt-'));
  return { dataDir, file, asides };
}

const route = (model) => ({ provider: 'openai', model });

test('a damaged agent.json with no good copy stays in place and never blocks its bot route', (t) => {
  const { dataDir, file, asides } = storeFixture(t);
  writeBotRoute(dataDir, 'tool-bot', route('one'));
  assert.deepEqual(readBotRoute(dataDir, 'tool-bot'), route('one'));
  const damaged = Buffer.alloc(7);
  writeFileSync(file, damaged);
  assert.equal(readBotRoute(dataDir, 'tool-bot'), null, 'a damaged definition has no route');
  // Left in place: the connector policy reader treats a missing agent.json as
  // "every connector on", so moving it aside would fail open.
  assert.equal(readFileSync(file).equals(damaged), true, 'the damaged bytes stay where they were');
  assert.equal(asides(join(file, '..')).length, 0);
  writeBotRoute(dataDir, 'tool-bot', route('two'));
  assert.deepEqual(readBotRoute(dataDir, 'tool-bot'), route('two'));
});

test('a damaged agent.json is restored from the version the last route write replaced', (t) => {
  const { dataDir, file } = storeFixture(t);
  writeBotRoute(dataDir, 'tool-bot', route('one'));
  writeBotRoute(dataDir, 'tool-bot', route('two'));
  writeFileSync(file, '{"route":');
  assert.deepEqual(readBotRoute(dataDir, 'tool-bot'), route('one'));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).route.model, 'one');
});

test('a damaged bot-store manifest reads as no store, not as an error', (t) => {
  const { dataDir } = storeFixture(t);
  assert.equal(botStoreActive(dataDir), true);
  writeFileSync(join(dataDir, 'bots', 'migration.json'), Buffer.alloc(40));
  assert.equal(botStoreActive(dataDir), false);
});
