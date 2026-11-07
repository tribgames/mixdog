// Writes native/core/crates/mixdog-services/src/memory/trace/sql.rs from the recorded golden, so
// every statement is Node's own text byte for byte (indentation and newlines included).
//   node gen-trace-store-sql.mjs <trace-store-golden.json> <sql.rs>
import { readFileSync, writeFileSync } from 'node:fs';

const g = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const boot = g.open.filter((r) => r.group === 'client0').map((r) => r.sql);
const retention = g.open.filter((r) => r.group === 'client1').map((r) => r.sql);
const calls = g.insertAgentCalls.map((r) => r.sql);

const raw = (s) => {
  let hashes = '#';
  while (s.includes(`"${hashes}`)) hashes += '#';
  return `r${hashes}"${s}"${hashes}`;
};
const one = (name, doc, sql) => `/// ${doc}\npub(super) const ${name}: &str = ${raw(sql)};\n`;
const many = (name, doc, list) =>
  `/// ${doc}\npub(super) const ${name}: [&str; ${list.length}] = [\n${list.map((s) => `    ${raw(s)},`).join('\n')}\n];\n`;

const need = (cond, what) => {
  if (!cond) throw new Error(`unexpected recorded sequence: ${what}`);
};
need(boot.length === 63, 'bootstrap length');
need(retention.length === 8, 'retention length');
const idx = {
  setPath: 0,
  tryLock: 1,
  complete: 2,
  legacy: 3,
  initTables: [4, 5, 6],
  drift: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
  indexes: [18, 19, 20, 21, 22, 23, 24, 25],
  partitions: 26,
  agentTables: [38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50],
  unlock: 62,
};
need(boot[27] === boot[7] && boot[37] === boot[17] && boot[51] === boot[7] && boot[61] === boot[17], 'drift repeats');
let out = `//! Node's trace-store SQL, generated from the recorded golden by benchmarks/rust-core/recorders/
//! gen-trace-store-sql.mjs (do not edit by hand): the text is what \`trace-store.mjs\` sends, byte for byte.

`;
out += one('SET_SEARCH_PATH', 'Per-connection path of the trace schema (`adapter.mjs` `_initClient`).', boot[idx.setPath]);
out += one('TRY_LOCK', 'Session-scoped bootstrap lock, non-blocking first.', boot[idx.tryLock]);
out += one('UNLOCK', 'Releases the bootstrap lock.', boot[idx.unlock]);
out += one('IS_BOOTSTRAP_COMPLETE', '`isBootstrapComplete`.', boot[idx.complete]);
out += one('LEGACY_TABLE_LOOKUP', '`maybeDropLegacyTable`: the lookup.', boot[idx.legacy]);
out += one('DROP_LEGACY_TABLE', '`maybeDropLegacyTable`: the drop.', 'DROP TABLE trace.trace_events CASCADE');
out += many('INIT_TABLES', '`init`: partitioned root, default partition, previous month.', idx.initTables.map((i) => boot[i]));
out += many('DRIFT', '`migrateSchemaDrift`, BEGIN to COMMIT.', idx.drift.map((i) => boot[i]));
out += many('INIT_INDEXES', '`init`: the trace_events indexes.', idx.indexes.map((i) => boot[i]));
out += one('ENSURE_PARTITIONS', '`ensureCurrentAndNextMonthPartitions`.', boot[idx.partitions]);
out += many('AGENT_TABLES', '`initAgentTables` between its two drift repairs.', idx.agentTables.map((i) => boot[i]));
out += one('DROP_AGED_PARTITIONS', '`dropAgedTracePartitions` ({days} is the retention days).', retention[2].replace("interval '7 days'", "interval '{days} days'"));
out += one('PRUNE_TRACE_EVENTS', '`pruneAgedTraceRows`: trace_events.', retention[3]);
out += one('PRUNE_TABLE_TEMPLATE', '`pruneAgedTraceRows`: the other tables; `{table}` is replaced.', retention[4].replaceAll('agent_calls', '{table}'));
need(retention[5] === retention[4].replaceAll('agent_calls', 'agent_llm'), 'prune template');
out += one('INSERT_TOOL_ROWS', '`insertToolRows`.', calls[2]);
out += one('INSERT_LLM_ROWS', '`insertLlmRows`.', calls[3]);
out += one('UPSERT_SESSIONS', '`upsertAgentSessions`.', calls[4]);
out += one('TRACE_NAMESPACE_PRESENT', '`cleanupTraceWhenDisabled`: is there a trace schema.', g.disabled[0].sql);
out += one('DROP_TRACE_SCHEMA', '`cleanupTraceWhenDisabled`: drop it.', g.disabled[1].sql);
writeFileSync(process.argv[3], out);
