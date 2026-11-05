import assert from 'node:assert/strict';
import fs, {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodePatch, jsonEqual, sha1Hex } from './session-log-format.mjs';
import { parseSessionLog, readSessionLog, resolveSessionRecord, sessionFromLog } from './session-log-reader.mjs';
import {
  SESSION_LOG_ERRORS,
  convertLegacySession,
  createSessionLog,
  openSessionLog,
  _sessionLogIoForTest,
} from './session-log-writer.mjs';
import { loadLegacy } from './session-log-legacy-loader.fixture.mjs';

const root = mkdtempSync(join(tmpdir(), 'mixdog-session-log-writer-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

let serial = 0;
function paths() {
  serial += 1;
  const id = `sess_w${serial}`;
  return { id, jsonPath: join(root, `${id}.json`), logPath: join(root, `${id}.log.jsonl`) };
}

function fakeClaim() {
  const claim = {
    held: true,
    checks: 0,
    assertHeld() {
      claim.checks += 1;
      if (!claim.held) {
        const err = new Error('claim held elsewhere');
        err.code = 'ESESSIONCHANGED';
        throw err;
      }
    },
  };
  return claim;
}

const msg = (content, role = 'user') => ({ role, content });

async function replayed(logPath) {
  const log = await readSessionLog(logPath);
  assert.equal(log.valid, true);
  assert.equal(log.damage, null);
  return sessionFromLog(log);
}

// The async fsync is how each batch is made durable: counting it counts
// batches. `failNextSync` fails the next fsync of either kind.
const io = _sessionLogIoForTest();
const realFsync = io.fsync;
const realFsyncSync = io.fsyncSync;
let syncCalls = 0;
let failNextSync = 0;
const diskFull = () => Object.assign(new Error('disk full'), { code: 'ENOSPC' });
// `holdNextSync` holds the next async fsync until the function it is replaced
// by is called.
let holdNextSync = null;
io.fsync = (fd, cb) => {
  syncCalls += 1;
  if (holdNextSync) {
    const hold = holdNextSync;
    holdNextSync = null;
    hold(() => realFsync(fd, cb));
    return;
  }
  if (failNextSync > 0) {
    failNextSync -= 1;
    cb(diskFull());
    return;
  }
  realFsync(fd, cb);
};
io.fsyncSync = (fd) => {
  if (failNextSync > 0) {
    failNextSync -= 1;
    throw diskFull();
  }
  realFsyncSync(fd);
};

test('records append, edit, rollback, compaction and header patches that replay to the session', async () => {
  const { id, logPath } = paths();
  const claim = fakeClaim();
  const session = { id, title: 'a', usage: { in: 1 }, messages: [msg('sys', 'system'), msg('hi')] };
  const rec = await createSessionLog({ logPath, session, claim });
  assert.ok(jsonEqual(await replayed(logPath), session));

  session.messages = [...session.messages, msg('hello', 'assistant')];
  session.usage = { in: 2 };
  await rec.record(session);
  session.messages = [msg('sys2', 'system'), ...session.messages.slice(1)];
  await rec.record(session);
  session.messages = session.messages.slice(0, 2);
  delete session.usage;
  await rec.record(session);
  session.messages = [msg('summary', 'system'), msg('next')];
  await rec.record(session, { compacted: true });
  session.messages = [...session.messages, msg('more', 'assistant')];
  session.title = 'b';
  const ack = await rec.record(session);

  const types = readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).t);
  assert.deepEqual(types, ['session', 'compacted', 'append', 'patch', 'edit', 'rollback', 'patch', 'compacted', 'append', 'patch']);
  const edit = JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n')[4]);
  assert.deepEqual([edit.at, edit.del, edit.messages.length], [0, 1, 1], 'only the changed message is written');
  assert.ok(jsonEqual(await replayed(logPath), session));
  assert.equal(ack.seq, 9);
  assert.equal((await readSessionLog(logPath)).replayFrom, 7);
  assert.deepEqual(await rec.record(session), ack, 'no change writes nothing');
  await rec.close();
});

test('records of one tick share one write and one fsync; later ones form the next batch', async () => {
  const { id, logPath } = paths();
  const session = { id, messages: [] };
  const rec = await createSessionLog({ logPath, session, claim: fakeClaim() });
  const before = syncCalls;
  const pending = [];
  for (let i = 0; i < 5; i += 1) {
    session.messages = [...session.messages, msg(`m${i}`)];
    pending.push(rec.record(session));
  }
  const acks = await Promise.all(pending);
  assert.equal(syncCalls - before, 1);
  assert.ok(acks.every((ack) => ack.seq === 6), 'every caller is acknowledged with the batch');
  session.messages = [...session.messages, msg('x')];
  const first = rec.record(session);
  await Promise.resolve();
  session.messages = [...session.messages, msg('y')];
  const second = rec.record(session);
  await Promise.all([first, second]);
  assert.ok(syncCalls - before <= 3);
  assert.equal((await replayed(logPath)).messages.length, 7);
  await rec.close();
});

test('a failed write rejects its callers and lands, at the same offset, with the next batch', async () => {
  const { id, logPath } = paths();
  const session = { id, messages: [] };
  const rec = await createSessionLog({ logPath, session, claim: fakeClaim() });
  failNextSync = 1;
  session.messages = [msg('a')];
  await assert.rejects(rec.record(session), /disk full/);
  session.messages = [msg('a'), msg('b')];
  const ack = await rec.record(session);
  assert.equal(ack.seq, 3);
  assert.deepEqual((await replayed(logPath)).messages, session.messages);
  assert.equal(statSync(logPath).size, ack.end);
  await rec.close();
});

test('nothing lands without the writer claim, and a lost claim ends the recorder', async () => {
  const { id, logPath } = paths();
  const claim = fakeClaim();
  const session = { id, messages: [] };
  claim.held = false;
  await assert.rejects(async () => createSessionLog({ logPath, session, claim }), { code: 'ESESSIONCHANGED' });
  assert.equal(existsSync(logPath), false);
  claim.held = true;
  const rec = await createSessionLog({ logPath, session, claim });
  const size = statSync(logPath).size;
  session.messages = [msg('a')];
  const pending = rec.record(session);
  claim.held = false; // lost before the batch is written
  await assert.rejects(pending, { code: 'ESESSIONCHANGED' });
  assert.equal(statSync(logPath).size, size);
  claim.held = true;
  await assert.rejects(rec.record(session), { code: 'ESESSIONCHANGED' }, 'a stale recorder stays refused');
  await assert.rejects(async () => openSessionLog({ logPath, claim: { ...claim, assertHeld() { throw Object.assign(new Error('busy'), { code: 'ESESSIONCHANGED' }); } } }), { code: 'ESESSIONCHANGED' });
});

test('open refuses a copy recorded on another state of the log', async () => {
  const { id, logPath } = paths();
  const claim = fakeClaim();
  const session = { id, messages: [msg('a')] };
  const rec = await createSessionLog({ logPath, session, claim });
  const loadedAt = rec.acked;
  session.messages = [msg('a'), msg('b')];
  await rec.record(session);
  await rec.close();
  await assert.rejects(
    async () => openSessionLog({ logPath, claim, expect: { logId: loadedAt.logId, seq: loadedAt.seq }, messages: [msg('a')] }),
    { code: SESSION_LOG_ERRORS.CHANGED }
  );
  const reopened = await openSessionLog({ logPath, claim });
  assert.deepEqual(reopened.loaded.messages, session.messages);
  const live = reopened.loaded;
  live.messages = [...live.messages, msg('c')];
  await reopened.record(live);
  assert.equal(JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n').at(-1)).t, 'append');
  await reopened.close();
});

test('open sets a torn tail aside and truncates it, so later records keep their sequence', async () => {
  const { id, logPath } = paths();
  const claim = fakeClaim();
  const session = { id, messages: [msg('a')] };
  const rec = await createSessionLog({ logPath, session, claim });
  session.messages = [msg('a'), msg('b')];
  await rec.record(session);
  await rec.close();
  // A crash that lost only the newline: the last record is complete JSON but
  // was never committed (no newline), so it must not come back.
  const bytes = readFileSync(logPath);
  writeFileSync(logPath, bytes.subarray(0, bytes.length - 1));
  const torn = bytes.subarray(bytes.lastIndexOf(0x0a, bytes.length - 2) + 1, bytes.length - 1);
  const reopened = await openSessionLog({ logPath, claim });
  assert.deepEqual(reopened.loaded.messages, [msg('a')]);
  const live = reopened.loaded;
  live.messages = [...live.messages, msg('c')];
  await reopened.record(live);
  await reopened.close();
  const log = await readSessionLog(logPath);
  assert.equal(log.damage, null);
  assert.equal(log.tornTail, null);
  assert.deepEqual(log.messages, [msg('a'), msg('c')]);
  const aside = readdirSync(root).find((name) => name.startsWith(`${id}.log.jsonl.torn-`));
  assert.ok(aside, 'the torn tail is kept aside');
  assert.deepEqual(readFileSync(join(root, aside)), torn);
});

test('a message stamped with an id after it was recorded reaches the log', async () => {
  const { stampMessageIds, messageIdOf } = await import('../message-ids.mjs');
  const { id, logPath } = paths();
  const session = { id, messages: [{ role: 'tool', content: 'out', toolCallId: 'c1' }] };
  const rec = await createSessionLog({ logPath, session, claim: fakeClaim() });
  assert.equal(stampMessageIds(session.messages, { sessionId: id }), 1);
  await rec.record(session);
  await rec.close();
  const stored = (await replayed(logPath)).messages[0];
  assert.equal(messageIdOf(stored), messageIdOf(session.messages[0]));
  assert.ok(messageIdOf(stored));
});

test('under test, a recorded message is frozen: an in-place edit throws instead of being lost', async () => {
  const { id, logPath } = paths();
  const session = { id, messages: [msg('a', 'system')] };
  const rec = await createSessionLog({ logPath, session, claim: fakeClaim() });
  session.messages = [...session.messages, { role: 'user', content: 'b', meta: { transcript: {} } }];
  await rec.record(session);
  assert.throws(() => {
    session.messages[1].meta = { changed: true };
  }, TypeError);
  assert.throws(() => {
    session.messages[1].meta.transcript.messageId = 'x';
  }, TypeError);
  assert.throws(() => {
    session.messages[0].content = 'edited';
  }, TypeError);
  await rec.close();
});

test('a damaged log stays in place when its replacement cannot be written', async () => {
  const { id, logPath } = paths();
  const claim = fakeClaim();
  const session = { id, messages: [msg('a')] };
  await (await createSessionLog({ logPath, session, claim })).close();
  appendFileSync(logPath, `garbage\n{"t":"append","s":5,"len":2,"messages":[{"role":"user","content":"z"}]}\n`);
  const damaged = readFileSync(logPath);
  failNextSync = 1; // the replacement's fsync fails
  await assert.rejects(async () => openSessionLog({ logPath, claim }), /disk full/);
  assert.deepEqual(readFileSync(logPath), damaged, 'the damaged log is still the log');
  assert.equal(readdirSync(root).filter((name) => name.startsWith(`${id}.`) && name.endsWith('.tmp')).length, 0);
  const reopened = await openSessionLog({ logPath, claim });
  await reopened.close();
  assert.deepEqual((await readSessionLog(logPath)).messages, [msg('a')]);
});

test('a legacy base is never published once the claim is gone', async () => {
  const { prepareLegacyBase, publishLegacyBase } = await import('./session-log-writer.mjs');
  const { id, jsonPath, logPath } = paths();
  writeFileSync(jsonPath, JSON.stringify({ id, messages: [msg('a')] }));
  const prepared = await prepareLegacyBase({ jsonPath, logPath, loadLegacy });
  // Held for the first check only: lost while publish reads the json again.
  let checks = 0;
  const claim = {
    assertHeld() {
      checks += 1;
      if (checks > 1) throw Object.assign(new Error('claim gone'), { code: 'ESESSIONCHANGED' });
    },
  };
  await assert.rejects(async () => publishLegacyBase(prepared, { claim }), { code: 'ESESSIONCHANGED' });
  assert.equal(existsSync(logPath), false);
  assert.equal(existsSync(prepared.tmpPath), false);
});

test('open sets a damaged log aside whole and continues from its replayed state', async () => {
  const { id, logPath } = paths();
  const claim = fakeClaim();
  const session = { id, title: 'kept', messages: [msg('a')] };
  const rec = await createSessionLog({ logPath, session, claim });
  session.messages = [msg('a'), msg('b')];
  await rec.record(session);
  await rec.close();
  const original = readFileSync(logPath);
  const lostRecord = '{"t":"append","s":3,"len":3,"messages":[{"role":"user","content":"c"}]}\n';
  const fourth = '{"t":"append","s":4,"len":4,"messages":[{"role":"user","content":"d"}]}\n';
  writeFileSync(logPath, Buffer.concat([original, Buffer.from(`${'\u0000'.repeat(lostRecord.length - 1)}\n${fourth}`)]));
  const damaged = readFileSync(logPath);
  const reopened = await openSessionLog({ logPath, claim });
  await reopened.close();
  const aside = readdirSync(root).find((name) => name.startsWith(`${id}.log.jsonl.damaged-`));
  assert.ok(aside, 'the damaged log is kept');
  assert.equal(sha1Hex(readFileSync(join(root, aside))), sha1Hex(damaged));
  const log = await readSessionLog(logPath);
  assert.equal(log.prev.reason, 'damaged');
  assert.equal(log.header.title, 'kept');
  assert.deepEqual(log.messages, [msg('a'), msg('b')]);
});

test('legacy conversion publishes a proven base and never touches the json', async () => {
  const { id, jsonPath, logPath } = paths();
  writeFileSync(jsonPath, JSON.stringify({ id, title: 'legacy', messages: [msg('a'), msg('b', 'assistant')] }));
  const before = { bytes: readFileSync(jsonPath), mtimeMs: statSync(jsonPath).mtimeMs };
  const claim = fakeClaim();
  const result = await convertLegacySession({ jsonPath, logPath, loadLegacy, claim });
  assert.equal(result.legacy.sha1, sha1Hex(before.bytes));
  assert.deepEqual(readFileSync(jsonPath), before.bytes);
  assert.equal(statSync(jsonPath).mtimeMs, before.mtimeMs);
  const log = await readSessionLog(logPath);
  assert.ok(jsonEqual(sessionFromLog(log), loadLegacy(before.bytes.toString('utf8'), id)));
  assert.equal((await resolveSessionRecord({ jsonPath, logPath, loadLegacy })).kind, 'log');
  assert.equal(readdirSync(root).filter((name) => name.endsWith('.tmp')).length, 0);
  // A second conversion never replaces the log.
  await assert.rejects(async () => convertLegacySession({ jsonPath, logPath, loadLegacy, claim }), { code: 'EEXIST' });

  // First write after the conversion diffs against the legacy-loaded copy.
  const live = loadLegacy(before.bytes.toString('utf8'), id);
  const rec = await openSessionLog({ logPath, claim, expect: { logId: result.logId, seq: 1 }, messages: live.messages });
  live.messages = [...live.messages, msg('c')];
  await rec.record(live);
  await rec.close();
  const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line).t);
  assert.deepEqual(lines, ['session', 'compacted', 'append']);
});

test('a base that does not prove equal to the legacy load is refused and leaves nothing', async () => {
  const { id, jsonPath, logPath } = paths();
  writeFileSync(jsonPath, JSON.stringify({ id, unstableLoad: true, messages: [msg('a')] }));
  const bytes = readFileSync(jsonPath);
  await assert.rejects(async () => convertLegacySession({ jsonPath, logPath, loadLegacy, claim: fakeClaim() }), {
    code: SESSION_LOG_ERRORS.LEGACY_BASE,
  });
  assert.equal(existsSync(logPath), false);
  assert.deepEqual(readFileSync(jsonPath), bytes);
  assert.equal(readdirSync(root).filter((name) => name.endsWith('.tmp')).length, 0);
  assert.equal((await resolveSessionRecord({ jsonPath, logPath, loadLegacy })).kind, 'legacy');

  const unreadable = paths();
  writeFileSync(unreadable.jsonPath, '{"id":');
  await assert.rejects(async () => convertLegacySession({ ...unreadable, loadLegacy, claim: fakeClaim() }), {
    code: SESSION_LOG_ERRORS.LEGACY_UNREADABLE,
  });
});

test('a diverged log is set aside and the session rebased from the json', async () => {
  const { id, jsonPath, logPath } = paths();
  const claim = fakeClaim();
  writeFileSync(jsonPath, JSON.stringify({ id, title: 'v1', messages: [msg('a')] }));
  const first = await convertLegacySession({ jsonPath, logPath, loadLegacy, claim });
  const logBytes = readFileSync(logPath);
  writeFileSync(jsonPath, JSON.stringify({ id, title: 'downgraded', messages: [msg('a'), msg('z')] }));
  const resolved = await resolveSessionRecord({ jsonPath, logPath, loadLegacy });
  assert.equal(resolved.kind, 'diverged');
  await assert.rejects(
    async () => convertLegacySession({ jsonPath, logPath, loadLegacy, claim, divergedLogId: 'not-it' }),
    { code: SESSION_LOG_ERRORS.CHANGED }
  );
  const rebased = await convertLegacySession({ jsonPath, logPath, loadLegacy, claim, divergedLogId: resolved.log.logId });
  assert.notEqual(rebased.logId, first.logId);
  assert.deepEqual(readFileSync(rebased.aside), logBytes, 'the diverged log is kept whole');
  const now = await resolveSessionRecord({ jsonPath, logPath, loadLegacy });
  assert.equal(now.kind, 'log');
  assert.equal(now.session.title, 'downgraded');
});

test('the redaction rewrite removes the old bytes and keeps the lineage', async () => {
  const { id, logPath } = paths();
  const claim = fakeClaim();
  const secrets = new Set();
  const projectMessage = (message) =>
    secrets.size && typeof message.content === 'string'
      ? { ...message, content: [...secrets].reduce((text, s) => text.replaceAll(s, '[redacted]'), message.content) }
      : message;
  const session = { id, messages: [msg('my token is hunter2')] };
  const rec = await createSessionLog({ logPath, session, claim, projectMessage });
  session.messages = [...session.messages, msg('ok, hunter2 noted', 'assistant')];
  await rec.record(session);
  const oldLogId = rec.logId;
  secrets.add('hunter2');
  session.messages = [...session.messages, msg('next')];
  const pending = rec.record(session);
  const ack = await rec.rewrite(session);
  assert.equal((await pending).seq, 3, 'the record queued first landed in the old log');
  assert.deepEqual(ack, { logId: rec.logId, seq: 1, end: statSync(logPath).size });
  assert.equal(readFileSync(logPath, 'utf8').includes('hunter2'), false);
  assert.equal(readdirSync(root).some((name) => name.startsWith(`${id}.`) && readFileSync(join(root, name), 'utf8').includes('hunter2')), false);
  const log = await readSessionLog(logPath);
  assert.deepEqual(log.prev, { logId: oldLogId, seq: 3, reason: 'redaction' });
  assert.equal(log.messages.length, 3);
  session.messages = [...session.messages, msg('after')];
  await rec.record(session);
  assert.deepEqual((await replayed(logPath)).messages.map((m) => m.content), [
    'my token is [redacted]',
    'ok, [redacted] noted',
    'next',
    'after',
  ]);
  await rec.close();
});

// The redaction of value `hunter2`: in message text only (as
// sensitive-projection.mjs), plain text where nothing parses.
const redactText = (text) => text.replaceAll('hunter2', '[redacted]');
const redactMessage = (m) =>
  m && typeof m.content === 'string' && m.content.includes('hunter2') ? { ...m, content: redactText(m.content) } : m;
const DAMAGED_WITH_VALUE = `${JSON.stringify({ t: 'append', s: 9, len: 1, messages: [msg('hunter2')] })}\n`;

// A converted legacy session whose json, damaged copy and torn copy hold the
// value, opened with the redacting projection.
async function sessionHoldingValue() {
  const { id, jsonPath, logPath } = paths();
  const claim = fakeClaim();
  writeFileSync(jsonPath, JSON.stringify({ id, generation: 7, messages: [msg('old secret: hunter2')] }));
  await convertLegacySession({ jsonPath, logPath, loadLegacy, claim });
  writeFileSync(`${logPath}.damaged-1-ab`, DAMAGED_WITH_VALUE);
  writeFileSync(`${logPath}.torn-2-cd`, 'partial hunter2');
  const rec = await openSessionLog({ logPath, claim });
  rec._options.projectMessage = redactMessage;
  return { id, jsonPath, logPath, rec, redaction: { jsonPath, redactMessage, redactText } };
}

// The session's files that still hold the value.
const holdingValue = (id) =>
  readdirSync(root).filter((name) => name.startsWith(`${id}.`) && readFileSync(join(root, name), 'utf8').includes('hunter2'));

test('redaction also rewrites the legacy json and the copies kept aside that hold the value', async () => {
  const { id, jsonPath, logPath } = paths();
  const claim = fakeClaim();
  writeFileSync(jsonPath, JSON.stringify({ id, messages: [msg('old secret: hunter2')] }));
  const legacyBytes = readFileSync(jsonPath);
  await convertLegacySession({ jsonPath, logPath, loadLegacy, claim });
  writeFileSync(`${logPath}.damaged-1-ab`, DAMAGED_WITH_VALUE);
  writeFileSync(`${logPath}.torn-2-cd`, 'partial hunter2');
  const rec = await openSessionLog({ logPath, claim });
  const session = rec.loaded;
  rec._options.projectMessage = redactMessage;
  const redaction = { jsonPath, redactMessage, redactText };
  await rec.rewrite(session, { redaction });
  for (const name of readdirSync(root).filter((n) => n.startsWith(`${id}.`))) {
    assert.equal(readFileSync(join(root, name), 'utf8').includes('hunter2'), false, name);
  }
  const resolved = await resolveSessionRecord({ jsonPath, logPath, loadLegacy });
  assert.equal(resolved.kind, 'log');
  assert.equal(resolved.log.legacy.redactedFrom, sha1Hex(legacyBytes));
  assert.equal(resolved.log.legacy.sha1, sha1Hex(readFileSync(jsonPath)));
  // A crash between the log swap and the json swap: the old json is the
  // redacted one's source, so the log stays authoritative.
  writeFileSync(jsonPath, legacyBytes);
  const pending = await resolveSessionRecord({ jsonPath, logPath, loadLegacy });
  assert.equal(pending.kind, 'log');
  assert.equal(pending.redactionPending, true);
  await rec.close();
});

test('a redaction rewrite waits out refused renames on timers: the event loop runs between the retries', async (t) => {
  const { id, jsonPath, logPath } = paths();
  const claim = fakeClaim();
  writeFileSync(jsonPath, JSON.stringify({ id, messages: [msg('old secret: hunter2')] }));
  await convertLegacySession({ jsonPath, logPath, loadLegacy, claim });
  writeFileSync(`${logPath}.damaged-1-ab`, DAMAGED_WITH_VALUE);
  const asidePath = `${logPath}.damaged-1-ab`;
  const rec = await openSessionLog({ logPath, claim });
  rec._options.projectMessage = redactMessage;
  // A scanner holds each target for three attempts (the Windows sharing
  // violation the retries exist for); a 1 ms timer counts loop turns.
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 1);
  t.after(() => clearInterval(timer));
  const targets = [logPath, jsonPath, asidePath];
  const refusedAt = new Map(targets.map((path) => [path, []]));
  const refuses = (to) => {
    const at = refusedAt.get(String(to));
    if (!at || at.length >= 3) return false;
    at.push(ticks);
    return true;
  };
  const busy = (from, to) => Object.assign(new Error(`EBUSY: rename '${from}' -> '${to}'`), { code: 'EBUSY' });
  const { renameSync } = fs;
  const { rename } = fsp;
  fs.renameSync = function (from, to, ...rest) {
    if (refuses(to)) throw busy(from, to);
    return renameSync.call(this, from, to, ...rest);
  };
  fsp.rename = async (from, to) => {
    if (refuses(to)) throw busy(from, to);
    return rename(from, to);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.renameSync = renameSync;
    fsp.rename = rename;
    syncBuiltinESMExports();
  });
  await rec.rewrite(rec.loaded, { redaction: { jsonPath, redactMessage, redactText } });
  for (const path of targets) {
    const at = refusedAt.get(path);
    assert.equal(at.length, 3, `${path} was refused three times`);
    assert.ok(
      at.every((tick, index) => index === 0 || tick > at[index - 1]),
      `the loop ran between the retries of ${path} (ticks at its refusals: ${at.join(', ')})`
    );
    assert.equal(readFileSync(path, 'utf8').includes('hunter2'), false, path);
  }
  await rec.close();
});

test('a batch is refused when another writer appended to the log after the recorder last wrote', async () => {
  const { id, logPath } = paths();
  const session = { id, status: 'running', messages: [msg('a')] };
  const rec = await createSessionLog({ logPath, session, claim: fakeClaim() });
  session.messages = [...session.messages, msg('b', 'assistant')];
  const pending = rec.record(session);
  // Before the batch is written: a record the recorder did not write.
  const foreign = encodePatch(2, [['status', '"error"']], []);
  appendFileSync(logPath, foreign);
  await assert.rejects(pending, { code: 'ESESSIONCHANGED' });
  assert.ok(readFileSync(logPath, 'utf8').endsWith(foreign), 'the foreign record is the log\'s last');
  assert.equal((await replayed(logPath)).status, 'error');
  await assert.rejects(rec.record({ ...session, status: 'done' }), { code: 'ESESSIONCHANGED' });
  await rec.close().catch(() => {});
});

test('a save whose records do not serialize leaves the recorder as it was', async () => {
  const { id, logPath } = paths();
  const session = { id, messages: [msg('a')] };
  const rec = await createSessionLog({ logPath, session, claim: fakeClaim() });
  const messages = [...session.messages, msg('b', 'assistant')];
  await assert.rejects(rec.record({ id, messages, big: 1n }), TypeError);
  assert.equal(rec.seq, 1);
  await rec.record({ id, messages });
  assert.deepEqual((await replayed(logPath)).messages, messages);
  await rec.close();
});

// Renames onto `target` (sync and async) are refused with EBUSY until
// `release()`, so the rewrite waits between attempts; `refused()` counts them.
// `rearm(next)` refuses renames onto `next` from then on, the count restarted.
function refuseRenamesOnto(t, target) {
  const { renameSync } = fs;
  const { rename } = fsp;
  let refusing = true;
  let refused = 0;
  const refuses = (to) => refusing && String(to) === target && (refused += 1) > 0;
  const busy = (to) => Object.assign(new Error(`EBUSY: rename -> '${to}'`), { code: 'EBUSY' });
  fs.renameSync = function (from, to, ...rest) {
    if (refuses(to)) throw busy(to);
    return renameSync.call(this, from, to, ...rest);
  };
  fsp.rename = async (from, to) => {
    if (refuses(to)) throw busy(to);
    return rename(from, to);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.renameSync = renameSync;
    fsp.rename = rename;
    syncBuiltinESMExports();
  });
  return {
    release: () => {
      refusing = false;
    },
    refused: () => refused,
    rearm: (next) => {
      target = next;
      refusing = true;
      refused = 0;
    },
  };
}

async function until(check) {
  while (!check()) await new Promise((resolve) => setImmediate(resolve));
}

// An exit at each point a redaction can be at: still waiting for the batch in
// flight, waiting to swap in its log, or waiting to swap in the json.
for (const at of ['batch in flight', 'log rename refused', 'json rename refused']) {
  test(`an exit during a redaction (${at}) completes it: no file holds the value, and the saves made meanwhile are on the new log`, async (t) => {
    const { id, jsonPath, logPath, rec, redaction } = await sessionHoldingValue();
    const before = rec.logId;
    let release = () => {};
    let resumeSync = null;
    if (at === 'batch in flight') {
      holdNextSync = (resume) => {
        resumeSync = resume;
      };
      void rec.record({ ...rec.loaded, title: 'queued before' }).catch(() => {});
      await until(() => resumeSync !== null);
    }
    const hold = at === 'batch in flight' ? null : refuseRenamesOnto(t, at === 'log rename refused' ? logPath : jsonPath);
    const rewriting = rec.rewrite(rec.loaded, { redaction });
    if (hold) {
      await until(() => hold.refused() > 0);
      // The scanner lets go; the exit drain comes before the next attempt.
      release = hold.release;
    }
    const next = { ...rec.loaded, title: 'queued before', messages: [...rec.loaded.messages, msg('b', 'assistant')] };
    const saved = rec.record(next);
    release();
    assert.equal(rec.flushSync(), true);
    assert.deepEqual(holdingValue(id), [], 'no file of the session holds the value');
    const onDisk = parseSessionLog(readFileSync(logPath));
    assert.notEqual(onDisk.logId, before, 'on the new log');
    assert.deepEqual(
      onDisk.messages.map((m) => m.content),
      ['old secret: [redacted]', 'b']
    );
    assert.equal(sessionFromLog(onDisk).title, 'queued before');
    assert.deepEqual(JSON.parse(readFileSync(jsonPath, 'utf8')).messages, [msg('old secret: [redacted]')]);
    await saved;
    resumeSync?.();
    assert.equal((await rewriting).logId, onDisk.logId, 'the rewrite the drain completed resolves with it');
    assert.equal(holdingValue(id).length, 0, 'the overtaken rewrite moved nothing back');
  });
}

// A converted legacy session whose json and copies aside hold `tok-0`, with
// the projection and redaction of the values in `marked` (live).
async function sessionWithMarks() {
  const { id, jsonPath, logPath } = paths();
  const claim = fakeClaim();
  const marked = new Set();
  const redactText = (text) => [...marked].reduce((out, value) => out.replaceAll(value, '[redacted]'), text);
  const redactMessage = (m) => (m && typeof m.content === 'string' ? { ...m, content: redactText(m.content) } : m);
  writeFileSync(jsonPath, JSON.stringify({ id, title: 't0', messages: [msg('first tok-0')] }));
  await convertLegacySession({ jsonPath, logPath, loadLegacy, claim });
  writeFileSync(`${logPath}.damaged-1-ab`, `${JSON.stringify({ t: 'append', s: 9, len: 1, messages: [msg('tok-0')] })}\n`);
  writeFileSync(`${logPath}.torn-2-cd`, 'partial tok-0');
  const rec = await openSessionLog({ logPath, claim });
  rec._options.projectMessage = redactMessage;
  const holding = () =>
    readdirSync(root).filter((name) => {
      if (!name.startsWith(`${id}.`)) return false;
      const text = readFileSync(join(root, name), 'utf8');
      return [...marked].some((value) => text.includes(value));
    });
  return { jsonPath, logPath, rec, marked, redactText, holding, redaction: { jsonPath, redactMessage, redactText } };
}

// The order the promises of `accepted` settled in (index, or the rejection).
function settleOrder(accepted) {
  const order = [];
  accepted.forEach((promise, index) =>
    promise.then(
      () => order.push(index),
      (err) => order.push(`${index} rejected: ${err?.code ?? err?.message}`)
    )
  );
  return order;
}

test('an exit after a save accepted between two rewrites ends on the later rewrite\'s state', async (t) => {
  const { logPath, rec, marked, holding, redaction } = await sessionWithMarks();
  const hold = refuseRenamesOnto(t, logPath);
  const base = rec.loaded;
  marked.add('tok-0');
  const first = rec.rewrite(base, { redaction });
  await until(() => hold.refused() > 0);
  const middle = rec.record({ ...base, messages: [...base.messages, msg('middle-save')] });
  const later = { ...base, messages: [...base.messages, msg('later-save')] };
  const last = rec.rewrite(later, { redaction });
  const order = settleOrder([first, middle, last]);
  hold.release();
  assert.equal(rec.flushSync(), true);
  assert.deepEqual(
    parseSessionLog(readFileSync(logPath)).messages.map((m) => m.content),
    ['first [redacted]', 'later-save'],
    'the log is the later rewrite\'s state'
  );
  await Promise.all([first, middle, last]);
  assert.deepEqual(order, [0, 1, 2], 'every promise resolved, in acceptance order');
  await rec.close();
  assert.deepEqual(
    parseSessionLog(readFileSync(logPath)).messages.map((m) => m.content),
    ['first [redacted]', 'later-save'],
    'the async course moved nothing afterwards'
  );
  assert.deepEqual(holding(), []);
});

// Random sequences of record, fields and rewrite (marking a value first, or
// not), and an exit drain at each point the async course can be at.
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

for (const exit of ['before start', 'mid-batch', 'rename held', 'json rename refused']) {
  test(`interleaved records, fields and rewrites, exit ${exit}: the log is the last accepted state, every promise resolves in order, no file holds a marked value`, async (t) => {
    const renames = exit === 'rename held' || exit === 'json rename refused' ? refuseRenamesOnto(t, null) : null;
    for (let seed = 1; seed <= 20; seed += 1) {
      const random = seededRandom(seed * 7919);
      const { jsonPath, logPath, rec, marked, redactText, holding, redaction } = await sessionWithMarks();
      let resumeSync = null;
      if (exit === 'mid-batch') {
        holdNextSync = (resume) => {
          resumeSync = resume;
        };
      }
      const hold = renames;
      hold?.rearm(exit === 'rename held' ? logPath : jsonPath);
      const kinds = [];
      const accepted = [];
      let state = rec.loaded;
      let token = 0;
      const length = 3 + Math.floor(random() * 6);
      for (let i = 0; i < length; i += 1) {
        const r = random();
        const kind = r < 0.4 ? 'record' : r < 0.6 ? 'fields' : r < 0.8 ? 'rewrite' : 'mark, rewrite';
        kinds.push(kind);
        token += 1;
        if (kind === 'record') {
          state = { ...state, messages: [...state.messages, msg(`save ${token} tok-${token}`)] };
          accepted.push(rec.record(state));
        } else if (kind === 'fields') {
          state = { ...state, title: `t${token}` };
          accepted.push(rec.recordFields({ title: state.title }));
        } else {
          if (kind === 'mark, rewrite') marked.add(`tok-${Math.floor(random() * token)}`);
          accepted.push(rec.rewrite(state, { redaction }));
        }
      }
      const order = settleOrder(accepted);
      const what = `seed ${seed}: ${kinds.join(' → ')}; marked ${[...marked].join(', ') || 'none'}`;
      const settled = () => order.length === accepted.length;
      if (exit === 'mid-batch') await until(() => resumeSync !== null || settled());
      if (hold) await until(() => hold.refused() > 0 || settled());
      hold?.release();
      assert.equal(rec.flushSync(), true, what);
      holdNextSync = null;
      const expected = state.messages.map((m) => redactText(m.content));
      const onDisk = sessionFromLog(parseSessionLog(readFileSync(logPath)));
      assert.deepEqual(onDisk.messages.map((m) => m.content), expected, `${what}: the log is the last accepted state`);
      assert.equal(onDisk.title, state.title, what);
      assert.deepEqual(holding(), [], `${what}: no file holds a marked value`);
      await Promise.allSettled(accepted);
      assert.deepEqual(order, accepted.map((_, index) => index), `${what}: every promise resolved, in order`);
      resumeSync?.();
      await rec.close();
      const after = sessionFromLog(parseSessionLog(readFileSync(logPath)));
      assert.deepEqual(after.messages.map((m) => m.content), expected, `${what}: nothing moved afterwards`);
      assert.deepEqual(holding(), [], `${what}: nothing moved back`);
    }
  });
}

test('a redacted copy whose proof read fails leaves no temp file, and nothing moves', async (t) => {
  const { id, jsonPath, logPath, rec, redaction } = await sessionHoldingValue();
  const before = Object.fromEntries(
    readdirSync(root)
      .filter((name) => name.startsWith(`${id}.`))
      .map((name) => [name, readFileSync(join(root, name), 'utf8')])
  );
  const { readFileSync: realRead } = fs;
  fs.readFileSync = function (path, ...rest) {
    const name = String(path);
    if (name.startsWith(`${jsonPath}.`) && name.endsWith('.tmp')) {
      throw Object.assign(new Error(`EIO: i/o error, read '${name}'`), { code: 'EIO' });
    }
    return realRead.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = realRead;
    syncBuiltinESMExports();
  });
  await assert.rejects(rec.rewrite(rec.loaded, { redaction }), { code: 'EIO' });
  fs.readFileSync = realRead;
  syncBuiltinESMExports();
  const after = Object.fromEntries(
    readdirSync(root)
      .filter((name) => name.startsWith(`${id}.`))
      .map((name) => [name, readFileSync(join(root, name), 'utf8')])
  );
  assert.deepEqual(after, before, 'no temp file is left, and every file is as it was');
  assert.ok(existsSync(logPath));
  await rec.close();
});

test('flushSync writes everything queued, an in-flight batch included', async () => {
  const { id, logPath } = paths();
  const session = { id, messages: [] };
  const rec = await createSessionLog({ logPath, session, claim: fakeClaim() });
  session.messages = [msg('a')];
  void rec.record(session).catch(() => {});
  session.messages = [msg('a'), msg('b')];
  void rec.record(session).catch(() => {});
  assert.equal(rec.flushSync(), true);
  assert.deepEqual(parseSessionLog(readFileSync(logPath)).messages, session.messages);
  await rec.close();
  assert.deepEqual(parseSessionLog(readFileSync(logPath)).messages, session.messages);
});

test('immutable keys compare by reference; projected messages and transient keys', async () => {
  const { id, logPath } = paths();
  const catalog = Object.freeze([{ name: 'read' }]);
  const session = { id, catalog, liveTurnMessages: [1], messages: [] };
  const rec = await createSessionLog({
    logPath,
    session,
    claim: fakeClaim(),
    immutableKeys: ['catalog'],
    transientKeys: ['liveTurnMessages'],
  });
  session.title = 't';
  await rec.record(session);
  const patch = JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n').at(-1));
  assert.deepEqual(Object.keys(patch.set), ['title']);
  session.catalog = Object.freeze([{ name: 'read' }, { name: 'grep' }]);
  await rec.record(session);
  const next = JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n').at(-1));
  assert.deepEqual(Object.keys(next.set), ['catalog']);
  assert.equal(readFileSync(logPath, 'utf8').includes('liveTurnMessages'), false);
  await rec.close();
});
