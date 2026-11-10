import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { SCHEMA_SQL, UPSERT_SQL, rowFromDb, rowSignature, upsertParams } from './catalog-db/schema.mjs';
import { normalizedRow } from './store-summary-catalog.mjs';
import { _sessionSummary } from './store-summary-index.mjs';
import { incomingTailOf } from './store-summary-last-message.mjs';
import { routineResultMessage } from './routine-result.mjs';
import { leadSessionRow } from '../../../../session-runtime/lifecycle/session-catalog.mjs';

const user = (text) => ({ role: 'user', content: text });
const reply = (text) => ({ role: 'assistant', content: text });
const toolCall = (id, narration = '') => ({
  role: 'assistant',
  content: narration,
  toolCalls: [{ id, name: 'read', arguments: {} }],
});
const toolUse = (id) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'read', input: {} }] });
const toolResult = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] });

/** One reply that used three tools, in both stored shapes. */
const reply3Tools = (text) => [
  toolCall('a', 'Let me look.'),
  { role: 'tool', toolCallId: 'a', content: 'ok' },
  toolUse('b'),
  toolResult('b'),
  toolUse('c'),
  toolResult('c'),
  reply(text),
];

test('one reply that used three tools is one incoming message', () => {
  const messages = [user('Check it'), ...reply3Tools('All good.')];
  const row = _sessionSummary({ id: 'sess_home_lead', messages });
  assert.ok(row.messageCount > 5, 'the raw count includes every tool turn');
  assert.deepEqual(row.incomingTail, [row.messageCount]);
  assert.deepEqual(incomingTailOf(messages), row.incomingTail);
  messages.push(user('Thanks'), ...reply3Tools('Done.'));
  const next = _sessionSummary({ id: 'sess_home_lead', messages });
  assert.equal(next.incomingTail.length, 2, 'two replies are two');
  assert.equal(next.incomingTail.at(-1), next.messageCount);
});

test("the user's own prompts never count; a posted result or bot message counts once", () => {
  const messages = [
    user('Hello'),
    reply('Hi'),
    user('and now?'),
    routineResultMessage({ name: 'daily', ok: true, text: 'All green.', messageId: 'm1' }),
  ];
  assert.deepEqual(_sessionSummary({ id: 'sess_home_lead', messages }).incomingTail, [2, 4]);
});

test('only a bot home or a room log carries the tail', () => {
  const messages = [user('Hello'), reply('Hi')];
  assert.equal(Object.hasOwn(_sessionSummary({ id: 'sess_plain', messages }), 'incomingTail'), false);
  assert.deepEqual(_sessionSummary({ id: 'sess_home_translator', messages }).incomingTail, [2]);
  assert.deepEqual(_sessionSummary({ id: 'sess_room_abc123', messages }).incomingTail, [2]);
});

test('an append keeps the tail, and a reply streamed in place is counted once it has text', () => {
  const session = { id: 'sess_home_lead', messages: [user('Hello'), reply('Hi')] };
  assert.deepEqual(_sessionSummary(session).incomingTail, [2]);
  session.messages.push(reply(''));
  assert.deepEqual(_sessionSummary(session).incomingTail, [2], 'no text yet');
  session.messages.at(-1).content = 'Streaming…';
  const filled = _sessionSummary(session);
  assert.deepEqual(filled.incomingTail, [2, 3]);
  assert.equal(filled.messageCount, 3);
  session.messages.push(user('ok'));
  assert.deepEqual(_sessionSummary(session).incomingTail, [2, 3]);
});

test('the tail keeps the newest 100 places, one past the pill so a full tail reads 99+', () => {
  const messages = Array.from({ length: 150 }, (_, index) => reply(`message ${index}`));
  const tail = _sessionSummary({ id: 'sess_home_lead', messages }).incomingTail;
  assert.equal(tail.length, 100);
  assert.equal(tail.at(-1), 150);
  assert.equal(tail[0], 51);
});

test('the catalog, its DB and the session list carry the tail; an older row has none', () => {
  const tail = [2, 5];
  const base = { id: 'sess_home_lead', updatedAt: 2, lastMessagePreview: 'Hi' };
  const row = normalizedRow({ ...base, incomingTail: tail });
  assert.deepEqual(row.incomingTail, tail);
  assert.equal(Object.hasOwn(normalizedRow(base), 'incomingTail'), false, 'a row without it');

  const db = new DatabaseSync(':memory:');
  try {
    db.exec(SCHEMA_SQL);
    const upsert = db.prepare(UPSERT_SQL);
    for (const entry of [{ row }, { row: normalizedRow({ ...base, id: 'sess_old' }) }]) {
      upsert.run(...upsertParams(entry, rowSignature(entry)));
    }
    const read = (id) => rowFromDb(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id));
    assert.deepEqual(read('sess_home_lead').incomingTail, tail);
    assert.equal(Object.hasOwn(read('sess_old'), 'incomingTail'), false);
  } finally {
    db.close();
  }

  assert.deepEqual(leadSessionRow({ ...row, messageCount: 5, owner: 'user' }).incomingTail, tail);
  assert.equal(
    Object.hasOwn(leadSessionRow({ ...normalizedRow(base), messageCount: 5, owner: 'user' }), 'incomingTail'),
    false
  );
  // A full session (no index row) derives it from its transcript.
  const full = leadSessionRow({
    id: 'sess_home_lead',
    owner: 'user',
    messages: [user('Hello'), ...reply3Tools('Done.')],
  });
  assert.deepEqual(full.incomingTail, [full.messageCount]);
});
