import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRequestedModel } from './model-select.mjs';

const ROWS = [
  { provider: 'anthropic-oauth', id: 'claude-sonnet-5-5', display: 'Claude Sonnet 5.5' },
  { provider: 'anthropic-oauth', id: 'claude-opus-5-5', display: 'Claude Opus 5.5' },
  { provider: 'anthropic-oauth', id: 'claude-opus-5-1', display: 'Claude Opus 5.1' },
  { provider: 'command-code', id: 'claude-sonnet-5-5', display: 'Claude Sonnet 5.5' },
  { provider: 'command-code', id: 'kimi-k3', display: 'Kimi K3' },
];

function catalog(fresh = ROWS, cached = fresh) {
  const calls = [];
  const list = async (options = {}) => {
    calls.push(options.force === true ? 'force' : 'cache');
    return options.force === true ? fresh : cached;
  };
  return { list, calls };
}

test('no model keeps the preset route untouched', async () => {
  const args = { type: 'spawn', agent: 'reviewer' };
  const { list, calls } = catalog();
  assert.equal(await resolveRequestedModel(args, list), args);
  assert.deepEqual(calls, []);
});

test('provider without model is rejected', async () => {
  await assert.rejects(resolveRequestedModel({ provider: 'command-code' }, catalog().list), /provider requires model/);
});

test('exact id, display name and words resolve to one exact route', async () => {
  const { list } = catalog();
  assert.deepEqual(await resolveRequestedModel({ model: 'kimi-k3' }, list), {
    model: 'kimi-k3',
    provider: 'command-code',
  });
  assert.deepEqual(await resolveRequestedModel({ model: 'Claude Opus 5.5' }, list), {
    model: 'claude-opus-5-5',
    provider: 'anthropic-oauth',
  });
  assert.deepEqual(await resolveRequestedModel({ model: 'sonnet 5.5', provider: 'Command Code' }, list), {
    model: 'claude-sonnet-5-5',
    provider: 'command-code',
  });
});

test('a literal id wins over ids that only collide once normalized', async () => {
  const rows = [
    { provider: 'custom-x', id: 'foo-bar', display: 'Foo Bar' },
    { provider: 'custom-x', id: 'foo_bar', display: 'Foo Bar' },
  ];
  const { list, calls } = catalog(rows);
  assert.deepEqual(await resolveRequestedModel({ model: 'foo-bar', provider: 'custom-x' }, list), {
    model: 'foo-bar',
    provider: 'custom-x',
  });
  assert.deepEqual(await resolveRequestedModel({ model: 'foo_bar' }, list), { model: 'foo_bar', provider: 'custom-x' });
  assert.deepEqual(calls, ['cache', 'cache']);
  // A non-literal spelling still matches both and stays ambiguous.
  await assert.rejects(
    resolveRequestedModel({ model: 'FOO-BAR' }, list),
    /ambiguous: custom-x\/foo-bar, custom-x\/foo_bar/
  );
});

test('ambiguous names fail with candidates instead of picking one', async () => {
  const { list } = catalog();
  await assert.rejects(
    resolveRequestedModel({ model: 'sonnet 5.5' }, list),
    /ambiguous: anthropic-oauth\/claude-sonnet-5-5, command-code\/claude-sonnet-5-5/
  );
  await assert.rejects(resolveRequestedModel({ model: 'opus', provider: 'anthropic-oauth' }, list), /ambiguous/);
});

test('a cache miss retries once on a refreshed catalog', async () => {
  const fresh = [...ROWS, { provider: 'command-code', id: 'kimi-k4', display: 'Kimi K4' }];
  const { list, calls } = catalog(fresh, ROWS);
  assert.deepEqual(await resolveRequestedModel({ model: 'kimi k4' }, list), {
    model: 'kimi-k4',
    provider: 'command-code',
  });
  assert.deepEqual(calls, ['cache', 'force']);
});

test('unknown model or provider fails without substitution', async () => {
  const { list, calls } = catalog();
  await assert.rejects(
    resolveRequestedModel({ model: 'gpt-9', provider: 'command-code' }, list),
    /not found; available: command-code\/claude-sonnet-5-5, command-code\/kimi-k3/
  );
  assert.deepEqual(calls, ['cache', 'force']);
  await assert.rejects(resolveRequestedModel({ model: 'kimi', provider: 'nope' }, list), /has no available models/);
});

test('a query with no matchable characters matches nothing, even with a single model', async () => {
  const only = [ROWS[4]];
  await assert.rejects(resolveRequestedModel({ model: '???' }, catalog(only).list), /"\?\?\?" not found/);
  await assert.rejects(resolveRequestedModel({ model: ' - ' }, catalog().list), /not found/);
});

test('a punctuation-only model is refused with or without a catalog', async () => {
  await assert.rejects(
    resolveRequestedModel({ provider: 'command-code', model: '???' }, null),
    /"\?\?\?" for provider "command-code" not found/
  );
  await assert.rejects(
    resolveRequestedModel({ provider: 'command-code', model: '???' }, catalog().list),
    /"\?\?\?" for provider "command-code" not found/
  );
});

test('without a catalog only exact provider + model pass through', async () => {
  const args = { model: 'kimi-k3', provider: 'command-code' };
  assert.equal(await resolveRequestedModel(args, null), args);
  await assert.rejects(resolveRequestedModel({ model: 'kimi-k3' }, null), /requires provider/);
});
