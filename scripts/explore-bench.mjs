// Explore quality bench — round-based tuning harness.
//
// Runs a fixed query set through runExplore against this repo, then reads
// agent-trace.jsonl to report per-session tool-call counts, wall time, and
// anchor quality. Usage:
//   node scripts/explore-bench.mjs [roundLabel]
// Fresh process per run = no in-memory result cache carryover.
import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { runExplore } from '../src/standalone/explore-tool.mjs';

const ROUND = process.argv[2] || 'r0';
const CWD = 'C:/Project/mixdog';

// Anchor helpers: an anchor line carries a `path:line`. Strict quality =
// expected token must land ON such a line (not merely somewhere in the text),
// and anchors===0 is always a miss (except expectFail). Spot-accuracy verifies
// the referenced file exists and the line number is within the file length.
function anchorLinesOf(text) {
  return text.split('\n').filter((l) => /:\d+/.test(l));
}
function checkAnchorLine(line, ctxTokens = []) {
  const m = line.match(/([A-Za-z0-9_.\/\\-]+):(\d+)/);
  if (!m) return null; // no parseable path:line
  const p = m[1];
  const ln = Number(m[2]);
  const full = isAbsolute(p) ? p : join(CWD, p);
  if (!existsSync(full)) return false;
  try {
    const fileLines = readFileSync(full, 'utf8').split('\n');
    if (!(ln >= 1 && ln <= fileLines.length)) return false;
    // Fabricated-line guard: the cited line's ±2 window must contain a
    // query/expected token, so a plausible-but-wrong line number fails.
    if (ctxTokens.length) {
      // ±2 lines around the 1-based cited line (indices ln-3 .. ln+1 inclusive).
      const win = fileLines.slice(Math.max(0, ln - 3), ln + 2).join('\n').toLowerCase();
      if (!ctxTokens.some((t) => win.includes(t))) return false;
    }
    return true;
  } catch { return false; }
}

// High-fanout timing attribution: emit lightweight per-iteration send_ms
// loop rows (no verbose payload estimate) so we can split LLM send time
// from tool time under the parallel round below. Trace-only; no behavior
// or provider change.
if (!process.env.MIXDOG_AGENT_TRACE_TIMING) process.env.MIXDOG_AGENT_TRACE_TIMING = '1';

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
    q: '\uC5D0\uC774\uC804\uD2B8 \uC138\uC158\uC758 \uCD5C\uB300 \uB8E8\uD504 \uBC18\uBCF5 \uD69F\uC218\uB294 \uC5B4\uB514\uC11C \uC815\uD574\uC838?', // korean concept query
    expect: ['agent-loop-policy'],
  },
  {
    q: 'how does a fixed agent slot map to a workflow slot (explore/explorer)',
    expect: ['session-runtime/workflow', 'FIXED_AGENT_SLOTS'],
  },
  {
    q: 'where is the mixdog config json file path resolved (data dir)',
    expect: ['config', 'plugin-paths'],
  },
  {
    // path-only class: the correct answer is a verified file/dir location on
    // disk; a bare path (no :line) is an allowed HIT for this query.
    q: 'where does mixdog store background shell job stdout logs on disk',
    expect: ['shell-jobs', 'shell-job-paths', 'getShellJobsDir', 'shellJobStdout'],
    pathOnly: true,
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
      // Keep every row since ts; explorer-session attribution happens at
      // aggregation time.
      if (r.ts >= ts) rows.push(r);
    } catch { /* skip */ }
  }
  return rows;
}

const t0 = Date.now();
// Parallel round: all queries fire at once. Per-session trace attribution is
// by session_id so counts stay correct; per-query ms includes queueing.
const results = await Promise.all(QUERIES.map(async ({ q, expect, expectFail, pathOnly }) => {
  const qt0 = Date.now();
  const res = await runExplore({ query: q, cwd: CWD }, { callerCwd: CWD });
  const text = res?.content?.[0]?.text || '';
  const aLines = anchorLinesOf(text);
  const anchors = aLines.length;
  const failed = /EXPLORATION_FAILED/.test(text);
  // Context tokens for the fabricated-line guard: expanded expected + query
  // words, length>=4 to drop filler.
  const ctxTokens = [
    ...(expect || []).flatMap((e) => e.toLowerCase().split(/[^a-z0-9]+/)),
    ...q.toLowerCase().split(/[^a-z0-9]+/),
  ].filter((t) => t.length >= 4);
  // Spot-check up to 2 anchors per query for file/line validity + line context.
  let badAnchors = 0;
  for (const l of aLines.slice(0, 2)) {
    if (checkAnchorLine(l, ctxTokens) === false) badAnchors++;
  }
  const allLines = text.split('\n').filter((l) => l.trim());
  // Strict hit: expected token must appear ON an anchor line (>=1 anchor). For
  // the path-only class, an expected token on any verified path line HITs even
  // without :line. expectFail wants EXPLORATION_FAILED with zero anchors.
  const hit = expectFail
    ? (failed && anchors === 0)
    : pathOnly
      ? (!failed && (expect || []).some(
          (e) => allLines.some((l) => l.toLowerCase().includes(e.toLowerCase())),
        ))
      : (!failed && anchors > 0 && (expect || []).some(
          (e) => aLines.some((l) => l.toLowerCase().includes(e.toLowerCase())),
        ));
  return { q: q.slice(0, 48), ms: Date.now() - qt0, anchors, failed, hit, badAnchors, bytes: text.length };
}));

// Identify explorer sessions from trace rows, then attribute both tool calls
// and LLM send time per session.
const rows = readTraceSince(t0);
const explorerSessions = new Set(
  rows.filter((r) => r.agent === 'explorer').map((r) => r.session_id)
);
const bySession = new Map();
for (const r of rows) {
  if (r.kind !== 'tool' || !explorerSessions.has(r.session_id)) continue;
  const s = bySession.get(r.session_id) || { calls: 0, tools: [] };
  s.calls++; s.tools.push(r.tool_name);
  bySession.set(r.session_id, s);
}
const callCounts = [...bySession.values()].map((s) => s.calls).sort((a, b) => a - b);
const p50 = callCounts[Math.floor(callCounts.length / 2)] ?? 0;

// LLM send-time attribution from loop rows (kind='loop', send_ms), emitted
// under MIXDOG_AGENT_TRACE_TIMING. Under the parallel round, sends overlap
// wall time, so send/wall > 1 quantifies provider contention.
const sendBySession = new Map();
for (const r of rows) {
  if (r.kind !== 'loop' || !explorerSessions.has(r.session_id)) continue;
  const cur = sendBySession.get(r.session_id) || { sends: 0, ms: 0 };
  cur.sends++; cur.ms += Number(r.send_ms) || 0;
  sendBySession.set(r.session_id, cur);
}
const sendMsPer = [...sendBySession.values()].map((s) => s.ms).sort((a, b) => a - b);
const sendTotal = sendMsPer.reduce((a, b) => a + b, 0);
const sendP50 = sendMsPer[Math.floor(sendMsPer.length / 2)] ?? 0;
const sendMax = sendMsPer[sendMsPer.length - 1] ?? 0;
const sendCount = [...sendBySession.values()].reduce((a, s) => a + s.sends, 0);

console.log(`\n=== explore-bench round=${ROUND} ===`);
for (const r of results) {
  console.log(`  [${String(r.ms).padStart(6)}ms] ${r.hit ? 'HIT ' : 'MISS'} anchors=${r.anchors} bad=${r.badAnchors} failed=${r.failed} bytes=${r.bytes}  ${r.q}`);
}
const badTotal = results.reduce((a, r) => a + r.badAnchors, 0);
console.log(`  quality: ${results.filter((r) => r.hit).length}/${results.length} hits (strict)  bad-anchors=${badTotal}`);
console.log(`  sessions=${bySession.size} toolcalls p50=${p50} max=${callCounts[callCounts.length - 1] ?? 0} total=${callCounts.reduce((a, b) => a + b, 0)}`);
for (const [id, s] of bySession) console.log(`    ${id.slice(-8)}: ${s.tools.join(',')}`);
const wallMs = Date.now() - t0;
console.log(`  llm-send: sessions=${sendBySession.size} sends=${sendCount} ms/session p50=${sendP50} max=${sendMax} total=${sendTotal}`);
console.log(`  wall total=${(wallMs / 1000).toFixed(1)}s  send/wall=${wallMs > 0 ? (sendTotal / wallMs).toFixed(2) : '0.00'}x`);
