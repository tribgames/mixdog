// The model context Node rebuilds for each migration-corpus session: Node's own
// `loadSession(id).messages` as the next turn starts from them, past the leading `system`
// messages (those live in the migrated header; `request_system_corpus.mjs` proves them).
// Writes `model_context_corpus.json` beside this file; `mixdog-migrate`
// `tests/model_context_corpus.rs` compares the store's model-context read of the migrated
// corpus with it.
//
//   node generate_context.mjs [<corpus dir>] [<mixdog src dir>]
//
// Per session: `count`; `entries` = sha256 over the messages' corpus entries (role,
// content, toolCallId, toolCall ids; `corpus-lib.cjs`), one per line; `exact` = sha256 over
// the whole message objects (stable key order) of the messages the migration writes
// unchanged — every role but `user` (whose rows get typed facts) without the legacy replay
// fields `reasoningItems`/`thoughtParts` (converted) — each as `<index>:<json>` per line,
// the index counted from the first non-system message.
// Strings are taken well-formed (lone surrogates as U+FFFD), as the migration stores them.
//
// Node fixes its data dir when its modules load, so each scenario is read by a child run of
// this script (`--scenario <name> <data dir copy>`) over a copy of the scenario's data dir
// (Node's reader may create files).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = fileURLToPath(import.meta.url);

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const wellFormed = (v) => {
  if (typeof v === 'string') return v.toWellFormed();
  if (Array.isArray(v)) return v.map(wellFormed);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k.toWellFormed()] = wellFormed(x);
    return o;
  }
  return v;
};
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
const entry = (m) => [m.role, m.content === undefined ? null : m.content, m.toolCallId ?? null,
  (m.toolCalls || []).map((c) => c.id ?? c.toolCallId ?? null)];
const unchanged = (m) => m.role !== 'user' && !('reasoningItems' in m) && !('thoughtParts' in m);

async function readScenario(src, data) {
  process.env.MIXDOG_DATA_DIR = data;
  const store = join(src, 'runtime/agent/orchestrator/session/store');
  const { loadSession } = await import(pathToFileURL(join(store, 'load-session.mjs')).href);
  const { SESSION_LOG_SUFFIX } = await import(pathToFileURL(join(store, 'session-log-format.mjs')).href);
  const ids = [...new Set(readdirSync(join(data, 'sessions'))
    .map((f) => (f.endsWith('.json') ? f.slice(0, -5) : f.endsWith(SESSION_LOG_SUFFIX) ? f.slice(0, -SESSION_LOG_SUFFIX.length) : null))
    .filter(Boolean))].sort();
  const out = {};
  for (const id of ids) {
    const session = loadSession(id);
    if (!session || session.id !== id || !Array.isArray(session.messages)) {
      out[id] = { unreadable: true };
      continue;
    }
    const all = wellFormed(session.messages);
    const from = all.findIndex((m) => m.role !== 'system');
    const messages = from < 0 ? [] : all.slice(from);
    out[id] = {
      count: messages.length,
      entries: sha256(messages.map((m) => stable(entry(m))).join('\n')),
      exact: sha256(messages.map((m, i) => (unchanged(m) ? `${i}:${stable(m)}` : null)).filter((l) => l !== null).join('\n')),
    };
  }
  return out;
}

if (process.argv[2] === '--scenario') {
  const [src, data] = process.argv.slice(3);
  process.stdout.write(JSON.stringify(await readScenario(src, data)));
} else {
  const corpus = process.argv[2] || 'C:/Users/tempe/.mixdog/data/scratch/rust-core/migration-corpus';
  const src = process.argv[3] || 'C:/Project/mixdog/src';
  const scenarios = { v145: 'v145', dev146: 'dev146', 'fixture-busy-seed': 'fixture-busy-seed/data' };
  const out = {};
  for (const [name, rel] of Object.entries(scenarios)) {
    const data = mkdtempSync(join(tmpdir(), 'mixdog-context-golden-'));
    cpSync(join(corpus, rel), data, { recursive: true });
    const child = spawnSync(process.execPath, [script, '--scenario', src, data], { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (child.status !== 0) throw new Error(`${name}: ${child.stderr}`);
    out[name] = JSON.parse(child.stdout);
  }
  writeFileSync(join(here, 'model_context_corpus.json'), JSON.stringify(out, null, 1) + '\n');
}
