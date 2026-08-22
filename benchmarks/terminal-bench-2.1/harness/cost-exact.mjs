// Exact cost report for a mixdog jobs run — NO estimates.
// Replaces cost-exact.ps1: PS5's ConvertFrom-Json chokes on transcript JSON
// (case-duplicate keys => non-terminating error left the previous trial's
// object in scope and silently duplicated rows — observed 2026-08-03).
//
// Sources per trial (both under <trial>/agent/):
//   session-transcript.json — totalUncachedInputTokens / totalCachedReadTokens
//     / totalCacheWriteTokens / totalOutputTokens / lastContextTokens.
//     IMPORTANT: totalUncachedInputTokens = provider input + cacheWrite by
//     design (uncachedInputTokensForProvider, usage-metrics.mjs). The true
//     billing-uncached input is (totalUncachedInputTokens - cacheWrite).
//   usage.json — driver-mirrored provider totals; inputTokens there IS the
//     billing-uncached input for Anthropic mirrors, but TOTAL input
//     (uncached + cached) for OpenAI mirrors — subtract cacheTokens there
//     (verified 2026-08-08: sol trial in 24,601 = unc 9,753 + cr 14,848).
// Rates: analysis/model-rates.mjs (unknown models report unsupported). Opus 5 cache write
// $10/M (1h TTL) for BOTH sides — mixdog runs 1h TTL, and CC does too
// (measured 2026-08-03: all 89 jobs-full-cc-n8 trajectories report writes
// exclusively under ephemeral_1h_input_tokens; ephemeral_5m total is 0).
// GPT-5.6+ bills cache writes at 1.25x input (sol $6.25/M). Responses usage
// reports them separately under input_tokens_details.cache_write_tokens.
// Usage: node harness/cost-exact.mjs <runDir> [ccBaseline.json]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pricedCost, pricedSplitCost, rateFor, uncachedTokens } from '../analysis/model-rates.mjs';

const [runDir, ccPath] = process.argv.slice(2);
if (!runDir) { console.error('usage: node cost-exact.mjs <runDir> [ccBaseline.json]'); process.exit(1); }
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const cc = ccPath && existsSync(ccPath) ? readJson(ccPath) : null;

const rows = [];
const sum = { n: 0, t: 0, cost: 0, costN: 0, turns: 0, turnN: 0, ctx: 0, win: 0, in: 0, cr: 0, cw: 0, out: 0 };
const ccSum = { n: 0, t: 0, cost: 0, calls: 0, win: 0 };
const pairs = []; // matched tasks: per-task 1:1 ratios (mixdog / CC)
const paired = { mixCost: 0, ccCost: 0, mixT: 0, ccT: 0 };
for (const entry of readdirSync(runDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(runDir, entry.name);
    const r = readJson(join(dir, 'result.json'));
    const reward = r?.verifier_result?.rewards?.reward;
    if (reward == null) continue;
    const s = readJson(join(dir, 'agent', 'session-transcript.json'));
    const ud = readJson(join(dir, 'agent', 'usage.json'));
    const u = ud?.totals ?? null;
    if (!s && !u) continue;
    const num = (v) => Number(v) || 0;
    const model = s?.model || (ud?.sessions?.[0]?.models || [])[0];
    const R = rateFor(model);
    const cw = s ? num(s.totalCacheWriteTokens) : num(u?.cacheWriteTokens);
    const cr = s ? num(s.totalCachedReadTokens) : num(u?.cacheTokens);
    const out = s ? num(s.totalOutputTokens) : num(u?.outputTokens);
    // True billing-uncached input: provider-reported when mirrored (family
    // semantics above), else transcript aggregate minus the writes it folds in.
    const inTok = u && u.inputTokens != null
        ? (R ? uncachedTokens(R, num(u.inputTokens), num(u.cacheTokens), num(u.cacheWriteTokens)) : null)
        : Math.max(num(s?.totalUncachedInputTokens) - cw, 0);
    const flag = s ? '' : ' [usage-only]';
    const sessionCosts = Array.isArray(ud?.sessions) && ud.sessions.length
        ? ud.sessions.map((x) => pricedCost({
            model: (x.models || [])[0],
            input: x.inputTokens,
            cached: x.cacheTokens,
            cacheWrite: x.cacheWriteTokens,
            output: x.outputTokens,
        }))
        : null;
    const cost = sessionCosts
        ? (sessionCosts.some((value) => value == null) ? null : sessionCosts.reduce((acc, value) => acc + value, 0))
        : pricedSplitCost({ model, uncached: inTok, cached: cr, cacheWrite: cw, output: out });
    const agent = (Date.parse(r.agent_execution.finished_at) - Date.parse(r.agent_execution.started_at)) / 1e3;
    const name = entry.name.split('__')[0];
    let turns = Number.isFinite(Number(s?.lastIterationIndex)) ? Number(s.lastIterationIndex) : null;
    if (turns == null) {
        try {
            const measured = (readFileSync(join(dir, 'agent', 'mixdog.txt'), 'utf8').match(/\[turn-timing\]/g) || []).length;
            if (measured > 0) turns = measured;
        } catch {}
    }
    const ctx = num(s?.lastContextTokens);
    sum.n++; sum.t += agent; sum.win += reward; sum.ctx += ctx;
    if (cost != null) { sum.cost += cost; sum.costN++; }
    if (turns != null) { sum.turns += turns; sum.turnN++; }
    sum.in += inTok || 0; sum.cr += cr; sum.cw += cw; sum.out += out;
    let ccCol = '';
    const v = cc?.[name];
    if (v) {
        const ccCost = pricedSplitCost({
            model: 'claude-opus-5',
            uncached: v.unc,
            cached: v.cr,
            cacheWrite: v.cw,
            output: v.out,
        });
        ccSum.n++; ccSum.t += v.t; ccSum.cost += ccCost || 0; ccSum.calls += v.calls; ccSum.win += v.reward;
        const ratio = cost != null && ccCost > 0 ? cost / ccCost : NaN;
        const tRatio = v.t > 0 ? agent / v.t : NaN;
        if (Number.isFinite(ratio)) pairs.push({ name, ratio, tRatio });
        if (cost != null && ccCost != null) {
            paired.mixCost += cost; paired.ccCost += ccCost; paired.mixT += agent; paired.ccT += v.t;
        }
        const ccCostText = ccCost == null ? 'unsupported' : `$${ccCost.toFixed(2)}`;
        const ratioText = Number.isFinite(ratio) ? ` x${ratio.toFixed(2)}` : '';
        ccCol = ` | CC: r=${Math.round(v.reward)} ${String(Math.round(v.t)).padStart(5)}s ${ccCostText}${ratioText}`;
    }
    const turnsText = turns == null ? '?' : String(turns);
    const costText = cost == null ? 'unsupported' : `$${cost.toFixed(2).padEnd(5)}`;
    rows.push(`${name.padEnd(32)} r=${reward} ${String(Math.round(agent)).padStart(5)}s turns=${turnsText.padStart(2)} ctx=${String(Math.round(ctx / 1e3)).padStart(3)}K in=${String(Math.round(inTok ?? 0)).padStart(5)} cw=${String(Math.round(cw / 1e3)).padStart(4)}K ${costText}${ccCol}${flag}`);
}
if (sum.n === 0) {
    console.error(`no benchmark trials found under: ${runDir}`);
    process.exit(1);
}
rows.sort();
console.log(rows.join('\n'));
if (sum.n > 0) {
    const avgTurns = sum.turnN > 0 ? (sum.turns / sum.turnN).toFixed(1) : 'n/a';
    const avgCost = sum.costN > 0 ? `$${(sum.cost / sum.costN).toFixed(3)}` : 'unsupported';
    const totalCost = sum.costN > 0 ? `$${sum.cost.toFixed(2)}` : 'unsupported';
    const unsupported = sum.n - sum.costN;
    console.log(`-- mixdog n=${sum.n}: win=${sum.win} avg agent=${Math.round(sum.t / sum.n)}s avg turns=${avgTurns} avg finalCtx=${Math.round(sum.ctx / sum.n / 1e3)}K avg cost=${avgCost} total=${totalCost}${unsupported ? ` unsupported=${unsupported}` : ''}`);
    console.log(`-- mixdog components: in=${Math.round(sum.in / 1e3)}K cr=${Math.round(sum.cr / 1e3)}K cw=${Math.round(sum.cw / 1e3)}K out=${Math.round(sum.out / 1e3)}K`);
}
if (ccSum.n > 0) {
    console.log(`-- CC 1:1  n=${ccSum.n}: win=${Math.round(ccSum.win)} avg agent=${Math.round(ccSum.t / ccSum.n)}s avg calls=${(ccSum.calls / ccSum.n).toFixed(1)} avg cost=$${(ccSum.cost / ccSum.n).toFixed(3)} total=$${ccSum.cost.toFixed(2)}`);
}
if (pairs.length > 0) {
    const rs = pairs.map((p) => p.ratio).sort((a, b) => a - b);
    const ts = pairs.map((p) => p.tRatio).filter(Number.isFinite).sort((a, b) => a - b);
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const median = (a) => a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
    const geo = (a) => Math.exp(mean(a.map(Math.log)));
    const cheaper = pairs.filter((p) => p.ratio < 1).length;
    console.log(`-- paired n=${pairs.length} (mixdog/CC per-task): cost mean=${mean(rs).toFixed(2)} geomean=${geo(rs).toFixed(2)} median=${median(rs).toFixed(2)} cheaper=${cheaper}/${pairs.length}; time mean=${mean(ts).toFixed(2)} geomean=${geo(ts).toFixed(2)} median=${median(ts).toFixed(2)}`);
    console.log(`-- paired totals: mixdog $${paired.mixCost.toFixed(2)} vs CC $${paired.ccCost.toFixed(2)} (x${(paired.mixCost / paired.ccCost).toFixed(2)}); time ${Math.round(paired.mixT)}s vs ${Math.round(paired.ccT)}s (x${(paired.mixT / paired.ccT).toFixed(2)})`);
}
