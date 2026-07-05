// Explore quality bench — round-based tuning harness.
//
// Runs a fixed query set through runExplore against this repo, then reads
// agent-trace.jsonl to report per-session tool-call counts, wall time, and
// anchor quality. Usage:
//   node scripts/explore-bench.mjs [roundLabel]
// Fresh process per run = no in-memory result cache carryover.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { runExplore } from '../src/standalone/explore-tool.mjs';

const ROUND = process.argv[2] || 'r0';
const CWD = 'C:/Project/mixdog';

// Representative locator queries with ground truth: expect = substrings, at
// least one must appear in the anchor output (quality hit). expectFail = the
// correct answer is EXPLORATION_FAILED (miss discipline).
const QUERIES = [
  {
    q: 'where is the tool-call stall watchdog policy resolved and what defaults does it use',
    expect: ['agent-progress-watchdog', 'stall-policy'],
  },
  {
    q: 'session compact / smart compact trigger threshold logic',
    expect: ['compact'],
  },
  {
    q: 'where are hidden agent tool schema profiles defined (read / read-write-search)',
    expect: ['agent-dispatch', 'agents.json', 'internal-agents'],
  },
  {
    q: 'recall memory chunk importance scoring implementation',
    expect: ['importance', 'memory'],
  },
  {
    q: 'websocket reconnect backoff handling',
    expect: ['openai-oauth-ws', 'retry-classifier'],
  },
  // ── extended set: symbol-exact, filename, error-string, korean, flow, config ──
  {
    q: 'buildExplorerPrompt definition', // exact known symbol
    expect: ['explore-tool'],
  },
  {
    q: 'where does the explore tool cache results and what is the TTL',
    expect: ['explore-tool'],
  },
  {
    q: 'error text "maintenance route unresolved for agent" — where is it thrown',
    expect: ['agent-dispatch'],
  },
  {
    q: '에이전트 세션의 최대 루프 반복 횟수는 어디서 정해져?', // korean concept query
    expect: ['agent-loop-policy'],
  },
  {
    q: 'how does a fixed agent slot map to a workflow slot (explore/explorer)',
    expect: ['mixdog-session-runtime', 'internal-agents'],
  },
  {
    q: 'where is the mixdog config json file path resolved (data dir)',
    expect: ['config', 'plugin-paths'],
  },
  {
    q: 'GraphQL schema stitching resolver implementation', // not in this repo
    expectFail: true,
  },
];

function tracePath() {
  return process.env.MIXDOG_AGENT_TRACE_PATH
    || join(process.env.MIXDOG_DATA_DIR || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data'), 'history', 'agent-trace.jsonl');
}

function readTraceSince(ts) {
  const p = tracePath();
  if (!existsSync(p)) return [];
  const rows = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.ts >= ts && r.agent === 'explorer') rows.push(r);
    } catch { /* skip */ }
  }
  return rows;
}

const t0 = Date.now();
// Parallel round: all queries fire at once. Per-session trace attribution is
// by session_id so counts stay correct; per-query ms includes queueing.
const results = await Promise.all(QUERIES.map(async ({ q, expect, expectFail }) => {
  const qt0 = Date.now();
  const res = await runExplore({ query: q, cwd: CWD }, { callerCwd: CWD });
  const text = res?.content?.[0]?.text || '';
  const anchors = text.split('\n').filter((l) => /:\d+/.test(l)).length;
  const failed = /EXPLORATION_FAILED/.test(text);
  const lower = text.toLowerCase();
  const hit = expectFail
    ? (failed && anchors === 0)
    : (!failed && (expect || []).some((e) => lower.includes(e.toLowerCase())));
  return { q: q.slice(0, 48), ms: Date.now() - qt0, anchors, failed, hit, bytes: text.length };
}));

// Attribute tool calls per explorer session spawned during this run.
const rows = readTraceSince(t0);
const bySession = new Map();
for (const r of rows) {
  if (r.kind !== 'tool') continue;
  const s = bySession.get(r.session_id) || { calls: 0, tools: [] };
  s.calls++; s.tools.push(r.tool_name);
  bySession.set(r.session_id, s);
}
const callCounts = [...bySession.values()].map((s) => s.calls).sort((a, b) => a - b);
const p50 = callCounts[Math.floor(callCounts.length / 2)] ?? 0;

console.log(`\n=== explore-bench round=${ROUND} ===`);
for (const r of results) {
  console.log(`  [${String(r.ms).padStart(6)}ms] ${r.hit ? 'HIT ' : 'MISS'} anchors=${r.anchors} failed=${r.failed} bytes=${r.bytes}  ${r.q}`);
}
console.log(`  quality: ${results.filter((r) => r.hit).length}/${results.length} hits`);
console.log(`  sessions=${bySession.size} toolcalls p50=${p50} max=${callCounts[callCounts.length - 1] ?? 0} total=${callCounts.reduce((a, b) => a + b, 0)}`);
for (const [id, s] of bySession) console.log(`    ${id.slice(-8)}: ${s.tools.join(',')}`);
console.log(`  wall total=${((Date.now() - t0) / 1000).toFixed(1)}s`);
