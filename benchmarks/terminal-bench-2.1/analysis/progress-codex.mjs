// Live progress for the running full-sol-xhigh bench against the Codex CLI
// baseline, on the SAME completed task set. Every metric comes from the
// official report generator so definitions cannot drift — including the
// baseline's per-task context and model-call counts, which the report reads
// from each Codex trial's own trajectory and rollout.
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateRunReport } from './run-report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TB = resolve(here, '..');
// Default to the NEWEST full-sol-xhigh jobs dir: a restarted run must be
// picked up without editing this file (a pinned path silently reports the
// dead run). An explicit argv[2] still wins.
const newestSolRun = () => readdirSync(TB)
  .filter((name) => /^jobs-full-sol-xhigh-\d{8}-\d{6}$/.test(name))
  .filter((name) => existsSync(join(TB, name, 'preset-run.json')))
  .sort()
  .pop();
const CUR = process.argv[2] || resolve(TB, newestSolRun() || 'jobs-full-sol-xhigh-20260823-171008');

const rep = generateRunReport({ jobsDir: CUR, historyRoot: resolve(CUR, '..'), status: true });

const pairTask = new Map((rep.pair?.tasks || []).map((t) => [t.task, t]));
const done = rep.tasks.filter((t) => t.settled && pairTask.has(t.task));
const names = done.map((t) => t.task);
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
const num = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
};
const sum = (xs) => xs.reduce((a, b) => a + (Number(b) || 0), 0);
const base = (n) => pairTask.get(n)?.baseline || {};

const oursPass = done.filter((t) => t.passed).length;
const basePass = names.filter((n) => base(n).passed).length;
const oursSec = sum(done.map((t) => t.agentSeconds));
const baseSec = sum(names.map((n) => base(n).agentSeconds));
const oursCtx = median(done.map((t) => t.finalContextTokens));
const baseCtx = median(names.map((n) => base(n).finalContextTokens));
const costRows = names.filter((n) => Number.isFinite(done.find((t) => t.task === n)?.costUsd)
  && Number.isFinite(base(n).costUsd));
const oursCost = sum(costRows.map((n) => done.find((t) => t.task === n).costUsd));
const baseCost = sum(costRows.map((n) => base(n).costUsd));
const oursReq = sum(done.map((t) => t.activity?.providerRequests));
// Model calls on both sides, counted the same way (the report derives the
// baseline's from its rollout `token_count` events, NOT total_steps).
const stepRows = names.filter((n) => Number.isFinite(base(n).providerRequests));
const baseReq = sum(stepRows.map((n) => base(n).providerRequests));
const oursReqOnStepRows = sum(stepRows.map((n) => done.find((t) => t.task === n)?.activity?.providerRequests));

const st = rep.result;
console.log(`진행  ${st.completed}/89 완료 · ${st.running} 실행중 · ${st.pending} 대기 · 오류 ${st.errors} · 재시도 ${st.retries}`);
console.log('');
console.log(`1) 성공률      now ${oursPass}/${done.length} (${pct(oursPass, done.length)})  |  Codex ${basePass} (${pct(basePass, done.length)})`);
console.log(`2) 속도        now ${num(oursSec)}s  |  Codex ${num(baseSec)}s   (${(baseSec / (oursSec || 1)).toFixed(2)}x)`);
// Per-task baseline context now comes from each trajectory, so the median is
// taken over the SAME task set. The published whole-run figure stays as the
// fallback for a baseline whose trajectories are unreadable, and says so.
const CODEX_RUN_MEDIAN_CTX = 33454;
console.log(baseCtx > 0
  ? `3) 최종컨텍스트 now ${num(oursCtx)}  |  Codex ${num(baseCtx)}   (${pct(baseCtx - oursCtx, baseCtx)} 절감)`
  : `3) 최종컨텍스트 now ${num(oursCtx)}  |  Codex ${num(CODEX_RUN_MEDIAN_CTX)} (런 전체 중앙값, 태스크 집합 불일치)`
    + `   (${pct(CODEX_RUN_MEDIAN_CTX - oursCtx, CODEX_RUN_MEDIAN_CTX)} 절감)`);
console.log(`4) 비용        now $${oursCost.toFixed(2)}  |  Codex $${baseCost.toFixed(2)}   (${costRows.length}개 공통 과금 태스크)`);
console.log(`5) 턴수        now ${num(oursReq)} (평균 ${(oursReq / (done.length || 1)).toFixed(1)})  |  Codex ${num(baseReq)} (평균 ${(baseReq / (stepRows.length || 1)).toFixed(1)}, ${stepRows.length}개 대조)`
  + (stepRows.length && stepRows.length !== done.length ? `  [같은 ${stepRows.length}개에서 ours ${num(oursReqOnStepRows)}]` : ''));

const oursOnly = names.filter((n) => done.find((t) => t.task === n).passed && !base(n).passed);
const baseOnly = names.filter((n) => !done.find((t) => t.task === n).passed && base(n).passed);
console.log('');
console.log(`6) 상대 비교   단독승 ${oursOnly.length} / 단독패 ${baseOnly.length}`);
if (oursOnly.length) console.log(`   ours-only:     ${oursOnly.join(', ')}`);
if (baseOnly.length) console.log(`   baseline-only: ${baseOnly.join(', ')}`);

let cgCalls = 0;
let cgErr = 0;
for (const t of rep.tasks) {
  for (const [name, n] of Object.entries(t.trace?.toolCounts || {})) if (name === 'code_graph') cgCalls += n;
  for (const f of t.trace?.failures || []) if (f.tool === 'code_graph') cgErr += 1;
}
console.log('');
console.log(`code_graph  호출 ${cgCalls} (실패 ${cgErr})  [트레이스 보유 태스크만 집계]`);
