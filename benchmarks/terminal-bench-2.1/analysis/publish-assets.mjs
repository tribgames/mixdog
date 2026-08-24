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
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const presets = JSON.parse(readFileSync(join(root, 'presets.json'), 'utf8'));
const published = presets.published ?? {};
const chartsOnly = process.argv.includes('--charts-only');

// ---------------------------------------------------------------- chart shape
// One 1200x600 frame, four panels. Bars are proportional to the larger of the
// two values, so the taller bar is always MAX_H and nothing is clipped.
const BASE_Y = 520;
const MAX_H = 270;
const BAR_W = 72;
const PANELS = {
    score: { label: 'Score', x: 64, bars: [88, 184], values: [124, 220], line: [64, 296] },
    speed: { label: 'Speed', x: 340, bars: [364, 460], values: [400, 496], line: [340, 572] },
    context: { label: 'Final context', x: 616, bars: [640, 736], values: [676, 772], line: [616, 848] },
    cost: { label: 'Priced cost', x: 892, bars: [916, 1012], values: [952, 1048], line: [892, 1124] },
};
const num = (value) => Number(Number(value).toFixed(1)).toString();
const pct = (value) => `${Math.round(value * 100)}%`;
const thousands = (value) => `${(value / 1000).toFixed(1)}K`;

function panel(spec, subtitle, ours, baseline, baselineLabel) {
    const peak = Math.max(ours.value, baseline.value);
    const height = (value) => (peak > 0 ? (MAX_H * value) / peak : 0);
    const oursH = height(ours.value);
    const baseH = height(baseline.value);
    return [
        `  <text x="${spec.x}" y="184" font-size="15" font-weight="650" fill="#191919">${spec.label}</text>`,
        `  <text x="${spec.x}" y="204" font-size="11.5" fill="#8A8779">${subtitle}</text>`,
        `  <rect x="${spec.bars[0]}" y="${num(BASE_Y - oursH)}" width="${BAR_W}" height="${num(oursH)}" fill="#D97706"/>`,
        `  <text x="${spec.values[0]}" y="${num(BASE_Y - oursH - 14)}" text-anchor="middle" font-size="21" font-weight="650" fill="#191919">${ours.text}</text>`,
        `  <rect x="${spec.bars[1]}" y="${num(BASE_Y - baseH)}" width="${BAR_W}" height="${num(baseH)}" fill="url(#hatch)" stroke="#B8B4A7" stroke-width="0.8"/>`,
        `  <text x="${spec.values[1]}" y="${num(BASE_Y - baseH - 14)}" text-anchor="middle" font-size="21" font-weight="650" fill="#66635A">${baseline.text}</text>`,
        `  <line x1="${spec.line[0]}" y1="520" x2="${spec.line[1]}" y2="520" stroke="#A8A499" stroke-width="1.2"/>`,
        `  <text x="${spec.values[0]}" y="546" text-anchor="middle" font-size="12" font-weight="600" fill="#191919">mixdog</text>`,
        `  <text x="${spec.values[1]}" y="546" text-anchor="middle" font-size="12" fill="#6E6B60">${baselineLabel}</text>`,
    ].join('\n');
}

function chart(entry, figures) {
    const { modelLabel, baselineLabel, subtitle } = entry;
    const { score, speed, context, cost } = figures;
    const delta = score.ours - score.baseline;
    const deltaText = delta === 0
        ? 'tie'
        : `${delta > 0 ? '+' : ''}${delta} task${Math.abs(delta) === 1 ? '' : 's'}`;
    const title = `Terminal-Bench 2.1: mixdog with ${modelLabel} versus ${baselineLabel}`;
    const desc = `Across ${score.total} tasks in matched-model solo runs, mixdog scored ${score.ours} of ${score.total} versus ${baselineLabel} at ${score.baseline} of ${score.total}, ran at ${speed.ratio.toFixed(2)} times the speed, finished tasks with a ${Math.round(context.reduction * 100)} percent smaller median context, and cost ${Math.round(cost.reduction * 100)} percent less across all ${score.total} tasks.`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600" role="img" aria-labelledby="t d" font-family="Styrene A,Segoe UI Variable Display,Segoe UI,Inter,Helvetica Neue,Arial,sans-serif">
  <title id="t">${title}</title>
  <desc id="d">${desc}</desc>
  <defs>
    <pattern id="hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="#FBFAF7"/>
      <line x1="0" y1="0" x2="0" y2="6" stroke="#B8B4A7" stroke-width="1.4"/>
    </pattern>
  </defs>
  <rect width="1200" height="600" fill="#F0EEE6"/>
  <text x="64" y="62" font-size="11" letter-spacing="2" font-weight="600" fill="#7A776C">TERMINAL-BENCH 2.1 · ${score.total} TASKS · K=1 SELF-REPORTED</text>
  <text x="64" y="98" font-size="28" font-weight="650" letter-spacing="-0.3" fill="#191919">mixdog vs ${baselineLabel}</text>
  <text x="64" y="124" font-size="13.5" fill="#6E6B60">${subtitle}</text>
  <rect x="922" y="82" width="14" height="14" fill="#D97706"/>
  <text x="944" y="94" font-size="13" fill="#191919">mixdog</text>
  <rect x="1014" y="82" width="14" height="14" fill="url(#hatch)" stroke="#B8B4A7" stroke-width="0.8"/>
  <text x="1036" y="94" font-size="13" fill="#6E6B60">${baselineLabel}</text>

${panel(
        PANELS.score,
        `${score.ours} vs ${score.baseline} of ${score.total} tasks · ${deltaText}`,
        { value: score.ours / score.total, text: `${((score.ours / score.total) * 100).toFixed(1)}%` },
        { value: score.baseline / score.total, text: `${((score.baseline / score.total) * 100).toFixed(1)}%` },
        baselineLabel,
    )}

${panel(
        PANELS.speed,
        `relative agent elapsed · ${speed.ratio.toFixed(2)}&#215; faster`,
        { value: speed.ratio, text: `${speed.ratio.toFixed(2)}&#215;` },
        { value: 1, text: '1.00&#215;' },
        baselineLabel,
    )}

${panel(
        PANELS.context,
        `median tokens at task end · ${pct(context.reduction)} less`,
        { value: context.ours, text: thousands(context.ours) },
        { value: context.baseline, text: thousands(context.baseline) },
        baselineLabel,
    )}

${panel(
        PANELS.cost,
        `index, ${baselineLabel} = 100 · ${pct(cost.reduction)} less`,
        { value: cost.index, text: num(cost.index) },
        { value: 100, text: '100' },
        baselineLabel,
    )}
</svg>
`;
}

// --------------------------------------------------------------------- inputs
function figuresFor(jobsDir) {
    const report = JSON.parse(readFileSync(join(root, jobsDir, 'report.json'), 'utf8'));
    const pair = report.pair;
    if (!pair || pair.error) throw new Error(`${jobsDir}: report has no usable pair comparison`);
    const costRatio = pair.ratios.cost;
    return {
        preset: report.preset.name,
        startedAt: report.timing.startedAt,
        clean: report.result.clean,
        errors: report.result.errors,
        retries: report.result.retries,
        score: { ours: pair.ours.passed, baseline: pair.baseline.passed, total: pair.sharedTasks },
        speed: { ratio: pair.ratios.speedup },
        context: {
            ours: pair.ours.finalContextMedianTokens,
            baseline: pair.baseline.finalContextMedianTokens,
            reduction: pair.ratios.finalContextReduction,
        },
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
    const figures = figuresFor(entry.jobsDir);
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
    console.log(`  speed    ${f.speed.ratio.toFixed(2)}x`);
    console.log(`  context  ${f.context.ours} vs ${f.context.baseline} tokens → ${pct(f.context.reduction)} smaller`);
    console.log(`  cost     $${f.cost.ours.toFixed(2)} vs $${f.cost.baseline.toFixed(2)} → ${pct(f.cost.reduction)} lower`
        + ` (${f.cost.pricedTasks}/${f.score.total} priced, complete=${f.cost.complete}`
        + `${f.cost.baselineLowerBound ? ', baseline is a LOWER BOUND — say "at least"' : ''})`);
    console.log(`  run      clean=${f.clean} (errors ${f.errors}, retries ${f.retries})`);
}
console.log('');
