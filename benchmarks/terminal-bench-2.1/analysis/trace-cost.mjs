// Per-task priced cost from raw agent traces, with a cross-check against the
// usage snapshots the runtime writes on a clean exit.
//
// Trials that hit the agent timeout are killed before `agent/usage.json` is
// flushed, so the run report leaves their cost null and the pair comparison
// silently drops them. Every model response is already recorded in
// `agent/agent-trace.jsonl` as a `usage_raw` event carrying the full split
// (uncached input, cache read, cache write, output), so those tasks can be
// priced from the raw artifacts instead of being excluded.
//
// This script recomputes EVERY task from the trace, verifies it reproduces
// `usage.json` on the tasks that have one, and writes the recovered rows to
// `analysis/trace-recovered-cost.json`.
//
// Usage: node analysis/trace-cost.mjs <jobs-dir> [--write]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pricedCost, pricedSplitCost } from './model-rates.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

function findRunDir(jobsDir) {
    if (existsSync(join(jobsDir, 'result.json'))) return jobsDir;
    for (const entry of readdirSync(jobsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join(jobsDir, entry.name);
        if (existsSync(join(candidate, 'result.json'))) return candidate;
    }
    return jobsDir;
}

// Sum the raw usage events of one trial. `uncached_input_tokens` is the
// provider-normalized uncached figure for both families, so the same split
// feeds pricing regardless of harness.
function traceTotals(trialDir) {
    const path = join(trialDir, 'agent', 'agent-trace.jsonl');
    if (!existsSync(path)) return null;
    const totals = { uncached: 0, cached: 0, cacheWrite: 0, output: 0, requests: 0, models: new Set() };
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        if (!line.includes('usage_raw')) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event?.kind !== 'usage_raw') continue;
        totals.requests += 1;
        if (event.model) totals.models.add(event.model);
        totals.cached += finite(event.cached_tokens);
        totals.cacheWrite += finite(event.cache_write_tokens);
        totals.output += finite(event.output_tokens);
        totals.uncached += finite(
            event.uncached_input_tokens ?? event.input_tokens,
        );
    }
    return totals.requests ? totals : null;
}

function usageTotals(trialDir) {
    const path = join(trialDir, 'agent', 'usage.json');
    if (!existsSync(path)) return null;
    let usage;
    try { usage = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
    const totals = usage?.totals;
    if (!totals) return null;
    // `inputTokens` is the provider's own field: uncached-only for Anthropic,
    // cache-inclusive for OpenAI. pricedCost() applies the family rule, which
    // is exactly what the run report does.
    return {
        input: finite(totals.inputTokens),
        cached: finite(totals.cacheTokens),
        cacheWrite: finite(totals.cacheWriteTokens),
        output: finite(totals.outputTokens),
        models: (usage.sessions ?? []).flatMap((session) => session?.models ?? []),
    };
}

const jobsArg = process.argv[2];
if (!jobsArg) {
    console.error('usage: node analysis/trace-cost.mjs <jobs-dir> [--write]');
    process.exit(2);
}
const jobsDir = resolve(here, '..', jobsArg);
const runDir = findRunDir(jobsDir);
const report = existsSync(join(jobsDir, 'report.json'))
    ? JSON.parse(readFileSync(join(jobsDir, 'report.json'), 'utf8'))
    : null;
const model = report?.preset?.model ?? null;

const rows = [];
for (const entry of readdirSync(runDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.includes('__')) continue;
    const trialDir = join(runDir, entry.name);
    const trace = traceTotals(trialDir);
    if (!trace) continue;
    const snapshot = usageTotals(trialDir);
    const taskModel = trace.models.size === 1 ? [...trace.models][0] : model;
    const split = {
        model: taskModel,
        uncached: trace.uncached,
        cached: trace.cached,
        cacheWrite: trace.cacheWrite,
        output: trace.output,
    };
    rows.push({
        task: entry.name.split('__')[0],
        model: taskModel,
        requests: trace.requests,
        source: snapshot ? 'usage.json' : 'agent-trace.jsonl',
        tokens: {
            uncachedInput: trace.uncached,
            cacheRead: trace.cached,
            cacheWrite: trace.cacheWrite,
            output: trace.output,
        },
        costUsd: pricedSplitCost(split),
        snapshot: snapshot && {
            tokens: {
                input: snapshot.input,
                cacheRead: snapshot.cached,
                cacheWrite: snapshot.cacheWrite,
                output: snapshot.output,
            },
            costUsd: pricedCost({
                model: taskModel,
                input: snapshot.input,
                cached: snapshot.cached,
                cacheWrite: snapshot.cacheWrite,
                output: snapshot.output,
            }),
        },
    });
}
rows.sort((a, b) => a.task.localeCompare(b.task));

// Cross-check: on every task that flushed a snapshot, the trace must
// reproduce it. Anything else invalidates using the trace as a substitute.
const checked = rows.filter((row) => row.snapshot);
const mismatches = checked.filter((row) => {
    const delta = Math.abs(row.costUsd - row.snapshot.costUsd);
    return !(delta <= Math.max(0.005, row.snapshot.costUsd * 0.005));
});
const recovered = rows.filter((row) => !row.snapshot);
const total = rows.reduce((sum, row) => sum + finite(row.costUsd), 0);
const snapshotTotal = checked.reduce((sum, row) => sum + finite(row.snapshot.costUsd), 0);
// Published total: the flushed snapshot wherever one exists, the trace only
// for the tasks that never got to write one.
const authoritative = rows.reduce(
    (sum, row) => sum + finite(row.snapshot ? row.snapshot.costUsd : row.costUsd),
    0,
);

console.log(`run: ${jobsArg}`);
console.log(`model: ${model ?? 'n/a'} · tasks: ${rows.length}`);
console.log(`cross-checked against usage.json: ${checked.length}, mismatches: ${mismatches.length}`);
for (const row of mismatches.slice(0, 10)) {
    console.log(`  MISMATCH ${row.task}: trace $${row.costUsd.toFixed(4)} vs snapshot $${row.snapshot.costUsd.toFixed(4)}`);
}
console.log(`recovered from trace only: ${recovered.length}`);
for (const row of recovered) {
    console.log(`  ${row.task.padEnd(30)} $${row.costUsd.toFixed(4)} (${row.requests} requests, cacheWrite ${row.tokens.cacheWrite})`);
}
console.log(`snapshot subtotal (${checked.length} tasks): $${snapshotTotal.toFixed(2)}`);
console.log(`trace-only total (${rows.length} tasks): $${total.toFixed(2)}`);
console.log(`published total (snapshot + recovered, ${rows.length} tasks): $${authoritative.toFixed(2)}`);

if (process.argv.includes('--write')) {
    const out = join(here, 'trace-recovered-cost.json');
    const existing = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : { schemaVersion: 1, runs: {} };
    existing.runs[jobsArg] = {
        model,
        tasks: rows.length,
        crossChecked: checked.length,
        mismatches: mismatches.length,
        fullRunCostUsd: Number(authoritative.toFixed(6)),
        traceOnlyTotalUsd: Number(total.toFixed(6)),
        snapshotSubtotalUsd: Number(snapshotTotal.toFixed(6)),
        recovered: recovered.map((row) => ({
            task: row.task,
            requests: row.requests,
            tokens: row.tokens,
            costUsd: Number(row.costUsd.toFixed(6)),
        })),
    };
    existing.generated = new Date().toISOString().slice(0, 10);
    writeFileSync(out, `${JSON.stringify(existing, null, 2)}\n`);
    console.log(`wrote ${out}`);
}
