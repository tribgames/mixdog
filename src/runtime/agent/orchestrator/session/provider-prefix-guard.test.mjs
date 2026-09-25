import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareProviderPrefixGuard, ProviderPrefixMutationError } from './provider-prefix-guard.mjs';

const CACHE_PROVIDERS = [
  'anthropic',
  'anthropic-oauth',
  'openai',
  'openai-oauth',
  'xai',
  'grok-oauth',
  'gemini',
  'deepseek',
  'opencode-go',
  'cursor-oauth',
  'mixdog-local',
];

test('accepts append-only provider history for every provider surface', () => {
  for (const provider of CACHE_PROVIDERS) {
    const first = prepareProviderPrefixGuard(
      null,
      [{ role: 'user', content: 'one' }],
      { tools: [{ name: 'read' }], nativeTools: [] },
      { provider }
    );
    assert.doesNotThrow(
      () =>
        prepareProviderPrefixGuard(
          first,
          [
            { role: 'user', content: 'one' },
            { role: 'assistant', content: 'two' },
          ],
          { tools: [{ name: 'read' }], nativeTools: [] },
          { provider }
        ),
      provider
    );
  }
});

test('rejects prior-message rewrites outside compaction', () => {
  const first = prepareProviderPrefixGuard(null, [{ role: 'user', content: 'one' }], {
    tools: [{ name: 'read' }],
    nativeTools: [],
  });
  assert.throws(
    () =>
      prepareProviderPrefixGuard(first, [{ role: 'user', content: 'rewritten' }], {
        tools: [{ name: 'read' }],
        nativeTools: [],
      }),
    ProviderPrefixMutationError
  );
});

test('rebaselines tool-prefix changes while preserving transcript integrity checks', () => {
  const first = prepareProviderPrefixGuard(null, [{ role: 'user', content: 'one' }], {
    tools: [{ name: 'read' }],
    nativeTools: [],
  });
  const changed = prepareProviderPrefixGuard(first, [{ role: 'user', content: 'one' }], {
    tools: [{ name: 'read' }, { name: 'shell' }],
    nativeTools: [],
  });
  assert.notEqual(changed.requestPrefixHash, first.requestPrefixHash);
  assert.doesNotThrow(() =>
    prepareProviderPrefixGuard(
      changed,
      [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
      ],
      { tools: [{ name: 'read' }, { name: 'shell' }], nativeTools: [] }
    )
  );
  assert.throws(
    () =>
      prepareProviderPrefixGuard(changed, [{ role: 'user', content: 'rewritten' }], {
        tools: [{ name: 'read' }, { name: 'shell' }],
        nativeTools: [],
      }),
    ProviderPrefixMutationError
  );
});

// Oracle: structuredClone gives fresh objects that can never hit the digest
// memo, so it reproduces the unmemoized stringify+sha256 verdict exactly.
function guardVerdict(previous, messages, options = {}) {
  const breaks = [];
  const prefix = { tools: [{ name: 'read' }], nativeTools: [] };
  try {
    const state = prepareProviderPrefixGuard(previous, messages, prefix, {
      ...options,
      onCacheBreak: (details) => breaks.push(details),
    });
    return { state, breaks, error: null };
  } catch (error) {
    assert.ok(error instanceof ProviderPrefixMutationError);
    return { state: null, breaks, error: { message: error.message, details: error.details } };
  }
}

function assertSameVerdict(previous, messages, options, name) {
  const actual = guardVerdict(previous, messages, options);
  const expected = guardVerdict(previous, structuredClone(messages), options);
  assert.deepEqual(actual, expected, name);
  return actual;
}

function history() {
  return [
    { role: 'system', content: 'rules\n<manifest>tools</manifest>' },
    { role: 'user', content: [{ type: 'text', text: 'one' }] },
    { role: 'assistant', content: 'two', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] },
    { role: 'tool', toolCallId: 'c1', content: 'file body' },
  ];
}

test('memoized digests keep verdicts identical for appended, edited and reordered histories', () => {
  const scenarios = [
    ['append', (m) => [...m, { role: 'user', content: 'three' }]],
    ['in-place top-level edit', (m) => ((m[0].content = 'rules'), m)],
    ['in-place nested edit', (m) => ((m[1].content[0].text = 'rewritten'), m)],
    ['in-place nested append', (m) => (m[2].toolCalls.push({ id: 'c2', name: 'shell' }), m)],
    ['in-place key added', (m) => ((m[3].meta = { source: 'x' }), m)],
    ['in-place key reorder', (m) => {
      const { role, ...rest } = m[2];
      for (const key of Object.keys(m[2])) delete m[2][key];
      Object.assign(m[2], rest, { role });
      return m;
    }],
    ['in-place equal-content rewrite', (m) => ((m[3].content = ['file', 'body'].join(' ')), m)],
    ['replaced object', (m) => [m[0], { ...m[1], content: 'other' }, m[2], m[3]]],
    ['reordered', (m) => [m[0], m[2], m[1], m[3]]],
    ['shrink', (m) => m.slice(0, 2)],
  ];
  for (const [name, mutate] of scenarios) {
    for (const options of [{}, { cacheBreakIntent: 'manual_compaction' }]) {
      const messages = history();
      const first = assertSameVerdict(null, messages, options, name);
      // Warm the memo with a settled request before mutating.
      const settled = assertSameVerdict(first.state, messages, options, name);
      assertSameVerdict(settled.state, mutate(messages), options, name);
    }
  }
});

test('repeated requests with an appended message hash only the new messages', () => {
  const messages = history();
  const tracked = new Set(messages);
  const hashed = [];
  const stringify = JSON.stringify;
  JSON.stringify = function (value, ...rest) {
    if (tracked.has(value)) hashed.push(value);
    return stringify.call(this, value, ...rest);
  };
  try {
    let state = guardVerdict(null, messages).state;
    assert.equal(hashed.length, messages.length);
    for (let round = 0; round < 3; round += 1) {
      hashed.length = 0;
      const appended = { role: 'assistant', content: `turn ${round}` };
      tracked.add(appended);
      messages.push(appended);
      const verdict = guardVerdict(state, messages);
      assert.equal(verdict.error, null);
      assert.deepEqual(hashed, [appended]);
      state = verdict.state;
    }
    hashed.length = 0;
    messages[1].content[0].text = 'edited in place';
    const verdict = guardVerdict(state, messages);
    assert.deepEqual(hashed, [messages[1]]);
    assert.equal(verdict.error.details.reason, 'message_prefix');
    assert.equal(verdict.error.details.index, 1);
  } finally {
    JSON.stringify = stringify;
  }
});

test('allows only compaction intents to establish a new prefix', () => {
  const first = prepareProviderPrefixGuard(null, [{ role: 'user', content: 'one' }], {
    tools: [{ name: 'read' }],
    nativeTools: [],
  });
  for (const cacheBreakIntent of [
    'automatic_compaction',
    'deferred_body_compaction',
    'manual_compaction',
    'post_turn_compaction',
  ]) {
    assert.doesNotThrow(() =>
      prepareProviderPrefixGuard(
        first,
        [{ role: 'user', content: 'compacted' }],
        { tools: [{ name: 'read' }], nativeTools: [] },
        { cacheBreakIntent }
      )
    );
  }
  assert.throws(
    () =>
      prepareProviderPrefixGuard(
        first,
        [{ role: 'user', content: 'repaired' }],
        { tools: [{ name: 'read' }], nativeTools: [] },
        { cacheBreakIntent: 'transcript_rebuild' }
      ),
    ProviderPrefixMutationError
  );
});
