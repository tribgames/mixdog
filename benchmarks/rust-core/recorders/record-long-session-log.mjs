#!/usr/bin/env node
// Golden of the log a 1.4.5 daemon leaves for a session whose saves rebuild the first message
// (`native/core/fixtures/long-session-log/log.json`): real Node code saves a session through
// every record kind (`append`, `edit`, `rollback`, `patch`, a `compacted` that was asked for, and
// the `compacted` the writer falls back to when no message is shared by reference at either
// end), then replays the log with its own reader. The migration's streaming fold must give the
// replay's header and messages for the same bytes; `log` also fixes the record encodings the
// large synthetic transcript of `tests/long_log.rs` is written in.
//
//   node benchmarks/rust-core/recorders/record-long-session-log.mjs --tree <git checkout at --commit, with node_modules> --commit <40-hex>
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitCheckoutIdentity, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const repo = resolveTree(args);
const commit = args.get('commit') ?? (() => { throw new Error('--commit <40-hex> is required'); })();
const identity = commitCheckoutIdentity(repo, commit);
const home = mkdtempSync(join(tmpdir(), 'mixdog-long-log-'));
const data = join(home, 'data');
mkdirSync(join(data, 'sessions'), { recursive: true });
process.env.MIXDOG_HOME = home;
process.env.MIXDOG_DATA_DIR = data;
const at = (p) => pathToFileURL(join(repo, p)).href;

const store = await import(at('src/runtime/agent/orchestrator/session/store.mjs'));
const reader = await import(at('src/runtime/agent/orchestrator/session/store/session-log-reader.mjs'));

const id = 'sess_longlog';
const system = () => ({ role: 'system', content: 'You are a coding agent.\nRules \u2014 follow them \u{1F600}' });
const user = (n) => ({ role: 'user', content: `question ${n} \u2028 with "quotes"\n\ttab` });
const answer = (n) => ({ role: 'assistant', content: `answer ${n}`, usage: { input: n, output: n / 2 } });
const tool = (n) => ({ role: 'tool', tool_call_id: `call_${n}`, content: `output ${n}\nline two` });

const session = { id, owner: 'user', agent: 'lead', closed: false, generation: 0, updatedAt: 1700000000000, title: 'first', tags: ['a'], messages: [] };
const save = async (opts) => {
  session.updatedAt += 1;
  await store.saveSessionDurably(session, { immediate: true, ...opts });
};

session.messages = [system(), user(1), answer(1)];
await save(); // session + compacted
session.messages = [...session.messages, user(2), answer(2)];
await save(); // append
session.messages = [system(), ...session.messages.slice(1), user(3), answer(3)];
await save(); // nothing shared at either end: the whole history again
session.messages = [...session.messages.slice(0, 2), tool(9), ...session.messages.slice(3)];
await save(); // edit
session.messages = session.messages.slice(0, 4);
await save(); // rollback
session.title = 'second';
delete session.tags;
await save(); // patch
session.messages = [...session.messages, user(4), answer(4)];
await save({ compacted: true }); // compacted, asked for
for (let n = 5; n < 8; n += 1) {
  session.messages = [system(), ...session.messages.slice(1), user(n), answer(n)];
  await save(); // the whole history again, each time
}

const logPath = join(data, 'sessions', `${id}.log.jsonl`);
const log = readFileSync(logPath, 'utf8');
// Everything Node's reader returns for the bytes, none of it picked or reshaped.
const readBack = async (path) => {
  const r = await reader.readSessionLog(path);
  return {
    valid: r.valid, logId: r.logId, sessionId: r.sessionId, prev: r.prev, legacy: r.legacy, seq: r.seq, header: r.header,
    messages: r.messages, messageCount: r.messageCount, size: r.size, tornTail: r.tornTail, skipped: r.skipped,
    damage: r.damage, replayFrom: r.replayFrom,
  };
};
const replay = await readBack(logPath);
const kinds = log.split('\n').slice(0, -1).map((line) => JSON.parse(line).t);
(await import(at('src/runtime/agent/orchestrator/session/store/session-writer-claim.mjs'))).releaseHeldSessionWriters();
rmSync(home, { recursive: true, force: true });

// The same log with lines Node's reader does not count as records, a partial tail, CRLF line ends and bytes
// that are not UTF-8: each as bytes, with what Node reads from them.
const lines = log.split('\n').slice(0, -1);
const last = lines.length;
const blank = [lines[0], '', lines[1], '', '', ...lines.slice(2), ''].join('\n') + '\n';
const malformed = [lines[0], '{"t":"append","s":2,"len":', lines[1], 'not json at all', ...lines.slice(2), '{"t":"patch"}'].join('\n') + '\n';
const unknown = [
  lines[0],
  lines[1],
  '{"t":"future","s":2}',
  '[1,2]',
  '"text"',
  `{"t":"append","s":${last},"len":9,"messages":[]}`,
  ...lines.slice(2),
  `{"t":"session","s":${last},"v":1}`,
].join('\n') + '\n';
const tail = `${log}{"t":"append","s":${last},"len":9,"mess`;
const crlf = lines.join('\r\n') + '\r\n';
const invalidUtf8 = Buffer.from(log.replace('answer 7', 'answer \u0001'), 'utf8');
invalidUtf8[invalidUtf8.indexOf(0x01)] = 0xff;
const mixed = [lines[0], '', '{"t":"future","s":1}', lines[1], 'not json', ...lines.slice(2)].join('\r\n') + '\r\n{"t":"append","s":' + last + ',"len":';
// Where Node's replay stops (`damage`): a record that does not follow the history before it. Every record after
// it is left in the file; the replay is the records before it.
const broken = (index, change) => {
  const copy = lines.slice();
  const record = JSON.parse(copy[index]);
  change(record);
  copy[index] = JSON.stringify(record);
  return Buffer.from(copy.join('\n') + '\n');
};
const kindIndex = (kind) => kinds.indexOf(kind);
const damage = {
  'sequence gap': broken(10, (r) => { r.s = 11; }),
  'sequence repeated': broken(10, (r) => { r.s = 9; }),
  'append length mismatch': broken(kindIndex('append'), (r) => { r.len += 1; }),
  'edit past the history': broken(kindIndex('edit'), (r) => { r.at = 999; }),
  'edit length mismatch': broken(kindIndex('edit'), (r) => { r.len += 1; }),
  'rollback past the history': broken(kindIndex('rollback'), (r) => { r.len = 999; }),
  'damage with skipped lines and a partial tail': Buffer.from(
    [...broken(10, (r) => { r.s = 11; }).toString().split('\n').slice(0, -1), '', 'not json'].join('\n') + `\n{"t":"append","s":10,"len":`,
  ),
  'second record is not the history': Buffer.from([lines[0], JSON.stringify({ ...JSON.parse(lines[2]), s: 1 }), ...lines.slice(3)].join('\n') + '\n'),
  'history before the session': Buffer.from([JSON.stringify({ ...JSON.parse(lines[1]), s: 0 }), ...lines.slice(2)].join('\n') + '\n'),
  'a session record alone': Buffer.from(`${lines[0]}\n`),
};
const caseBytes = {
  ...damage,
  'blank lines': Buffer.from(blank),
  'malformed lines': Buffer.from(malformed),
  'unknown records': Buffer.from(unknown),
  'partial tail': Buffer.from(tail),
  'CRLF line ends': Buffer.from(crlf),
  'invalid UTF-8 in a message': invalidUtf8,
  'all of them': Buffer.from(mixed),
};
const casesDir = mkdtempSync(join(tmpdir(), 'mixdog-long-log-cases-'));
const cases = [];
for (const [name, bytes] of Object.entries(caseBytes)) {
  const path = join(casesDir, `${id}.log.jsonl`);
  writeFileSync(path, bytes);
  cases.push({ name, id, bytes: bytes.toString('base64'), replay: await readBack(path) });
}

// A long log in the shape 1.4.5 gives a long session: the whole history again in every snapshot. Written by this
// generator through Node's own record encoders; the Rust test regenerates the bytes from `params` and must get the
// recorded `logSha256` before it migrates them.
const format = await import(at('src/runtime/agent/orchestrator/session/store/session-log-format.mjs'));
const params = { id: 'sess_big', logId: '0123456789abcdef01234567', start: 60, rounds: 70, editEvery: 25, repeat: 40 };
const bigMessage = (n) => ({
  role: ['user', 'assistant', 'tool'][n % 3],
  content: `message ${n}\n\t"quoted" ${'\u00e9\u{1F600} text '.repeat(params.repeat)}`,
});
const bigPath = join(casesDir, `${params.id}.log.jsonl`);
const bigHash = createHash('sha256');
const bigFd = openSync(bigPath, 'w');
let bigBytes = 0;
const put = (text) => {
  const buf = Buffer.from(text);
  writeSync(bigFd, buf);
  bigHash.update(buf);
  bigBytes += buf.length;
};
const history = [{ role: 'system', content: 'You are a coding agent.' }];
for (let n = 0; n < params.start; n += 1) history.push(bigMessage(n));
const jsons = () => history.map(format.messageJson);
let next = params.start;
put(format.encodeSessionRecord({ logId: params.logId, id: params.id, header: { id: params.id, title: 'first', updatedAt: 1 } }));
put(format.encodeCompacted(1, jsons()));
let seq = 2;
for (let round = 0; round < params.rounds; round += 1) {
  const added = [bigMessage(next), bigMessage(next + 1)];
  next += 2;
  history.push(...added);
  put(format.encodeAppend(seq, history.length, added.map(format.messageJson)));
  put(format.encodePatch(seq + 1, new Map([['updatedAt', JSON.stringify(round + 2)]]), []));
  seq += 2;
  history.push(bigMessage(next), bigMessage(next + 1));
  next += 2;
  put(format.encodeCompacted(seq, jsons()));
  seq += 1;
  if (round % params.editEvery === 0) {
    const index = history.length - 1;
    history[index] = bigMessage(next);
    next += 1;
    put(format.encodeEdit(seq, history.length, index, 1, [format.messageJson(history[index])]));
    seq += 1;
  }
}
history.pop();
put(format.encodeRollback(seq, history.length));
put(format.encodePatch(seq + 1, new Map([['title', JSON.stringify('last')]]), ['updatedAt']));
put(`{"t":"append","s":${seq + 2},"len":${history.length + 1},"mess`);
closeSync(bigFd);
const large = { params, logBytes: bigBytes, logSha256: bigHash.digest('hex'), replay: await readBack(bigPath) };
rmSync(casesDir, { recursive: true, force: true });

writeJson(join(FIXTURES_ROOT, 'long-session-log', 'log.json'), { id, log, kinds, replay, cases });
writeJson(join(FIXTURES_ROOT, 'long-session-log', 'large.json'), large);
writeSetManifest(join(FIXTURES_ROOT, 'long-session-log'), {
  set: 'long-session-log',
  recorder: 'benchmarks/rust-core/recorders/record-long-session-log.mjs',
  command: 'node benchmarks/rust-core/recorders/record-long-session-log.mjs --tree <git checkout at --commit, with node_modules> --commit <40-hex>',
  identity,
});
console.log(`recorded ${kinds.length} records: ${kinds.join(' ')}; ${cases.length} cases; large log ${bigBytes} bytes, ${large.replay.messages.length} messages`);
process.exit(0);
