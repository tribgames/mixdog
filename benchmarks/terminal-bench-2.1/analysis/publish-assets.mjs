#!/usr/bin/env node
// Regenerate every published record from the run reports:
//   - per-task tables (records/results.md / records/results.json)
//   - recovered-cost archive (records/trace-recovered-cost.json)
//
// It then prints the figures the README prose and the promo charts
// (design/promo/) quote. Both stay hand-made: this script never edits a README
// or draws a chart.
//
// Which runs are published is declared once, in `presets.json` → `published`.
//
// Usage: node analysis/publish-assets.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const presets = JSON.parse(readFileSync(join(root, 'presets.json'), 'utf8'));
const published = presets.published ?? {};

const pct = (value) => `${Math.round(value * 100)}%`;
const thousands = (value) => `${(value / 1000).toFixed(1)}K`;
const millions = (value) => `${(value / 1e6).toFixed(1)}M`;
const grouped = (value) => Math.round(value).toLocaleString('en-US');

// --------------------------------------------------------------------- inputs
// Total tokens are comparable only when both sides count cached input inside
// input and neither reports cache writes separately.
function comparableTokens(pair) {
    const sides = [pair.ours.tokens, pair.baseline.tokens];
    if (!sides.every((t) => t && !t.cacheWrite && t.input >= t.cached)) return null;
    const [ours, baseline] = sides.map((t) => t.input + t.output);
    return { ours, baseline, reduction: 1 - ours / baseline };
}

// Request counts are comparable only when every paired trial recorded them on
// both sides. Input per request divides total input by those requests.
function comparableRequests(pair, tokens) {
    if (!tokens || !Array.isArray(pair.tasks) || pair.tasks.length === 0) return null;
    const count = (side) => pair.tasks.reduce((sum, task) => sum + (Number(task[side]?.providerRequests) || NaN), 0);
    const [ours, baseline] = [count('ours'), count('baseline')];
    if (!(ours > 0) || !(baseline > 0)) return null;
    const oursInput = pair.ours.tokens.input / ours;
    const baselineInput = pair.baseline.tokens.input / baseline;
    return {
        ours, baseline, reduction: 1 - ours / baseline,
        oursInput, baselineInput, inputReduction: 1 - oursInput / baselineInput,
    };
}

// First-request medians come from session logs that are not published, so
// they are read from the archive `first-context.mjs --write` leaves behind.
const firstContextFile = join(root, 'records', 'first-context.json');
const firstContext = existsSync(firstContextFile) ? JSON.parse(readFileSync(firstContextFile, 'utf8')) : {};
function firstRequest(key, jobsDir) {
    const row = firstContext[key];
    if (!row || row.jobsDir !== jobsDir) return null;
    const [ours, baseline] = [row.ours.medianTokens, row.baseline.medianTokens];
    return { ours, baseline, reduction: 1 - ours / baseline };
}

function figuresFor(key, jobsDir) {
    const report = JSON.parse(readFileSync(join(root, jobsDir, 'report.json'), 'utf8'));
    const pair = report.pair;
    if (!pair || pair.error) throw new Error(`${jobsDir}: report has no usable pair comparison`);
    const costRatio = pair.ratios.cost;
    const oursK = Math.max(1, Math.round(Number(report.preset.attempts) || 1));
    const taskCount = Math.max(1, Math.round(pair.sharedTasks / oursK));
    const baselineTotal = pair.baseline.fullTotal ?? pair.sharedTasks;
    const timedTrials = pair.timeComparison?.comparableTrials || pair.sharedTasks;
    return {
        preset: report.preset.name,
        startedAt: report.timing.startedAt,
        clean: report.result.clean,
        runtime: report.preset.runtime ?? null,
        errors: report.result.errors,
        retries: report.result.retries,
        score: {
            ours: pair.ours.passed,
            baseline: pair.baseline.passed,
            total: pair.sharedTasks,
            baselinePassed: pair.baseline.fullPassed ?? pair.baseline.passed,
            baselineTotal,
            k: oursK,
            baselineK: Math.max(1, Math.round(baselineTotal / taskCount)),
            taskCount,
        },
        speed: {
            ratio: pair.ratios.speedup,
            agentRatio: pair.ratios.agentSpeedup,
            ours: pair.ours.wallTotalSeconds / timedTrials,
            baseline: pair.baseline.wallTotalSeconds / timedTrials,
        },
        context: {
            ours: pair.ours.finalContextMedianTokens,
            baseline: pair.baseline.finalContextMedianTokens,
            reduction: pair.ratios.finalContextReduction,
        },
        tokens: comparableTokens(pair),
        requests: comparableRequests(pair, comparableTokens(pair)),
        first: firstRequest(key, jobsDir),
        cost: {
            ours: pair.ours.cost.usd,
            baseline: pair.baseline.cost.usd,
            ratio: costRatio,
            index: costRatio * 100,
            reduction: 1 - costRatio,
            pricedTasks: pair.costComparison?.comparableTasks ?? null,
            complete: pair.costComparison?.complete ?? false,
            baselineLowerBound: pair.baseline.costLowerBound === true,
        },
    };
}

// ---------------------------------------------------------------------- build
const node = process.execPath;
for (const entry of Object.values(published)) {
    execFileSync(node, [join(here, 'trace-cost.mjs'), entry.jobsDir, '--write'], { cwd: root, stdio: 'inherit' });
}
execFileSync(node, [join(here, 'results-table.mjs')], { cwd: root, stdio: 'inherit' });

const summary = [];
for (const [key, entry] of Object.entries(published)) {
    summary.push([key, entry, figuresFor(key, entry.jobsDir)]);
}

// ------------------------------------------------------------------- summary
console.log('\nFigures for the README prose and promo charts (edit the wording by hand):');
for (const [key, entry, f] of summary) {
    const delta = f.score.ours - f.score.baseline;
    console.log(`\n=== ${key} · ${f.preset} · ${String(f.startedAt).slice(0, 10)} · ${entry.jobsDir}`);
    console.log(`  score    ${f.score.ours}/${f.score.total} vs ${f.score.baseline}/${f.score.total} (${delta >= 0 ? '+' : ''}${delta})`);
    console.log(`  speed    ${f.speed.ratio.toFixed(2)}x wall (${Math.round(f.speed.ours)}s vs ${Math.round(f.speed.baseline)}s per trial; agent ${f.speed.agentRatio.toFixed(2)}x)`);
    if (f.tokens) console.log(`  tokens   ${millions(f.tokens.ours)} vs ${millions(f.tokens.baseline)} → ${pct(f.tokens.reduction)} fewer`);
    if (f.requests) console.log(`  requests ${grouped(f.requests.ours)} vs ${grouped(f.requests.baseline)} → ${pct(f.requests.reduction)} fewer; input per request ${thousands(f.requests.oursInput)} vs ${thousands(f.requests.baselineInput)} → ${pct(f.requests.inputReduction)} less`);
    if (f.first) console.log(`  first    ${f.first.ours} vs ${f.first.baseline} tokens in the first request → ${pct(f.first.reduction)} smaller`);
    console.log(`  context  ${f.context.ours} vs ${f.context.baseline} tokens → ${pct(f.context.reduction)} smaller`);
    console.log(`  cost     $${f.cost.ours.toFixed(2)} vs $${f.cost.baseline.toFixed(2)} → ${pct(f.cost.reduction)} lower`
        + ` (${f.cost.pricedTasks}/${f.score.total} priced, complete=${f.cost.complete}`
        + `${f.cost.baselineLowerBound ? ', baseline is a LOWER BOUND — say "at least"' : ''})`);
    console.log(`  run      clean=${f.clean} (errors ${f.errors}, retries ${f.retries})`);
    // A published score must name the source it ran. Runs recorded before
    // provenance capture existed are pinned in records/source-provenance.json instead.
    const runtime = f.runtime;
    const short = (hash) => String(hash || '').replace(/^sha256:/, '').slice(0, 12) || 'n/a';
    if (runtime) {
        const dirty = runtime.sourceDirty === null || runtime.sourceDirty === undefined
            ? 'unknown'
            : String(runtime.sourceDirty);
        console.log(`  source   commit ${short(runtime.sourceCommit)} (dirty ${dirty}), bundle ${short(runtime.bundleSha256)}, mixdog ${runtime.mixdogVersion || 'n/a'}`);
        if (runtime.sourceDirty) {
            console.log('           WARNING: tree differed from HEAD — this run is NOT attributable to a commit');
        }
    } else {
        console.log('  source   unrecorded in the run — must be pinned in records/source-provenance.json before publishing');
    }
}
console.log('');
