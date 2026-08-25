import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pricedCost } from './model-rates.mjs';
const A = 'benchmarks/terminal-bench-2.1/jobs-full-sol-xhigh-20260824-120411'; // prev run (80/89)
const B = 'benchmarks/terminal-bench-2.1/jobs-full-sol-xhigh-20260824-144802'; // current (slim rule)
function rewards(run) {
  const m = new Map();
  for (const dd of readdirSync(run)) {
    const d = join(run, dd);
    if (!statSync(d).isDirectory()) continue;
    for (const t of readdirSync(d)) {
      if (!statSync(join(d, t)).isDirectory()) continue;
      const rw = join(d, t, 'verifier', 'reward.txt');
      if (!existsSync(rw)) continue;
      m.set(t.replace(/__[^_]+$/, ''), readFileSync(rw, 'utf8').trim());
    }
  }
  return m;
}
const a = rewards(A), b = rewards(B);
let pass = 0;
const improved = [], regressed = [], sameFail = [];
for (const [t, r] of [...b.entries()].sort()) {
  if (r === '1') pass++;
  const ra = a.get(t);
  if (ra === undefined) continue;
  if (ra === r) { if (r !== '1') sameFail.push(t); }
  else if (r === '1') improved.push(t);
  else regressed.push(t);
}
console.log(`progress: rewarded ${b.size}/89, pass ${pass}/${b.size} (${b.size ? Math.round(pass / b.size * 1000) / 10 : 0}%)`);
console.log(`vs prev run (80/89 cohort):`);
console.log(`  improved : ${improved.join(', ') || '-'}`);
console.log(`  regressed: ${regressed.join(', ') || '-'}`);
console.log(`  same-fail: ${sameFail.join(', ') || '-'}`);
const aPassSofar = [...b.keys()].filter((t) => a.get(t) === '1').length;
console.log(`  cumulative: now ${pass} vs prev ${aPassSofar} on same set (${pass - aPassSofar >= 0 ? '+' : ''}${pass - aPassSofar})`);
function detail(run, tasks) {
  const s = { req: 0, input: 0, cached: 0, write: 0, output: 0, secs: 0, toolFails: 0, gitFails: 0, promoFails: 0 };
  for (const dd of readdirSync(run)) {
    const d = join(run, dd);
    if (!statSync(d).isDirectory()) continue;
    for (const t of readdirSync(d)) {
      if (!statSync(join(d, t)).isDirectory()) continue;
      const task = t.replace(/__[^_]+$/, '');
      if (!tasks.has(task)) continue;
      const tx = join(d, t, 'agent', 'mixdog.txt');
      if (!existsSync(tx)) continue;
      let first = null, last = null;
      for (const line of readFileSync(tx, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (!first) first = ev.timestamp;
        last = ev.timestamp;
        if (ev.type === 'model.request.completed') {
          s.req++;
          s.input += ev.usage?.input_tokens ?? 0;
          s.cached += ev.usage?.cached_input_tokens ?? 0;
          s.write += ev.usage?.cache_write_input_tokens ?? 0;
          s.output += ev.usage?.output_tokens ?? 0;
        } else if (ev.type === 'item.completed' && ev.item?.type === 'tool_call') {
          const out = String(ev.item.output ?? '');
          s.calls = (s.calls ?? 0) + 1;
          if (ev.item.name === 'read' && out.length > 10000) { s.bigReads = (s.bigReads ?? 0) + 1; s.bigReadCh = (s.bigReadCh ?? 0) + out.length; }
          if (ev.item.status === 'failed' || /^Error\b/.test(out)) {
            s.toolFails++;
            if (ev.item.name === 'git') s.gitFails++;
          }
          if (out.includes('background-promotion-failed')) s.promoFails++;
        }
      }
      s.secs += first && last ? (new Date(last) - new Date(first)) / 1000 : 0;
    }
  }
  return s;
}
const shared = new Set([...b.keys()].filter((t) => a.has(t)));
if (shared.size > 0) {
  const da = detail(A, shared), db = detail(B, shared);
  const n = shared.size;
  for (const [label, s] of [['prev', da], ['now ', db]]) {
    const cost = pricedCost({ model: 'gpt-5.6-sol', input: s.input, cached: s.cached, cacheWrite: s.write, output: s.output });
    console.log(`${label} secs/task=${Math.round(s.secs / n)} rounds/task=${Math.round(s.req / n * 10) / 10} calls=${s.calls ?? 0} uncached=${s.input - s.cached - s.write} cached=${s.cached} output=${s.output} cost/task=$${(cost / n).toFixed(3)} toolFails=${s.toolFails} (git ${s.gitFails}) promoFails=${s.promoFails} bigReads=${s.bigReads ?? 0}/${s.bigReadCh ?? 0}ch`);
  }
}
