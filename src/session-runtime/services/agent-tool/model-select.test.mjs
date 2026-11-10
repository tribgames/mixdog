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
  // The literal id inside its named provider is taken from the quick read; an
  // unnamed provider waits for the full catalog.
  assert.deepEqual(calls, ['cache', 'cache', 'cache']);
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
  assert.deepEqual(calls, ['cache', 'cache', 'force']);
});

// A catalog reader that records its options and settles each forced read on
// demand. `loaded` says whether the quick read is answered from the loaded
// catalog (rows marked complete); `full` is the authoritative read and `fresh`
// the forced one.
function countingCatalog({ hold = false, quick = ROWS, loaded = true, full = ROWS, fresh = ROWS } = {}) {
  const reads = [];
  const gates = [];
  const list = (options = {}) => {
    reads.push(options);
    if (options.force === true) {
      if (!hold) return Promise.resolve(fresh);
      const gate = Promise.withResolvers();
      gates.push(() => gate.resolve(fresh));
      return gate.promise;
    }
    if (options.quick === true) {
      return Promise.resolve(loaded ? quick.map((row) => ({ ...row, catalogComplete: true })) : quick);
    }
    return Promise.resolve(full);
  };
  const forced = () => reads.filter((options) => options.force === true);
  return {
    list,
    reads,
    forced,
    release: () => {
      for (const open of gates.splice(0)) open();
    },
  };
}

const FOO = [
  { provider: 'custom-x', id: 'foo-bar', display: 'Foo Bar' },
  { provider: 'custom-x', id: 'foo_bar', display: 'Foo Bar 2' },
];

test('an incomplete quick catalog cannot hand out a normalized look-alike of a literal id', async () => {
  // The quick rows hold only `foo-bar`; the full catalog also has the literal `foo_bar`.
  const { list, reads } = countingCatalog({ loaded: false, quick: [FOO[0]], full: FOO });
  assert.deepEqual(await resolveRequestedModel({ model: 'foo_bar', provider: 'custom-x' }, list), {
    model: 'foo_bar',
    provider: 'custom-x',
  });
  assert.deepEqual(reads, [{ quick: true }, {}]);
});

test('an incomplete quick catalog cannot hide an ambiguity behind a word match', async () => {
  const { list, reads } = countingCatalog({ loaded: false, quick: [ROWS[1]], full: ROWS });
  await assert.rejects(
    resolveRequestedModel({ model: 'opus', provider: 'anthropic-oauth' }, list),
    /ambiguous: anthropic-oauth\/claude-opus-5-5, anthropic-oauth\/claude-opus-5-1/
  );
  assert.deepEqual(reads, [{ quick: true }, {}]);
});

test('an incomplete quick catalog hit by display name, normalized id, or without a provider waits for the full catalog', async () => {
  for (const args of [
    { model: 'Kimi K3', provider: 'command-code' },
    { model: 'KIMI-K3', provider: 'command-code' },
    { model: 'kimi-k3' },
    { model: 'kimi-k3', provider: 'command' },
  ]) {
    const { list, reads } = countingCatalog({ loaded: false });
    assert.deepEqual(await resolveRequestedModel(args, list), { model: 'kimi-k3', provider: 'command-code' });
    assert.deepEqual(reads, [{ quick: true }, {}], JSON.stringify(args));
  }
});

test('an incomplete quick catalog still answers a literal id inside an exact, named provider', async () => {
  const { list, reads } = countingCatalog({ loaded: false });
  assert.deepEqual(await resolveRequestedModel({ model: 'kimi-k3', provider: 'Command Code' }, list), {
    model: 'kimi-k3',
    provider: 'command-code',
  });
  assert.deepEqual(reads, [{ quick: true }]);
});

test('a partial quick catalog is incomplete too', async () => {
  const partial = ROWS.map((row) => ({ ...row, catalogPartial: true, catalogMissing: ['x'], catalogRetryAt: 1 }));
  const { list, reads } = countingCatalog({ loaded: false, quick: partial });
  assert.deepEqual(await resolveRequestedModel({ model: 'kimi k3' }, list), {
    model: 'kimi-k3',
    provider: 'command-code',
  });
  assert.deepEqual(reads, [{ quick: true }, {}]);
});

test('a catalog hit reads only the quick catalog: no authoritative wait, no refresh', async () => {
  const { list, reads } = countingCatalog();
  assert.deepEqual(await resolveRequestedModel({ model: 'kimi-k3', provider: 'command-code' }, list), {
    model: 'kimi-k3',
    provider: 'command-code',
  });
  assert.deepEqual(reads, [{ quick: true }]);
});

test('a miss makes exactly one refresh, scoped to the requested provider', async () => {
  const fresh = [...ROWS, { provider: 'command-code', id: 'kimi-k4', display: 'Kimi K4' }];
  const { list, reads, forced } = countingCatalog({ fresh });
  assert.deepEqual(await resolveRequestedModel({ model: 'kimi k4', provider: 'command-code' }, list), {
    model: 'kimi-k4',
    provider: 'command-code',
  });
  assert.deepEqual(reads, [{ quick: true }, { force: true, provider: 'command-code' }]);
  assert.equal(forced().length, 1);
  // Without a provider the refresh is unscoped.
  const unscoped = countingCatalog();
  await assert.rejects(resolveRequestedModel({ model: 'gpt-9' }, unscoped.list), /not found/);
  assert.deepEqual(unscoped.forced(), [{ force: true }]);
});

test('concurrent misses coalesce into one refresh', async () => {
  const fresh = [...ROWS, { provider: 'command-code', id: 'kimi-k4', display: 'Kimi K4' }];
  const { list, forced, release } = countingCatalog({ fresh, hold: true });
  const pending = [
    resolveRequestedModel({ model: 'kimi-k4', provider: 'command-code' }, list),
    resolveRequestedModel({ model: 'kimi k4', provider: 'command-code' }, list),
    resolveRequestedModel({ model: 'gpt-9', provider: 'Command Code' }, list),
  ].map((call) =>
    call.then(
      (route) => route.model,
      (err) => err.message
    )
  );
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
  release();
  const [first, second, third] = await Promise.all(pending);
  assert.equal(forced().length, 1);
  assert.equal(first, 'kimi-k4');
  assert.equal(second, 'kimi-k4');
  assert.match(third, /"gpt-9" for provider "Command Code" not found/);
});

test('nothing is remembered: a sequential repeat of a miss refreshes again, and a new model is found at once', async () => {
  const { list, forced } = countingCatalog();
  const args = { model: 'my-custom', provider: 'command-code' };
  await assert.rejects(resolveRequestedModel(args, list), /not found/);
  await assert.rejects(resolveRequestedModel(args, list), /not found/);
  assert.equal(forced().length, 2);
  const added = countingCatalog({ fresh: [...ROWS, { provider: 'command-code', id: 'my-custom', display: 'Mine' }] });
  assert.deepEqual(await resolveRequestedModel(args, added.list), { model: 'my-custom', provider: 'command-code' });
});

test('a failed refresh does not poison the next one', async () => {
  let failing = true;
  const list = async (options = {}) => {
    if (options.force !== true) return ROWS;
    if (failing) throw new Error('refresh down');
    return [...ROWS, { provider: 'command-code', id: 'kimi-k4', display: 'Kimi K4' }];
  };
  const args = { model: 'kimi-k4', provider: 'command-code' };
  await assert.rejects(resolveRequestedModel(args, list), /refresh down/);
  failing = false;
  assert.equal((await resolveRequestedModel(args, list)).model, 'kimi-k4');
});

test('unknown model or provider fails without substitution', async () => {
  const { list, calls } = catalog();
  await assert.rejects(
    resolveRequestedModel({ model: 'gpt-9', provider: 'command-code' }, list),
    /not found; available: command-code\/claude-sonnet-5-5, command-code\/kimi-k3/
  );
  assert.deepEqual(calls, ['cache', 'cache', 'force']);
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
