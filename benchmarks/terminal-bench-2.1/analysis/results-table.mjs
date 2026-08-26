// Regenerate results.md / results.json from the two published runs.
// Usage: node analysis/results-table.mjs   (from benchmarks/terminal-bench-2.1)
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

// Single source of truth for "which runs are published": presets.json.
const published = JSON.parse(readFileSync('presets.json', 'utf8')).published;
const RUNS = {
    opus5: published.opus.jobsDir,
    'sol-xhigh': published.sol.jobsDir,
};
const runDate = (dir) => {
    try {
        const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
        return String(report?.timing?.startedAt ?? '').slice(0, 10);
    } catch { return null; }
};

function collect(root) {
    const out = {};
    const stack = [root];
    while (stack.length) {
        const d = stack.pop();
        let entries;
        try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const p = join(d, e.name);
            if (e.isDirectory()) { stack.push(p); continue; }
            if (e.name !== 'result.json') continue;
            let j; try { j = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
            const m = basename(d).match(/^(.+)__[A-Za-z0-9]+$/);
            if (!m) continue;
            const rewards = j?.verifier_result?.rewards;
            const pass = !!rewards && (rewards.reward ?? rewards.accuracy) === 1;
            // Count every trial. Collapsing to "passed at least once" would
            // turn a k=5 run into a far higher number than its real score.
            const entry = (out[m[1]] ??= { pass: 0, total: 0 });
            entry.total += 1;
            if (pass) entry.pass += 1;
        }
    }
    return out;
}

const byRun = {};
for (const [name, dir] of Object.entries(RUNS)) {
    statSync(dir);
    byRun[name] = collect(dir);
}
const tasks = [...new Set(Object.values(byRun).flatMap((r) => Object.keys(r)))].sort();
// The headline score comes from the run report, so it matches every other
// published figure: trials passed out of trials run.
const scores = Object.fromEntries(Object.entries(RUNS).map(([name, dir]) => {
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    return [name, { passed: report.result.passed, total: report.result.total }];
}));
const kOf = (name) => Math.max(1, Math.round(scores[name].total / tasks.length));
const cell = (name, task) => {
    const e = byRun[name][task];
    if (!e) return '—';
    return kOf(name) === 1 ? (e.pass > 0 ? 'pass' : 'fail') : `${e.pass}/${e.total}`;
};

const md = [
    '# Terminal-Bench 2.1 — per-task results',
    '',
    `Matched-model solo runs, ${runDate(RUNS.opus5) ?? 'unknown date'}.`,
    '',
    `- **opus5**: mixdog · Claude Opus 5 high — \`${RUNS.opus5}\` — \`k=${kOf('opus5')}\` — **${scores.opus5.passed}/${scores.opus5.total}**`,
    `- **sol-xhigh**: mixdog · GPT-5.6 Sol xhigh — \`${RUNS['sol-xhigh']}\` — \`k=${kOf('sol-xhigh')}\` — **${scores['sol-xhigh'].passed}/${scores['sol-xhigh'].total}**`,
    '',
    'A `k>1` cell shows how many of that task\'s trials passed.',
    '',
    '| task | opus5 | sol-xhigh |',
    '|---|---|---|',
    ...tasks.map((t) => `| ${t} | ${cell('opus5', t)} | ${cell('sol-xhigh', t)} |`),
    '',
];
writeFileSync('results.md', md.join('\n'));
writeFileSync('results.json', JSON.stringify({
    generated: new Date().toISOString().slice(0, 10),
    runs: Object.fromEntries(Object.entries(RUNS).map(([n, d]) => [n, {
        jobs_dir: d,
        k: kOf(n),
        score: `${scores[n].passed}/${scores[n].total}`,
    }])),
    tasks: tasks.map((t) => ({ task: t, opus5: byRun.opus5[t] ?? null, sol_xhigh: byRun['sol-xhigh'][t] ?? null })),
}, null, 2) + '\n');
console.log(`results.md / results.json regenerated: opus5 ${scores.opus5.passed}/${scores.opus5.total}, sol-xhigh ${scores['sol-xhigh'].passed}/${scores['sol-xhigh'].total}`);
