#!/usr/bin/env node
// Golden of the session log a 1.4.5 daemon writes for a conversation
// (`native/core/fixtures/session-log-export/session_log.json`): real Node code saves a session
// and the `<id>.log.jsonl` it leaves is recorded with the `logId` Node generated. Rust's hook
// transcript export (`mixdog-core-session` `transcript_export::render`) must write the same
// bytes for the same id, header, messages and log id.
//
//   node benchmarks/rust-core/recorders/record-session-log-export.mjs --tree <dir>
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const repo = resolveTree(parseArgs());
const home = mkdtempSync(join(tmpdir(), 'mixdog-log-export-'));
const data = join(home, 'data');
mkdirSync(join(data, 'sessions'), { recursive: true });
process.env.MIXDOG_HOME = home;
process.env.MIXDOG_DATA_DIR = data;
const at = (p) => pathToFileURL(join(repo, p)).href;

const store = await import(at('src/runtime/agent/orchestrator/session/store.mjs'));

// Keys in Node's own order, the messages among them: the header is the record without them.
const record = {
  id: 'sess_export',
  owner: 'user',
  agent: 'lead',
  sourceType: 'lead',
  closed: false,
  generation: 0,
  messages: [
    { role: 'user', content: 'Read src/a.txt \u2014 and say "hi" \u{1F600}\n\ttab \u2028 line sep \u0001' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"src/a.txt"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'line one\nline two' },
    { role: 'assistant', content: 'Done.', usage: { input: 12, output: 3.5, cached: 0.1, big: 1e21, small: 1e-7 }, flag: null },
  ],
  updatedAt: 1700000000000,
  cwd: 'C:\\mixdog-golden\\project',
  tags: ['a', 'b'],
  tools: [],
};
await store.saveSessionDurably(structuredClone(record));
const log = readFileSync(join(data, 'sessions', `${record.id}.log.jsonl`), 'utf8');
const logId = JSON.parse(log.split('\n')[0]).logId;
(await import(at('src/runtime/agent/orchestrator/session/store/session-writer-claim.mjs'))).releaseHeldSessionWriters();
rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

writeJson(join(FIXTURES_ROOT, 'session-log-export', 'session_log.json'), { record, logId, log });
writeSetManifest(join(FIXTURES_ROOT, 'session-log-export'), {
  set: 'session-log-export',
  recorder: 'benchmarks/rust-core/recorders/record-session-log-export.mjs',
  command: 'node benchmarks/rust-core/recorders/record-session-log-export.mjs --tree <tree>',
  identityTree: repo,
});
console.log(`recorded ${log.split('\n').length - 1} lines`);
process.exit(0);
