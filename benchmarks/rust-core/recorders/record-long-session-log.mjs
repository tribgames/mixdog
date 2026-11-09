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
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const replay = await reader.readSessionLog(logPath);
const kinds = log.split('\n').slice(0, -1).map((line) => JSON.parse(line).t);
(await import(at('src/runtime/agent/orchestrator/session/store/session-writer-claim.mjs'))).releaseHeldSessionWriters();
rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

writeJson(join(FIXTURES_ROOT, 'long-session-log', 'log.json'), {
  id,
  log,
  kinds,
  replay: { valid: replay.valid, logId: replay.logId, header: replay.header, messages: replay.messages, replayFrom: replay.replayFrom },
});
writeSetManifest(join(FIXTURES_ROOT, 'long-session-log'), {
  set: 'long-session-log',
  recorder: 'benchmarks/rust-core/recorders/record-long-session-log.mjs',
  command: 'node benchmarks/rust-core/recorders/record-long-session-log.mjs --tree <git checkout at --commit, with node_modules> --commit <40-hex>',
  identity,
});
console.log(`recorded ${kinds.length} records: ${kinds.join(' ')}`);
process.exit(0);
