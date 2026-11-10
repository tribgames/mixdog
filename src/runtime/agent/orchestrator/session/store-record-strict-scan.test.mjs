import assert from 'node:assert/strict';
import test from 'node:test';

import { isLifecycleUnreadable, readTopLevelLifecycleRecord } from './lifecycle-scan.mjs';
import { readStrictRecordFields } from './store-record-strict-scan.mjs';

const OPTIONS = { skip: new Set(['tools', 'catalog']), fullMessageRoles: new Set(['user']) };

/** What a consumer may read of a record: non-skipped top-level fields, full
 *  user messages, and only `role` of every other object message. */
function visible(record) {
  if (isLifecycleUnreadable(record)) return 'unreadable';
  const doc = {};
  for (const [key, value] of Object.entries(record.doc)) {
    if (OPTIONS.skip.has(key)) continue;
    doc[key] =
      key === 'messages' && Array.isArray(value)
        ? value.map((message) => {
            if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
            if (OPTIONS.fullMessageRoles.has(message.role)) return message;
            return Object.hasOwn(message, 'role') ? { role: message.role } : {};
          })
        : value;
  }
  return { id: record.id, closed: record.closed, generation: record.generation, doc };
}

/** The strict read and the authority agree on the verdict and every visible value. */
function assertAgrees(text, label = text) {
  const expected = visible(readTopLevelLifecycleRecord(text));
  assert.deepEqual(visible(readStrictRecordFields(Buffer.from(text, 'utf8'), OPTIONS)), expected, label);
  return expected;
}

function record(seed) {
  return {
    id: `sess_${seed}`,
    generation: seed,
    closed: seed % 4 === 0,
    title: `제목 ${seed} "q" \\ 🐶`,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: `hello ${seed} \u2028 \ud83d\ude00`, meta: { source: seed % 2 ? 'import' : '' } },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', input: { raw: JSON.stringify({ a: '"}]\\', b: [1, -2.5e-3] }) } }],
      },
      { role: 'tool', content: 'x\\"y'.repeat(seed) },
      'bare string',
      7,
      null,
      [1, { role: 'user' }],
      {},
      { content: 'no role' },
    ],
    tools: [{ name: 'skipped', schema: { type: 'object' } }],
    catalog: { big: 'skipped'.repeat(10) },
    nested: { list: [true, false, null, 0, -0.5, 1e21, { k: {} }], empty: [] },
  };
}

test('records the full parse accepts read the same verdict and values, either path', () => {
  for (let seed = 0; seed < 25; seed++) {
    const text = JSON.stringify(record(seed));
    assert.notEqual(assertAgrees(text), 'unreadable');
    // A serialized record is proven on the fast path: skipped fields stay undecoded.
    assert.equal(Object.hasOwn(readStrictRecordFields(Buffer.from(text), OPTIONS).doc, 'tools'), false);
    // Pretty-printed records take the authoritative path and still agree.
    assertAgrees(JSON.stringify(record(seed), null, 2));
  }
});

test('ambiguous, mistyped and malformed records are unreadable exactly when the authority says so', () => {
  const cases = [
    '{"id":"a","id":"b"}',
    '{"id":"a","messages":[],"messages":[]}',
    '{"id":"a","tools":1,"tools":2}',
    '{"id":"a","messages":[{"role":"tool","role":"user","content":"last wins"}]}',
    '{"id":"a","nested":{"k":1,"k":2}}',
    '{"id":5}',
    '{"id":""}',
    '{"id":"a","closed":"yes"}',
    '{"id":"a","generation":"1"}',
    '{"ti\\u0074le":"escaped key","id":"a"}',
    '{"__proto__":{"polluted":true},"id":"a"}',
    '{"id":"a","messages":{"not":"array"}}',
    '{"id":"a","messages":[{"r\\u006fle":"user","content":"escaped role key"}]}',
    '{"id":"a","s":"bad \\x escape"}',
    '{"id":"a","s":"short \\u12 escape"}',
    '{"id":"a","s":"ok \\\\x pair"}',
    '{"id":"a","s":"raw\u0001control"}',
    '{"id":"a","s":"raw\ttab"}',
    '{"id":"a"}\n',
    '{"id":"a", "n": 01}',
    '{"id":"a","n":1.}',
    '{"id":"a","n":-}',
    '{"id":"a","n":1e}',
    '{"id":"a","n":1e+5,"m":-0,"o":0.25E-2}',
    '{"id":"a","t":tru}',
    '{"id":"a","messages":[1 2]}',
    '{"id":"a","messages":[1,]}',
    '{"id":"a","messages":[{"a" 1}]}',
    '{"id":"a","messages":[{1:2}]}',
    '{"id":"a","messages":[[}]]}',
    '{"id":"a","tools":[\\]}',
    '{"id":"a",}',
    '{"id":"a"} x',
    '\ufeff{"id":"a"}',
    '[{"id":"a"}]',
    '"a"',
    '',
  ];
  for (const text of cases) assertAgrees(text);
});

test('every truncation of a record is unreadable', () => {
  const text = JSON.stringify(record(3));
  for (let end = 0; end < text.length; end++) {
    assert.equal(visible(readStrictRecordFields(Buffer.from(text.slice(0, end)), OPTIONS)), 'unreadable', `${end}`);
  }
});

test('single-character edits keep the verdict and values of the authority', () => {
  const text = JSON.stringify({
    id: 'e',
    generation: 1,
    messages: [
      { role: 'user', content: 'a"b' },
      { role: 'tool', content: ['x', { y: 1.5 }] },
    ],
    tools: [1],
  });
  const alphabet = ['"', '\\', '{', '}', '[', ']', ',', ':', ' ', '\n', '0', '1', 'e', '-', '.', 'u', 't', 'x'];
  for (let at = 0; at < text.length; at++) {
    for (const ch of alphabet) {
      assertAgrees(text.slice(0, at) + ch + text.slice(at + 1));
      assertAgrees(text.slice(0, at) + ch + text.slice(at));
    }
  }
});
