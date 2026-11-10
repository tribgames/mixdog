import assert from 'node:assert/strict';
import test from 'node:test';

import { readTopLevelFields } from './store-agent-worker-header.mjs';

const FIELDS = ['title', 'updatedAt', 'status', 'totalInputTokens', 'fast', 'cwd', 'owner', 'nested', 'missing'];

/** The reference the scanner must reproduce: a full parse, then the pick. */
function picked(text, fields = FIELDS) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const out = {};
  for (const field of fields) if (Object.hasOwn(doc, field)) out[field] = doc[field];
  return out;
}

const scan = (text, fields = FIELDS) => readTopLevelFields(Buffer.from(text, 'utf8'), fields);

function transcript(seed) {
  const messages = [];
  for (let n = 0; n < 40; n++) {
    messages.push(
      n % 2
        ? {
            role: 'assistant',
            content: [
              { type: 'text', text: `답변 ${seed}-${n} 🐶 "quoted" \\ back\\\\ {brace} [bracket] }]` },
              { type: 'tool_use', id: `c${n}`, input: { raw: JSON.stringify({ a: [n, { b: '"}]\\' }] }) } },
            ],
          }
        : { role: 'user', content: `line\nbreak\ttab \u2028 \ud83d\ude00 ${'x'.repeat(n * 7)}` }
    );
  }
  return messages;
}

function documentOf(seed) {
  return {
    id: `sess_${seed}`,
    messages: transcript(seed),
    title: seed % 3 ? `Title ${seed} "q" \\` : null,
    updatedAt: 1_792_300_000_000 + seed,
    status: ['idle', 'running', 'cancel-unconfirmed'][seed % 3],
    totalInputTokens: seed % 4 ? seed * 1.5e3 : -0,
    fast: seed % 2 === 0,
    cwd: 'C:\\Project\\mixdog',
    nested: { list: [1, -2.5e-3, true, null, { k: '}' }], empty: {}, arr: [] },
    tools: [{ name: 'read', schema: { type: 'object', properties: { '"odd key"': {} } } }],
    ...(seed % 5 === 0 ? {} : { owner: 'agent' }),
  };
}

test('top-level fields equal the full parse for serialized, pretty and spaced documents', () => {
  for (let seed = 0; seed < 30; seed++) {
    const doc = documentOf(seed);
    for (const text of [
      JSON.stringify(doc),
      JSON.stringify(doc, null, 2),
      ` \r\n\t${JSON.stringify(doc, null, '\t')}\n `,
    ]) {
      assert.deepEqual(scan(text), picked(text), `seed ${seed}`);
    }
  }
});

test('duplicate keys resolve last-wins, escaped keys decode, and output follows the field order', () => {
  const cases = [
    '{"title":"first","messages":[],"title":"last"}',
    '{"ti\\u0074le":"escaped key","updatedAt":1}',
    '{"updatedAt":2,"title":"t","status":"s"}',
    '{"title":"a\\\\","status":"b\\\\\\"c"}',
    '{}',
    '[]',
    '[{"title":"array root"}]',
    '{"title":{"title":"inner"},"messages":[{"title":"msg"}]}',
  ];
  for (const text of cases) {
    const result = scan(text);
    assert.deepEqual(result, picked(text), text);
    if (result) assert.deepEqual(Object.keys(result), Object.keys(picked(text)), text);
  }
});

test('documents a full parse rejects, and non-container roots, read as null', () => {
  const rejected = [
    '',
    '   ',
    'null',
    '42',
    '"text"',
    '\ufeff{"title":"bom"}',
    '{"title":"a"}x',
    '{"title":"a"} {}',
    '{"title":"a",}',
    '{,"title":"a"}',
    '{"title" "a"}',
    '{"title":"a" "status":"b"}',
    '{"title":}',
    '{"messages":[}],"title":"a"}',
    '{"messages":[{"a":1]],"title":"a"}',
    '{"messages":[1,2,"title":"a"}',
    '{"title":tru}',
    '{"title":"unterminated}',
    '{title:"a"}',
    '{"messages":[@],"title":"a"}',
  ];
  for (const text of rejected) {
    assert.equal(picked(text), null, `fixture must have no fields: ${text}`);
    assert.equal(scan(text), null, text);
  }
});

test('faults inside skipped values decide exactly as the full parse does', () => {
  // The strict-scan suite's malformed and ambiguous records, with their
  // faults inside values the pool never reads.
  const cases = [
    '{"id":"x","messages":[tru]}',
    '{"title":"a","messages":[nul]}',
    '{"title":"a","messages":[fals]}',
    '{"title":"a","title":"b"}',
    '{"title":"a","messages":[],"messages":[1]}',
    '{"title":"a","nested":{"k":1,"k":2}}',
    '{"ti\\u0074le":"escaped key"}',
    '{"__proto__":{"polluted":true},"title":"a"}',
    '{"title":"a","s":"bad \\x escape"}',
    '{"title":"a","s":"short \\u12 escape"}',
    '{"title":"a","s":"ok \\\\x pair"}',
    '{"title":"a","s":"raw\u0001control"}',
    '{"title":"a","s":"raw\ttab"}',
    '{"title":"a"}\n',
    '{"title":"a","n":01}',
    '{"title":"a","n":1.}',
    '{"title":"a","n":-}',
    '{"title":"a","n":1e}',
    '{"title":"a","n":1e+5,"m":-0,"o":0.25E-2}',
    '{"title":"a","messages":[1 2]}',
    '{"title":"a","messages":[1,]}',
    '{"title":"a","messages":[{"a" 1}]}',
    '{"title":"a","messages":[{1:2}]}',
    '{"title":"a","messages":[[}]]}',
    '{"title":"a","tools":[\\]}',
    '{"title":"a","messages":[{"a":1,}]}',
    '{"title":"a","messages":[,1]}',
    '[{"title":"array root"},tru]',
  ];
  for (const text of cases) assert.deepEqual(scan(text), picked(text), text);
});

test('every truncation of a record reads as null', () => {
  const text = JSON.stringify(documentOf(7));
  for (let end = 0; end < text.length; end++) assert.equal(scan(text.slice(0, end)), null, `prefix ${end}`);
  assert.deepEqual(scan(text), picked(text));
});

test('single-character edits read exactly what the full parse reads, rejections included', () => {
  const text = JSON.stringify({
    messages: [
      { role: 'user', a: 'x"y', b: [1, { c: '}' }, true, null, -1.5e3] },
      { role: 'tool', c: ['x', { y: false }] },
    ],
    title: 'abc',
    updatedAt: 12,
    status: 'ok',
  });
  const alphabet = [
    '"',
    '\\',
    '{',
    '}',
    '[',
    ']',
    ',',
    ':',
    ' ',
    '\n',
    '0',
    '1',
    'a',
    'e',
    'E',
    '-',
    '+',
    '.',
    'u',
    't',
  ];
  for (let at = 0; at < text.length; at++) {
    for (const ch of alphabet) {
      for (const edited of [text.slice(0, at) + ch + text.slice(at + 1), text.slice(0, at) + ch + text.slice(at)]) {
        assert.deepEqual(scan(edited), picked(edited), edited);
      }
    }
  }
});

test('every truncation of a record with literals and numbers reads as null', () => {
  const text = JSON.stringify({ messages: [{ role: 'tool', v: [true, false, null, 0, -2.5e-3] }], title: 't' });
  for (let end = 0; end < text.length; end++) assert.equal(scan(text.slice(0, end)), null, `prefix ${end}`);
});
