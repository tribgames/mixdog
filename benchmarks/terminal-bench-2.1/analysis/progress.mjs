// Live progress for the running full-opus5-solo bench, on the SAME completed
// task set: current run vs the previous run (20260823-112220) vs Claude Code.
// Metrics come from the official report generator so definitions cannot drift.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateRunReport } from './run-report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CUR = process.argv[2] || resolve(here, '..', 'jobs-full-opus5-solo-20260823-144706');
const PREV = resolve(here, '..', 'jobs-full-opus5-solo-20260823-112220', 'report.json');
const CC = resolve(here, '..', 'cc-baseline-plus.json');

const rep = generateRunReport({ jobsDir: CUR, historyRoot: resolve(CUR, '..'), status: true });
const prev = JSON.parse(readFileSync(PREV, 'utf8'));
const cc = JSON.parse(readFileSync(CC, 'utf8'));

const prevTask = new Map(prev.tasks.map((t) => [t.task, t]));
const prevPair = new Map(prev.pair.tasks.map((t) => [t.task, t]));

const done = rep.tasks.filter((t) => t.settled);
const names = done.map((t) => t.task);
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
const num = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
};
const sum = (xs) => xs.reduce((a, b) => a + (Number(b) || 0), 0);

const oursPass = done.filter((t) => t.passed).length;
const prevPass = names.filter((n) => prevTask.get(n)?.passed).length;
const ccPass = names.filter((n) => cc[n]?.reward > 0).length;

const oursSec = sum(done.map((t) => t.agentSeconds));
const prevSec = sum(names.map((n) => prevTask.get(n)?.agentSeconds));
const ccSec = sum(names.map((n) => cc[n]?.t));

const oursCtx = median(done.map((t) => t.finalContextTokens));
const prevCtx = median(names.map((n) => prevTask.get(n)?.finalContextTokens));
const ccCtx = median(names.map((n) => prevPair.get(n)?.baseline?.finalContextTokens));

const costRows = names.filter((n) => {
  const o = done.find((t) => t.task === n);
  return Number.isFinite(o?.costUsd) && Number.isFinite(prevPair.get(n)?.baseline?.costUsd);
});
const oursCost = sum(costRows.map((n) => done.find((t) => t.task === n).costUsd));
const prevCost = sum(costRows.map((n) => prevTask.get(n)?.costUsd));
const ccCost = sum(costRows.map((n) => prevPair.get(n)?.baseline?.costUsd));

const oursReq = sum(done.map((t) => t.activity?.providerRequests));
const prevReq = sum(names.map((n) => prevTask.get(n)?.activity?.providerRequests));
const ccReq = sum(names.map((n) => cc[n]?.calls));

const st = rep.result;
console.log(`진행  ${st.completed}/89 완료 · ${st.running} 실행중 · ${st.pending} 대기 · 오류 ${st.errors} · 재시도 ${st.retries}`);
console.log('');
console.log(`1) 성공률      now ${oursPass}/${done.length} (${pct(oursPass, done.length)})  |  prev ${prevPass} (${pct(prevPass, done.length)})  |  CC ${ccPass} (${pct(ccPass, done.length)})`);
console.log(`2) 속도        now ${num(oursSec)}s  |  prev ${num(prevSec)}s  |  CC ${num(ccSec)}s   (vs prev ${(prevSec / (oursSec || 1)).toFixed(2)}x, vs CC ${(ccSec / (oursSec || 1)).toFixed(2)}x)`);
console.log(`3) 최종컨텍스트 now ${num(oursCtx)}  |  prev ${num(prevCtx)}  |  CC ${num(ccCtx)}   (CC 대비 ${pct(ccCtx - oursCtx, ccCtx)} 절감)`);
console.log(`4) 비용        now $${oursCost.toFixed(2)}  |  prev $${prevCost.toFixed(2)}  |  CC $${ccCost.toFixed(2)}   (${costRows.length}개 공통 과금 태스크)`);
console.log(`5) 턴수        now ${num(oursReq)} (평균 ${(oursReq / (done.length || 1)).toFixed(1)})  |  prev ${num(prevReq)}  |  CC ${num(ccReq)} (평균 ${(ccReq / (done.length || 1)).toFixed(1)})`);

const gained = names.filter((n) => done.find((t) => t.task === n).passed && !prevTask.get(n)?.passed);
const lost = names.filter((n) => !done.find((t) => t.task === n).passed && prevTask.get(n)?.passed);
const vsCcOnly = names.filter((n) => done.find((t) => t.task === n).passed && !(cc[n]?.reward > 0));
const ccOnly = names.filter((n) => !done.find((t) => t.task === n).passed && cc[n]?.reward > 0);
console.log('');
console.log(`6) 상대 비교   지난 런 대비  획득 ${gained.length} / 상실 ${lost.length}`);
if (gained.length) console.log(`   GAINED: ${gained.join(', ')}`);
if (lost.length) console.log(`   LOST:   ${lost.join(', ')}`);
console.log(`   CC 대비      단독승 ${vsCcOnly.length} / 단독패 ${ccOnly.length}`);
if (vsCcOnly.length) console.log(`   ours-only:     ${vsCcOnly.join(', ')}`);
if (ccOnly.length) console.log(`   baseline-only: ${ccOnly.join(', ')}`);

let cgCalls = 0;
let cgErr = 0;
for (const t of rep.tasks) {
  for (const [name, n] of Object.entries(t.trace?.toolCounts || {})) {
    if (name === 'code_graph') cgCalls += n;
  }
  for (const f of t.trace?.failures || []) if (f.tool === 'code_graph') cgErr += 1;
}
console.log('');
console.log(`code_graph  호출 ${cgCalls} (실패 ${cgErr}) — 지난 런 전체: 1회 1실패  [트레이스 보유 태스크만 집계]`);
