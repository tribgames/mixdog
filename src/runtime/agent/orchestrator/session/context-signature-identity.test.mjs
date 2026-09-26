// Transcript signatures (exact and storage-shape) are persisted as provider
// baseline anchors, so their values must never shift. EXPECTED was captured
// from the implementation that serialized each identity with JSON.stringify
// and normalized shape text with String#replace/trim; the streaming
// serializer and the recent-state chain must reproduce it exactly, including
// across in-place tail edits and prefix checks behind the tail.
import assert from 'node:assert/strict';
import test from 'node:test';

import { contextMessagesShapeSignature, contextMessagesSignature, estimateMessagesTokens } from './context-utils.mjs';

const TRICKY = [
  'plain ascii text',
  'quote " backslash \\ slash / tab\there',
  'controls \b\f\n\r\t \u0000 \u0001 \u001f \u007f end',
  'crlf\r\nline\r\n\r\n  indented\n\n\nblank lines',
  '  leading and trailing whitespace \t\n ',
  'nbsp\u00a0ogham\u1680en\u2002thin\u2009ls\u2028ps\u2029nnbsp\u202fmmsp\u205fideo\u3000bom\ufeffend',
  '한국어 세션 텍스트, latin é ß, emoji 😀👍🏽, astral 𠜎',
  'lone \ud800 high, lone \udfff low, reversed \ude00\ud83d, trailing \ud800',
  'see [Image omitted from stored history: image/png] here',
  '[Image omitted from stored history]',
  'two [Image omitted from stored history: a][File omitted from stored history: b.pdf] adjacent',
  '  [File omitted from stored history: x]  spaced  [Image omitted from stored history]  ',
  'unterminated [Image omitted from stored history: never closed',
  'nested [Image omitted from stored history [inner] tail] after',
  '[image omitted from stored history: wrong case] [Image  omitted from stored history]',
  'brackets [ and ] alone [File omitted from stored history\nmultiline\n] done',
  '\u2028\u2029',
  '',
];

function transcript() {
  const messages = [{ role: 'system', content: '# Rules\n- keep going' }];
  for (let index = 0; messages.length < 150; index += 1) {
    const text = TRICKY[index % TRICKY.length];
    const id = `call-${index}`;
    messages.push(
      {
        role: 'user',
        content:
          index % 3 === 0
            ? [
                { type: 'text', text },
                { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', width: 64, height: 32 },
              ]
            : text,
      },
      {
        role: 'assistant',
        content: `${text} answer`,
        toolCalls: [{ id, name: 'read', arguments: { path: `f-${index}`, note: text } }],
        providerReplay: {
          items: [
            { type: 'thinking', thinking: `think ${text}`, signature: 'S'.repeat(90) },
            { type: 'tool_use', id, name: 'read', input: { path: `f-${index}` } },
          ],
        },
      },
      { role: 'tool', toolCallId: id, content: `result ${index}\n${text}` }
    );
  }
  return messages.slice(0, 150);
}

const COUNTS = [0, 1, 2, 63, 64, 65, 100, 127, 128, 129, 149, 150];

function signatures(list) {
  return COUNTS.map((count) => [
    contextMessagesSignature(list, count).slice(0, 16),
    contextMessagesShapeSignature(list, count).slice(0, 16),
  ]);
}

const EXPECTED = {
  signatures: [
    ['e3b0c44298fc1c14', 'e3b0c44298fc1c14'],
    ['f599657bdf8bc90f', '2b5bd21e9ec2c425'],
    ['c5b30558c211e30d', '1d8524a9f6eeaa61'],
    ['73dff092080a7146', '7638cb49a72b5b42'],
    ['2cd2846aeaecb55b', '1844b1f6bbe113f5'],
    ['1eae1675f332883f', 'f0c40f375127b40e'],
    ['aecde85bb5dd0264', 'c9940d1d4d14a7cd'],
    ['0ad9bedfea95d7be', 'e32ce099af3bb938'],
    ['653dfd07cefa0e63', '85543dc5d23baaf0'],
    ['0f451ad1cc75b586', '1a508f4c9e2bafad'],
    ['0d0e769cf8b76493', 'f6fad764bc9453a1'],
    ['e1c19ecafc65b5e4', 'ba9b1af0c146969c'],
  ],
  tokens: 9_271,
};

test('exact and shape signatures equal the JSON.stringify/replace implementation', () => {
  const actual = { signatures: signatures(transcript()), tokens: estimateMessagesTokens(transcript()) };
  if (process.env.MIXDOG_PRINT_SIGNATURES === '1') console.log(JSON.stringify(actual));
  assert.deepEqual(actual, EXPECTED);
});

test('tail edits and prefix checks behind the tail keep chained signatures exact', () => {
  const live = transcript();
  signatures(live);
  const assistant = live.findLast((message) => message.role === 'assistant');
  for (let round = 0; round < 6; round += 1) {
    // Stored-tool-args style in-place restore of the latest call, then new
    // turn messages appended in place, then checks at and behind the tail.
    assistant.toolCalls[0].arguments = { path: `restored-${round}`, round };
    live.push({ role: 'user', content: `follow-up ${round} ${TRICKY[round]}` });
    live.push({ role: 'assistant', content: `reply ${round}` });
    for (const count of [live.length, live.length - 1, live.length - 5, live.length - 40, 64, 20]) {
      const fresh = structuredClone(live);
      assert.equal(contextMessagesSignature(live, count), contextMessagesSignature(fresh, count));
      assert.equal(contextMessagesShapeSignature(live, count), contextMessagesShapeSignature(fresh, count));
    }
  }
});
