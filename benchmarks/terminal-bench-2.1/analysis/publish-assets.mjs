#!/usr/bin/env node
// Regenerate every published artifact from the run reports:
//   - comparison charts (tb21-*.svg)
//   - per-task tables (results.md / results.json)
//   - recovered-cost archive (analysis/trace-recovered-cost.json)
//
// It then prints the figures the README prose quotes. The wording itself stays
// hand-written: this script never edits a README.
//
// Which runs are published is declared once, in `presets.json` → `published`.
//
// Usage: node analysis/publish-assets.mjs [--charts-only]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const presets = JSON.parse(readFileSync(join(root, 'presets.json'), 'utf8'));
const published = presets.published ?? {};
const chartsOnly = process.argv.includes('--charts-only');

// ---------------------------------------------------------------- chart shape
// Two frames: four panels in one row (1200x600), or six panels in two rows of
// three (1200x920) when the run reports comparable tokens and request counts.
// Bars are proportional to the larger of the two values, so the taller bar is
// always maxH and nothing is clipped.
const FOUR = {
    height: 600,
    slots: [64, 340, 616, 892].map((x) => ({
        x, bars: [x + 24, x + 120], values: [x + 60, x + 156], line: [x, x + 232],
        top: 184, base: 520, maxH: 270, barW: 72,
    })),
};
const SIX = {
    height: 920,
    slots: [{ top: 184, base: 480 }, { top: 570, base: 866 }].flatMap((row) => [64, 432, 800].map((x) => ({
        x, bars: [x + 32, x + 160], values: [x + 76, x + 204], line: [x, x + 304],
        ...row, maxH: 210, barW: 88,
    }))),
};
const num = (value) => Number(Number(value).toFixed(1)).toString();
const pct = (value) => `${Math.round(value * 100)}%`;
const thousands = (value) => `${(value / 1000).toFixed(1)}K`;
const millions = (value) => `${(value / 1e6).toFixed(1)}M`;
const grouped = (value) => Math.round(value).toLocaleString('en-US');

function panel(spec, subtitle, ours, baseline, baselineLabel) {
    const peak = Math.max(ours.value, baseline.value);
    const height = (value) => (peak > 0 ? (spec.maxH * value) / peak : 0);
    const oursH = height(ours.value);
    const baseH = height(baseline.value);
    return [
        `  <text x="${spec.x}" y="${spec.top}" font-size="15" font-weight="650" fill="#191919">${spec.label}</text>`,
        `  <text x="${spec.x}" y="${spec.top + 20}" font-size="11.5" fill="#8A8779">${subtitle}</text>`,
        `  <rect x="${spec.bars[0]}" y="${num(spec.base - oursH)}" width="${spec.barW}" height="${num(oursH)}" fill="#D97706"/>`,
        `  <text x="${spec.values[0]}" y="${num(spec.base - oursH - 14)}" text-anchor="middle" font-size="21" font-weight="650" fill="#191919">${ours.text}</text>`,
        `  <rect x="${spec.bars[1]}" y="${num(spec.base - baseH)}" width="${spec.barW}" height="${num(baseH)}" fill="url(#hatch)" stroke="#B8B4A7" stroke-width="0.8"/>`,
        `  <text x="${spec.values[1]}" y="${num(spec.base - baseH - 14)}" text-anchor="middle" font-size="21" font-weight="650" fill="#66635A">${baseline.text}</text>`,
        `  <line x1="${spec.line[0]}" y1="${spec.base}" x2="${spec.line[1]}" y2="${spec.base}" stroke="#A8A499" stroke-width="1.2"/>`,
        `  <text x="${spec.values[0]}" y="${spec.base + 26}" text-anchor="middle" font-size="12" font-weight="600" fill="#191919">Mixdog</text>`,
        `  <text x="${spec.values[1]}" y="${spec.base + 26}" text-anchor="middle" font-size="12" fill="#6E6B60">${baselineLabel}</text>`,
    ].join('\n');
}

function chart(entry, figures) {
    const { modelLabel, baselineLabel, subtitle } = entry;
    const { score, speed, context, cost, tokens, requests, first } = figures;
    // A run paired against a baseline with a different trial count (k>1 vs
    // k=1) repeats that baseline across the extra trials, so its scaled pass
    // count (75/89 -> 375/445) is not a figure anyone actually measured.
    // Quote the baseline's own trial count instead, and state the gap in
    // points rather than in trials. Equal-k pairs quote both raw counts.
    const scaled = score.baselineTotal !== score.total;
    const unit = score.k > 1 ? 'trial' : 'task';
    const oursPct = (score.ours / score.total) * 100;
    const basePct = (score.baseline / score.total) * 100;
    const delta = score.ours - score.baseline;
    let deltaText = 'tie';
    if (scaled) deltaText = `${oursPct >= basePct ? '+' : ''}${(oursPct - basePct).toFixed(1)}pp`;
    else if (delta !== 0) deltaText = `${delta > 0 ? '+' : ''}${delta} ${unit}${Math.abs(delta) === 1 ? '' : 's'}`;
    const scoreCounts = scaled
        ? `${score.ours}/${score.total} vs ${score.baselinePassed}/${score.baselineTotal}`
        : `${score.ours} vs ${score.baseline} of ${score.total} ${unit}s`;
    const scorePanel = ['Score', `${scoreCounts} · ${deltaText}`,
        { value: score.ours / score.total, text: `${oursPct.toFixed(1)}%` },
        { value: score.baseline / score.total, text: `${basePct.toFixed(1)}%` }];
    const speedPanel = ['Speed', `wall time per trial · ${speed.ratio.toFixed(2)}&#215; faster`,
        { value: speed.ours, text: `${Math.round(speed.ours)}s` },
        { value: speed.baseline, text: `${Math.round(speed.baseline)}s` }];
    const contextPanel = ['Final context', `median tokens at task end · ${pct(context.reduction)} less`,
        { value: context.ours, text: thousands(context.ours) },
        { value: context.baseline, text: thousands(context.baseline) }];
    const costPanel = ['Priced cost', `index, ${baselineLabel} = 100 · ${pct(cost.reduction)} less`,
        { value: cost.index, text: num(cost.index) },
        { value: 100, text: '100' }];
    // With comparable tokens and request counts the chart shows the outcome
    // on the top row and what produced it on the bottom row.
    const six = Boolean(tokens && requests);
    // The first request is the context before any work is done; without that
    // archive the slot shows the mean input per request instead.
    const startPanel = first
        ? ['Initial context', `median tokens of first request · ${pct(first.reduction)} less`,
            { value: first.ours, text: thousands(first.ours) },
            { value: first.baseline, text: thousands(first.baseline) }]
        : requests && ['Input per request', `mean input tokens · ${pct(requests.inputReduction)} less`,
            { value: requests.oursInput, text: thousands(requests.oursInput) },
            { value: requests.baselineInput, text: thousands(requests.baselineInput) }];
    const frame = six ? SIX : FOUR;
    const panels = six
        ? [['Total tokens', `input incl. cached + output · ${pct(tokens.reduction)} fewer`,
            { value: tokens.ours, text: millions(tokens.ours) },
            { value: tokens.baseline, text: millions(tokens.baseline) }],
        scorePanel,
        costPanel,
        startPanel,
        ['Model requests', `across ${score.total} trials · ${pct(requests.reduction)} fewer`,
            { value: requests.ours, text: grouped(requests.ours) },
            { value: requests.baseline, text: grouped(requests.baseline) }],
        contextPanel]
        : [scorePanel, speedPanel, contextPanel, costPanel];
    const tokenDesc = tokens ? `used ${Math.round(tokens.reduction * 100)} percent fewer tokens, ` : '';
    const title = `Terminal-Bench 2.1: Mixdog with ${modelLabel} versus ${baselineLabel}`;
    const desc = `In matched-model solo runs, Mixdog ${tokenDesc}scored ${oursPct.toFixed(1)} percent over ${score.total} trials versus ${baselineLabel} at ${basePct.toFixed(1)} percent over ${score.baselineTotal} trials, ran ${speed.ratio.toFixed(2)} times faster by full-trial wall time, finished tasks with a ${Math.round(context.reduction * 100)} percent smaller median context, and cost ${Math.round(cost.reduction * 100)} percent less.`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${frame.height}" viewBox="0 0 1200 ${frame.height}" role="img" aria-labelledby="t d" font-family="Styrene A,Segoe UI Variable Display,Segoe UI,Inter,Helvetica Neue,Arial,sans-serif">
  <title id="t">${title}</title>
  <desc id="d">${desc}</desc>
  <defs>
    <pattern id="hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="#FBFAF7"/>
      <line x1="0" y1="0" x2="0" y2="6" stroke="#B8B4A7" stroke-width="1.4"/>
    </pattern>
  </defs>
  <rect width="1200" height="${frame.height}" fill="#F0EEE6"/>
  <text x="64" y="62" font-size="11" letter-spacing="2" font-weight="600" fill="#7A776C">TERMINAL-BENCH 2.1 · ${score.taskCount} TASKS · K=${score.k} VS K=${score.baselineK} · SELF-REPORTED</text>
  <text x="64" y="98" font-size="28" font-weight="650" letter-spacing="-0.3" fill="#191919">Mixdog vs ${baselineLabel}</text>
  <text x="64" y="124" font-size="13.5" fill="#6E6B60">${subtitle}</text>
  <rect x="922" y="82" width="14" height="14" fill="#D97706"/>
  <text x="944" y="94" font-size="13" fill="#191919">Mixdog</text>
  <rect x="1014" y="82" width="14" height="14" fill="url(#hatch)" stroke="#B8B4A7" stroke-width="0.8"/>
  <text x="1036" y="94" font-size="13" fill="#6E6B60">${baselineLabel}</text>

${panels
        .map(([label, sub, ours, baseline], i) => panel({ ...frame.slots[i], label }, sub, ours, baseline, baselineLabel))
        .join('\n\n')}
</svg>
`;
}

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
const firstContextFile = join(here, 'first-context.json');
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
if (!chartsOnly) {
    for (const entry of Object.values(published)) {
        execFileSync(node, [join(here, 'trace-cost.mjs'), entry.jobsDir, '--write'], { cwd: root, stdio: 'inherit' });
    }
    execFileSync(node, [join(here, 'results-table.mjs')], { cwd: root, stdio: 'inherit' });
}

const summary = [];
for (const [key, entry] of Object.entries(published)) {
    const figures = figuresFor(key, entry.jobsDir);
    writeFileSync(join(root, entry.chart), chart(entry, figures));
    summary.push([key, entry, figures]);
    console.log(`chart ${entry.chart}`);
}

// ------------------------------------------------------------------- summary
console.log('\nFigures for the README prose (edit the wording by hand):');
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
    // provenance capture existed are pinned in source-provenance.json instead.
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
        console.log('  source   unrecorded in the run — must be pinned in source-provenance.json before publishing');
    }
}
console.log('');
