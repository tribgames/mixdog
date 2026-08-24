// Final-context metric: median context occupancy of each run's LAST model
// call per task ("how full was the context when the task finished").
// Sources, one extractor per harness (all from raw archived session logs):
//   mixdog     <trial>/agent/session-transcript.json  .lastContextTokens
//   ClaudeCode <trial>/agent/sessions/projects/*/*.jsonl
//              last assistant usage: input + cache_read + cache_creation
//   Codex CLI  <trial>/agent/sessions/**/*.jsonl
//              last token_count payload.info.last_token_usage.input_tokens
// Usage: node analysis/final-context.mjs   (from benchmarks/terminal-bench-2.1)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const published = JSON.parse(readFileSync('presets.json', 'utf8')).published;
const stat = (a) => {
    a = a.filter((x) => Number.isFinite(x) && x > 0).sort((x, y) => x - y);
    if (!a.length) return null;
    return {
        n: a.length,
        median: a[Math.floor(a.length / 2)],
        mean: Math.round(a.reduce((s, x) => s + x, 0) / a.length),
        p90: a[Math.floor(a.length * 0.9)],
    };
};
const dirs = (p) => readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(p, e.name));
const trials = (root) => dirs(root).flatMap(dirs);

function mixdogRun(root) {
    return trials(root).map((t) => {
        try {
            const j = JSON.parse(readFileSync(join(t, 'agent', 'session-transcript.json'), 'utf8'));
            const s = Array.isArray(j) ? j[0] : j;
            return s?.lastContextTokens;
        } catch { return null; }
    });
}
function jsonlFiles(p, out = []) {
    let entries;
    try { entries = readdirSync(p, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const q = join(p, e.name);
        if (e.isDirectory()) jsonlFiles(q, out);
        else if (e.name.endsWith('.jsonl')) out.push(q);
    }
    return out;
}
function ccRun(root) {
    return trials(root).map((t) => {
        let last = null;
        for (const f of jsonlFiles(join(t, 'agent', 'sessions', 'projects'))) {
            for (const l of readFileSync(f, 'utf8').split('\n')) {
                if (!l.includes('"usage"')) continue;
                try {
                    const u = JSON.parse(l)?.message?.usage;
                    if (u && Number.isFinite(u.input_tokens)) last = u;
                } catch { /* not a usage row */ }
            }
        }
        if (!last) return null;
        return (last.input_tokens || 0) + (last.cache_read_input_tokens || 0) + (last.cache_creation_input_tokens || 0);
    });
}
function codexRun(root) {
    return trials(root).map((t) => {
        let last = null;
        for (const f of jsonlFiles(join(t, 'agent', 'sessions'))) {
            for (const l of readFileSync(f, 'utf8').split('\n')) {
                if (!l.includes('token_count')) continue;
                try {
                    const lt = JSON.parse(l)?.payload?.info?.last_token_usage;
                    if (lt && Number.isFinite(lt.input_tokens)) last = lt;
                } catch { /* not a token_count row */ }
            }
        }
        return last ? last.input_tokens || 0 : null;
    });
}

const RUNS = [
    ['mixdog opus5', mixdogRun, published.opus.jobsDir],
    ['mixdog sol-xhigh', mixdogRun, published.sol.jobsDir],
    ['claude code', ccRun, 'jobs-full-cc-n8'],
    ['codex cli', codexRun, 'jobs-full-codex'],
];
for (const [name, fn, dir] of RUNS) {
    console.log(name.padEnd(18), JSON.stringify(stat(fn(dir))));
}
