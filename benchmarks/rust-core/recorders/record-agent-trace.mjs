// Records the agent-trace golden: what Node's appendAgentTrace / logLlmCall / traceAgentCompact /
// _appendToolFailureRow leave on disk, for native/core/fixtures/agent-trace/golden.json.
//
//   MIXDOG_REPO=<node tree> node record-agent-trace.mjs <out golden.json>
//
// The parent makes a fresh temp MIXDOG_DATA_DIR and runs itself as a child with that directory set
// BEFORE any Mixdog module is imported (import-time sweeps delete real data otherwise); the child
// writes through the real modules and exits (the exit hook flushes tool-failures.jsonl), and the
// parent reads the files back. Date.now is a fake clock so ts-less rows and the rotation throttle
// are deterministic; the Rust test replays the same cases with the same clock.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const T0 = 1700000000000;
const BIG_BLOB = 10 * 1024 * 1024 + 10;
const KEEP = 2;

const cases = [
  { op: 'append', record: { sessionId: 's1', kind: 'loop', iteration: 2, payload: { a: 1 } } },
  { op: 'append', record: { kind: 'x', ts: '2024-01-02T03:04:05.678Z', session_id: 'given', payload: null } },
  { op: 'append', record: { kind: 'y' } },
  {
    op: 'append',
    record: {
      kind: 'z',
      ts: 0,
      sessionId: 42,
      n: 1.5,
      big: 1e21,
      small: 1e-7,
      '10': 2,
      k2: 1,
      '2': 3,
      text: 'é\u2028\ud800"\n\t\u0001 日本 😀',
      nested: { b: [1, null, 'two', { c: true }], a: 0 },
    },
  },
  { op: 'append', record: { kind: 'bad-ts', ts: 'garbage', sessionId: 'g' } },
  { op: 'append', record: { kind: 'num-ts', ts: 1700000000123, sessionId: 'n', sessionId2: null } },
  { op: 'append', record: { kind: 'false-session', sessionId: '', session_id: null } },
  {
    op: 'compact',
    input: {
      sessionId: 'c1',
      iteration: 3,
      stage: 'pre-send',
      trigger: 'auto',
      compact_changed: 1,
      input_prefix_hash: 'abc123',
      before_count: 40,
      after_count: 12,
      before_bytes: 90000,
      after_bytes: 30000,
      context_window: 200000,
      budget_tokens: 150000,
      boundary_tokens: 0,
      duration_ms: 12.5,
      provider: 'anthropic',
      model: 'm-1',
      error: '',
      recovered_error: { code: 'E_X', message: `${'a'.repeat(297)}😀tail` },
      details: { why: 'size', list: [1, 2] },
    },
  },
  { op: 'compact', input: { sessionId: 'c-lone', recovered_error: { code: 1, message: `${'a'.repeat(298)}😀tail` } } },
  { op: 'compact', input: { sessionId: 'c2', recovered_error: { message: 7 }, details: 'not-an-object' } },
  { op: 'compact', input: { stage: 0, compact_changed: 0, recovered_error: [], details: [1] } },
  {
    op: 'usage',
    maintenance: false,
    entry: {
      ts: '2025-03-04T05:06:07.000Z',
      sourceType: 'lead',
      sourceName: null,
      preset: 'p',
      model: 'm-1',
      provider: 'anthropic',
      mode: 'side-question',
      duration: 1234,
      profileId: null,
      sessionId: 'u1',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 3,
      promptTokens: 13,
      prefixHash: 'deadbeef',
      costUsd: 0.000123,
      transportTiming: null,
    },
  },
  { op: 'usage', maintenance: true, entry: { model: 'm-2', provider: 'openai', payload: null, sessionId: 'u2' } },
  { op: 'usage', maintenance: false, entry: { model: 'm-3', provider: 'x', payload: { k: 1 }, kind: 'override', ts: 5 } },
];

const failureRows = [
  { ts: T0, session_id: 's1', tool: 'edit', category: 'x', first_line: 'é"\n' },
  { ts: T0 + 1, tool: 'shell', exit: 1 },
];

function big(i) {
  return { kind: 'big', ts: T0 + i, sessionId: 'rot', payload: { n: i, blob: 'x'.repeat(BIG_BLOB) } };
}
function small(i) {
  return { kind: 'small', ts: T0 + i, sessionId: 'rot', payload: { n: i } };
}

if (process.argv[2] === '--child') {
  let now = T0;
  Date.now = () => now;
  const root = resolve(process.env.MIXDOG_REPO);
  const orch = (name) => pathToFileURL(join(root, 'src/runtime/agent/orchestrator', name)).href;
  const io = await import(orch('agent-trace-io.mjs'));
  const fmt = await import(orch('agent-trace-format.mjs'));
  const usage = await import(orch('usage-log.mjs'));
  if (process.argv[3] === 'cases') {
    for (const c of cases) {
      if (c.op === 'append') io.appendAgentTrace(structuredClone(c.record));
      else if (c.op === 'compact') fmt.traceAgentCompact(structuredClone(c.input));
      else usage.logLlmCall(structuredClone(c.entry), { maintenance: c.maintenance });
    }
    await io.drainAgentTrace();
    for (const row of failureRows) io._appendToolFailureRow(structuredClone(row));
  } else {
    // Three big rows with KEEP=2 so the oldest generation is overwritten.
    for (let i = 1; i <= 3; i += 1) {
      io.appendAgentTrace(big(i));
      await io.drainAgentTrace();
      now += 10;
      io.appendAgentTrace(small(i));
      await io.drainAgentTrace();
      now += 10;
    }
  }
  process.exit(0);
}

function runChild(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-trace-golden-'));
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    MIXDOG_REPO: process.env.MIXDOG_REPO,
    MIXDOG_DATA_DIR: dir,
    HOME: dir,
    USERPROFILE: dir,
    APPDATA: dir,
    LOCALAPPDATA: dir,
    MIXDOG_DIAGNOSTICS: '1',
    MIXDOG_AGENT_TRACE_ROTATE_CHECK_MS: '1',
    MIXDOG_AGENT_TRACE_ROTATE_KEEP: String(KEEP),
  };
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', mode], { env, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`child ${mode} failed: ${run.stderr}`);
  return dir;
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const casesDir = runChild('cases');
const rotDir = runChild('rot');
const rotHistory = join(rotDir, 'history');
const rotation = readdirSync(rotHistory)
  .sort()
  .map((name) => {
    const buf = readFileSync(join(rotHistory, name));
    return { name, bytes: buf.length, sha256: sha(buf) };
  });
writeFileSync(
  process.argv[2],
  `${JSON.stringify(
    {
      note: 'recorded by benchmarks/rust-core/recorders/record-agent-trace.mjs against Node; fake clock: ts-less rows use 1700000000000',
      now: T0,
      keep: KEEP,
      bigBlobLen: BIG_BLOB,
      cases,
      jsonl: readFileSync(join(casesDir, 'history', 'agent-trace.jsonl'), 'utf8'),
      failureRows,
      failuresJsonl: readFileSync(join(casesDir, 'history', 'tool-failures.jsonl'), 'utf8'),
      rotation,
    },
    null,
    1,
  )}\n`,
);
rmSync(casesDir, { recursive: true, force: true });
rmSync(rotDir, { recursive: true, force: true });