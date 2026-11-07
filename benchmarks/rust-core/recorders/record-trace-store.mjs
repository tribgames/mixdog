// Records the SQL and bound parameters Node's trace store (memory/lib/trace-store.mjs, the sink
// behind /admin/trace-record) sends to Postgres, for native/core/fixtures/agent-trace/
// trace-store-golden.json. No database runs: a copy of memory/lib has its pg/adapter.mjs replaced by
// a stub whose pool records every statement, so the real trace-store, trace-mode and agent-call
// modules produce the statements.
//
//   MIXDOG_REPO=<node tree> node record-trace-store.mjs <out.json>
//
// MIXDOG_DATA_DIR (and HOME/APPDATA) point at a fresh temp directory and Date.now is a fake clock,
// both set before any Mixdog module is imported.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const T0 = 1700000000000;
const root = mkdtempSync(join(tmpdir(), 'trace-store-golden-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.APPDATA = root;
process.env.LOCALAPPDATA = root;
process.env.MIXDOG_QUIET_MEMORY_LOG = '1';
delete process.env.MIXDOG_TRACE_RETENTION_DAYS;
Date.now = () => T0;

const lib = join(root, 'lib');
cpSync(join(resolve(process.env.MIXDOG_REPO), 'src/runtime/memory/lib'), lib, { recursive: true });
writeFileSync(
  join(lib, 'pg/adapter.mjs'),
  `
const rec = globalThis.__traceRec;
function respond(sql) {
  if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
  if (sql.includes("nspname = 'trace'\\n      ) AS present") || sql.includes('AS present')) return { rows: [{ present: true }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}
function client(group) {
  return {
    async query(sql, params) {
      rec.current().push({ group, sql, params: params ?? null });
      return respond(sql);
    },
    release() {},
  };
}
let n = 0;
const pool = { async connect() { return client('client' + n++); } };
const db = { _pool: pool, async query(sql, params) { rec.current().push({ group: 'db', sql, params: params ?? null }); return respond(sql); }, async close() {} };
export async function ensurePgInstance() { return { db }; }
export async function checkedConnect(p, schema) {
  const c = await p.connect();
  await c.query('SET search_path = ' + (schema === 'trace' ? 'trace, public' : schema));
  return c;
}
export async function closePgInstance() {}
`,
);
const phases = {};
let currentPhase = null;
globalThis.__traceRec = {
  current: () => phases[currentPhase],
};
function phase(name) {
  currentPhase = name;
  phases[name] = [];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = await import(pathToFileURL(join(lib, 'trace-store.mjs')).href);

const events = [
  { sessionId: 's1', iteration: 1, kind: 'tool', toolName: 'read', toolKind: 'builtin', toolMs: 12, toolArgs: { path: '/a', n: 1 }, resultKind: 'ok', ts: 1700000000100 },
  { session_id: 's1', iteration: '2', kind: 'tool', tool_name: 'shell', tool_ms: 7, tool_args: '{"command":"ls"}', result_kind: 'error', result_error_category: 'exit', result_error_first_line: 'boom', ts: '2024-01-02T03:04:05.678Z' },
  { session_id: 's2', kind: 'tool', tool_name: 'read', tool_args: 'just a path', ts: 1700000000300 },
  { session_id: 's2', kind: 'tool', tool_name: 'write', tool_args: { content: 'x'.repeat(70000) }, ts: 1700000000400 },
  { session_id: 's2', kind: 'tool', tool_name: 'write', tool_args: `${'a'.repeat(511)}😀${'b'.repeat(70000)}`, ts: 1700000000450 },
  { session_id: 's1', iteration: 3, kind: 'usage_raw', model: 'm-1', input_tokens: 10, output_tokens: 5, cached_tokens: 2, cache_write_tokens: 1, prompt_tokens: 13, response_id: 'r1', payload: { raw_usage: { a: 1 } }, ts: 1700000000500 },
  { sessionId: 's3', kind: 'x', inputTokens: 4, input_tokens: 9, output_tokens: 8, model: 'm-2', ts: '2025-03-04T05:06:07.000Z' },
  { session_id: 'p1', kind: 'preset_assign', agent: 'worker', model: 'm-9', ts: 1700000000600 },
  { session_id: 's1', kind: 'preset_assign', agent: 'lead', ts: 1700000000700 },
  { kind: 'loop', payload: '{"a":1}', duration_ms: 3, error_message: 'e', parent_span_id: 5, entry_id: '6' },
  { session_id: 's4', ts: 'garbage', payload: null },
  { session_id: 's5', kind: 'usage_raw', input_tokens: 1, output_tokens: 2, ts: 1700000001000, iteration: 9 },
];

process.env.MIXDOG_TRACE = '0';
phase('disabled');
const off = await store.openTraceDatabase(process.env.MIXDOG_DATA_DIR);
if (off !== null) throw new Error('trace should be disabled');

process.env.MIXDOG_TRACE = '1';
phase('open');
const db = await store.openTraceDatabase(process.env.MIXDOG_DATA_DIR);
await sleep(50);

phase('insertTraceEvents');
await store.insertTraceEvents(db, structuredClone(events));
phase('insertAgentCalls');
await store.insertAgentCalls(db, structuredClone(events));

// Non-object elements of `events`: null throws on the first property read; any other value reads
// as an object with no keys and stores a default row.
const nonObject = {};
const message = async (run) => {
  try {
    await run();
  } catch (error) {
    return error.message;
  }
  return null;
};
nonObject.traceEvents = await message(() => store.insertTraceEvents(db, [{ kind: 'a' }, null]));
nonObject.agentCalls = await message(() => store.insertAgentCalls(db, [{ kind: 'a', session_id: 's' }, null]));
nonObject.primitives = [5, 'x', [], true];
phase('primitives');
await store.insertTraceEvents(db, structuredClone(nonObject.primitives));
nonObject.primitivesSql = phases.primitives;

writeFileSync(
  process.argv[2],
  `${JSON.stringify(
    {
      note: 'recorded by benchmarks/rust-core/recorders/record-trace-store.mjs against Node (statements captured at a stub pool); fake clock T0',
      now: T0,
      events,
      disabled: phases.disabled,
      open: phases.open,
      insertTraceEvents: phases.insertTraceEvents,
      insertAgentCalls: phases.insertAgentCalls,
      nonObject,
    },
    null,
    1,
  )}\n`,
);
rmSync(root, { recursive: true, force: true });
process.exit(0);
