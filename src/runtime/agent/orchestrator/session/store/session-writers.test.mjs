// A recorder holds what it recorded; records another writer appended to the
// log are never diffed away: the next save of a copy built here is recorded on
// top of them, and the copy this tenure wrote is refused.
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-session-writers-'));
process.env.MIXDOG_DATA_DIR = root;
const dir = join(root, 'sessions');
mkdirSync(dir);

const { saveSessionDurably } = await import('../store.mjs');
const { SAVE_OUTCOME_SAVED } = await import('./live-state.mjs');
const { parseSessionLog, resolveSessionRecordSync } = await import('./session-log-reader.mjs');
const { encodePatch } = await import('./session-log-format.mjs');
const { loadLegacySession } = await import('./legacy-session.mjs');
const { settleSessionSummaryIndex } = await import('./listing.mjs');

test.after(async () => {
  await settleSessionSummaryIndex();
  (await import('./session-writer-claim.mjs')).releaseHeldSessionWriters();
  rmSync(root, { recursive: true, force: true });
});

const files = (id) => ({ jsonPath: join(dir, `${id}.json`), logPath: join(dir, `${id}.log.jsonl`) });
const stored = (id) => resolveSessionRecordSync({ ...files(id), loadLegacy: loadLegacySession });

// Another writer's header patch, appended after the log's last record.
function appendForeign(id, patch) {
  const { logPath } = files(id);
  const { seq } = parseSessionLog(readFileSync(logPath));
  const set = Object.entries(patch).map(([key, value]) => [key, JSON.stringify(value)]);
  appendFileSync(logPath, encodePatch(seq + 1, set, []));
  return seq + 1;
}

const { rememberSensitiveValues } = await import('../sensitive-values.mjs');

test("redaction keeps v1.4.5's scope: message text and tool-call arguments, in the json and the log alike; header fields, ids and numbers stay", async () => {
  const id = 'sess_writers_redaction_scope';
  const fill = {
    id: 'call-123456',
    name: 'browser',
    arguments: { action: 'fill', input: { sensitive: true, text: '123456' } },
  };
  const doc = {
    id,
    owner: 'agent',
    generation: 123456,
    model: 'model-123456',
    catalog: [{ id: 'tool-123456', size: 123456 }],
    messages: [
      { role: 'user', content: 'the code is 123456' },
      { role: 'assistant', content: '', toolCalls: [fill] },
    ],
  };
  writeFileSync(files(id).jsonPath, JSON.stringify(doc));
  const session = structuredClone(doc);
  assert.equal(await saveSessionDurably(session), SAVE_OUTCOME_SAVED);
  rememberSensitiveValues(id, [fill]);
  assert.equal(await saveSessionDurably(session), SAVE_OUTCOME_SAVED);
  const json = JSON.parse(readFileSync(files(id).jsonPath, 'utf8'));
  const outcome = stored(id);
  assert.equal(outcome.kind, 'log');
  for (const [where, copy] of [
    ['json', json],
    ['log', outcome.session],
  ]) {
    assert.equal(copy.generation, 123456, `${where}: generation`);
    assert.equal(copy.model, 'model-123456', `${where}: model`);
    assert.deepEqual(copy.catalog, doc.catalog, `${where}: catalog`);
    assert.equal(copy.messages[0].content, 'the code is [redacted]', `${where}: message text`);
    assert.equal(copy.messages[1].toolCalls[0].id, 'call-123456', `${where}: tool-call id`);
    assert.equal(copy.messages[1].toolCalls[0].arguments.input.text, '[redacted]', `${where}: tool-call arguments`);
  }
});

const worker = (id, status) => ({ id, owner: 'agent', status, messages: [{ role: 'user', content: 'go' }] });

test('a copy built here is recorded on top of records another writer appended', async () => {
  const id = 'sess_writers_built_here';
  assert.equal(await saveSessionDurably(worker(id, 'running')), SAVE_OUTCOME_SAVED);
  const foreignSeq = appendForeign(id, { status: 'error', generation: 5 });
  assert.equal(await saveSessionDurably(worker(id, 'running')), SAVE_OUTCOME_SAVED);
  const outcome = stored(id);
  assert.equal(outcome.kind, 'log');
  assert.ok(outcome.log.seq > foreignSeq, `recorded after the foreign record (log at seq ${outcome.log.seq})`);
  assert.equal(outcome.session.status, 'running');
});

test('the copy this tenure wrote is refused once another writer appended, and the log keeps that record', async () => {
  const id = 'sess_writers_tenure_copy';
  const copy = worker(id, 'running');
  assert.equal(await saveSessionDurably(copy), SAVE_OUTCOME_SAVED);
  appendForeign(id, { status: 'error', generation: 5 });
  const size = statSync(files(id).logPath).size;
  copy.messages = [...copy.messages, { role: 'assistant', content: 'late' }];
  await assert.rejects(saveSessionDurably(copy), { code: 'ESESSIONCHANGED' });
  assert.equal(statSync(files(id).logPath).size, size);
  const outcome = stored(id);
  assert.equal(outcome.session.status, 'error');
  assert.deepEqual(
    outcome.session.messages.map((message) => message.content),
    ['go']
  );
});

// Last: it ends this process's writers as an exit does.
test('the exit drain completes a redaction requested behind another: no file holds either value, the later message lands, and both saves resolve', async (t) => {
  const id = 'sess_writers_chained_redaction';
  const { drainSessionStore } = await import('../store.mjs');
  const fill = (text) => ({ name: 'browser', arguments: { action: 'fill', input: { sensitive: true, text } } });
  const doc = { id, owner: 'agent', messages: [{ role: 'user', content: 'first alpha-111111' }] };
  writeFileSync(files(id).jsonPath, JSON.stringify(doc));
  const session = structuredClone(doc);
  assert.equal(await saveSessionDurably(session), SAVE_OUTCOME_SAVED);
  // A scanner holds the log: the first redaction waits to swap its log in.
  const { renameSync } = fs;
  let refusing = true;
  let refused = 0;
  fs.renameSync = function (from, to, ...rest) {
    if (refusing && String(to) === files(id).logPath) {
      refused += 1;
      throw Object.assign(new Error(`EBUSY: rename -> '${to}'`), { code: 'EBUSY' });
    }
    return renameSync.call(this, from, to, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.renameSync = renameSync;
    syncBuiltinESMExports();
  });
  rememberSensitiveValues(id, [fill('alpha-111111')]);
  const first = saveSessionDurably(session);
  while (refused === 0) await new Promise((resolve) => setImmediate(resolve));
  // A second value, in a message the second save carries.
  rememberSensitiveValues(id, [fill('beta-222222')]);
  session.messages = [...session.messages, { role: 'user', content: 'second beta-222222' }];
  const second = saveSessionDurably(session);
  refusing = false;
  drainSessionStore();
  const holding = readdirSync(dir).filter((name) => {
    if (!name.startsWith(`${id}.`)) return false;
    const text = readFileSync(join(dir, name), 'utf8');
    return text.includes('alpha-111111') || text.includes('beta-222222');
  });
  assert.deepEqual(holding, [], 'no file of the session holds either value');
  assert.deepEqual(
    stored(id).session.messages.map((message) => message.content),
    ['first [redacted]', 'second [redacted]']
  );
  assert.deepEqual(
    JSON.parse(readFileSync(files(id).jsonPath, 'utf8')).messages.map((message) => message.content),
    ['first [redacted]']
  );
  assert.equal(await first, SAVE_OUTCOME_SAVED);
  assert.equal(await second, SAVE_OUTCOME_SAVED);
});
