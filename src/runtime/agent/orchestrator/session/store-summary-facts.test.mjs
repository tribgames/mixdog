// A summary is made of facts about each message (messageFacts) folded in order
// (projectionOfFacts), so a transcript need not be held to be summarized: a
// log read piece by piece, a place kept in it between reads. Whatever the
// transcript — appended to, edited, rolled back, compacted — the summary of
// its facts is the summary of the transcript.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MESSAGE_FACTS_VERSION, _sessionSummary, messageFacts, projectionOfFacts } from './store-summary-index.mjs';
import { routineResultMessage } from './routine-result.mjs';
import {
  encodeAppend,
  encodeCompacted,
  encodeEdit,
  encodePatch,
  encodeRollback,
  encodeSessionRecord,
} from './store/session-log-format.mjs';
import { parseSessionLog, readSessionLog, readSessionLogSync, sessionFromLog } from './store/session-log-reader.mjs';
import { _setScanCheckpointStrideForTest } from './store/session-scan-checkpoint.mjs';

const user = (text) => ({ role: 'user', content: text });
const reply = (text) => ({ role: 'assistant', content: text });
const toolCall = (id) => ({ role: 'assistant', content: 'looking', toolCalls: [{ id, name: 'read', arguments: {} }] });
const toolUse = (id) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'read', input: {} }] });
const toolResult = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] });

const TRANSCRIPTS = [
  [],
  [user('Hello'), reply('Hi there')],
  [{ role: 'system', content: 'be brief' }, user('# Session\nCwd: /x\n'), user('Real prompt'), reply('ok')],
  [user('Check it'), toolCall('a'), { role: 'tool', toolCallId: 'a', content: 'ok' }, toolUse('b'), toolResult('b'), reply('All good.')],
  [
    user('Hello'),
    reply('Hi'),
    user('and now?'),
    routineResultMessage({ name: 'daily', ok: true, text: 'All green.', messageId: 'm1' }),
    routineResultMessage({ name: 'weekly', ok: false, text: 'It broke.', messageId: 'm2' }),
  ],
  [{ role: 'user', content: '   ' }, { role: 'user', content: '<system-reminder>x</system-reminder>', synthetic: true }, user('first real'), reply('')],
  [null, user('after a null'), { role: 'assistant' }, reply('x'.repeat(5000))],
  Array.from({ length: 150 }, (_, i) => (i % 2 ? reply(`answer ${i}`) : user(`question ${i}`))),
];

test('the summary of a transcript is the summary of its facts, for every kind of session', () => {
  for (const messages of TRANSCRIPTS) {
    for (const id of ['sess_plain', 'sess_home_lead', 'sess_room_abc123']) {
      const session = { id, title: 'T', updatedAt: 5, messages };
      assert.deepEqual(
        _sessionSummary({ ...session, messages: [] }, projectionOfFacts(messages.map(messageFacts), id)),
        _sessionSummary(session),
        `${id}: ${JSON.stringify(messages).slice(0, 80)}`
      );
    }
  }
});

test('a log read as facts gives the facts of the transcript it replays, whole, in blocks and from a checkpoint', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-facts-'));
  _setScanCheckpointStrideForTest(1);
  t.after(() => {
    _setScanCheckpointStrideForTest(null);
    rmSync(dir, { recursive: true, force: true });
  });
  const j = (items) => items.map((item) => JSON.stringify(item));
  const path = join(dir, 'sess_facts.log.jsonl');
  const facts = { project: messageFacts, version: MESSAGE_FACTS_VERSION };
  const checkpoints = join(dir, 'checkpoints');
  const records = [
    encodeSessionRecord({ logId: 'L1', id: 'sess_facts', legacy: null, header: { id: 'sess_facts', title: 'a' } }) +
      encodeCompacted(1, j([user('one'), reply('two')])),
    encodeAppend(2, 4, j([user('three'), toolCall('c1')])) + encodePatch(3, [['title', '"b"']], []),
    encodeEdit(4, 4, 3, 1, j([reply('edited reply')])) + encodeAppend(5, 6, j([user('five'), reply('six')])),
    encodeRollback(6, 3) + encodeAppend(7, 5, j([user('seven'), reply('eight')])),
    encodeCompacted(8, j([user('summary of it all'), reply('ack')])) + encodeAppend(9, 3, j([user('after compaction')])),
  ];
  const expected = () => {
    const bytes = Buffer.from(records.slice(0, applied).join(''));
    const whole = parseSessionLog(bytes);
    return { whole, bytes };
  };
  let applied = 0;
  let processes = 0;
  for (applied = 1; applied <= records.length; applied += 1) {
    writeFileSync(path, records.slice(0, applied).join(''));
    const { whole, bytes } = expected();
    const wantFacts = sessionFromLog(whole).messages.map(messageFacts);
    // Whole, through parseSessionLog, in one block and (with a tiny stride) a block per record.
    assert.deepEqual(parseSessionLog(bytes, { messages: false, facts }).facts, wantFacts);
    for (const sync of [false, true]) {
      const reader = await import(`./store/session-log-reader.mjs?process=${(processes += 1)}`);
      const options = { messages: false, facts, checkpoints };
      const log = sync ? reader.readSessionLogSync(path, options) : await reader.readSessionLog(path, options);
      assert.deepEqual(log.facts, wantFacts, `after ${applied} records`);
      assert.equal(log.messages, undefined);
      assert.equal(log.messageCount, whole.messageCount);
      assert.deepEqual(log.header, whole.header);
    }
  }
  // The scan that keeps facts and the one that keeps the header are two scans of one log.
  assert.equal(readSessionLogSync(path, { messages: false }).facts, undefined);
  assert.equal((await readSessionLog(path, { messages: false })).messageCount, 3);
  appendFileSync(path, encodeAppend(10, 4, j([reply('late')])));
  assert.equal(readSessionLogSync(path, { messages: false, facts, checkpoints }).facts.at(-1).l, 'late');
});
