// First-request context: median input tokens of each trial's FIRST model
// request ("how much is in the context before any work is done" — system
// instructions, tool descriptions, and the task prompt).
// Sources, from the raw session logs of the published runs:
//   mixdog     <trial>/agent/agent-trace.jsonl   first usage_raw .input_tokens
//   Codex CLI  <trial>/agent/sessions/**/*.jsonl first token_count
//              payload.info.last_token_usage.input_tokens
// A published pair is archived only when every trial on both sides yields a
// value. The session logs are too large to publish, so the medians are written
// to `analysis/first-context.json` for the charts to read.
//
// Usage: node analysis/first-context.mjs [--write]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const published = JSON.parse(readFileSync(join(root, 'presets.json'), 'utf8')).published ?? {};

const dirs = (p) => readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(p, e.name));
// A jobs dir holds one run dir per launch; a run dir holds the trials.
const trials = (dir) => (existsSync(join(dir, 'result.json')) ? dirs(dir) : dirs(dir).flatMap(dirs));

function firstRow(file, marker, pick) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes(marker)) continue;
        try {
            const value = pick(JSON.parse(line));
            if (Number.isFinite(value) && value > 0) return value;
        } catch { /* not a usage row */ }
    }
    return null;
}
function jsonlFiles(p, out = []) {
    if (!existsSync(p)) return out;
    for (const e of readdirSync(p, { withFileTypes: true })) {
        const q = join(p, e.name);
        if (e.isDirectory()) jsonlFiles(q, out);
        else if (e.name.endsWith('.jsonl')) out.push(q);
    }
    return out;
}
function mixdogFirst(trial) {
    const file = join(trial, 'agent', 'agent-trace.jsonl');
    if (!existsSync(file)) return null;
    return firstRow(file, 'usage_raw', (row) => (row.kind === 'usage_raw' ? row.input_tokens : null));
}
function codexFirst(trial) {
    const file = jsonlFiles(join(trial, 'agent', 'sessions')).sort()[0];
    if (!file) return null;
    return firstRow(file, 'token_count', (row) => row.payload?.info?.last_token_usage?.input_tokens);
}
function stat(values) {
    const found = values.filter((v) => v !== null).sort((a, b) => a - b);
    if (found.length !== values.length || found.length === 0) return null;
    const mid = found.length / 2;
    const median = found.length % 2 ? found[Math.floor(mid)] : (found[mid - 1] + found[mid]) / 2;
    return { trials: found.length, medianTokens: median, minTokens: found[0], maxTokens: found.at(-1) };
}

const archive = {};
for (const [key, entry] of Object.entries(published)) {
    const report = JSON.parse(readFileSync(join(root, entry.jobsDir, 'report.json'), 'utf8'));
    // The report records the baseline as an absolute path on the machine
    // that ran it; only its location under this directory is portable.
    const baselineDir = report.pair?.jobsDir ? resolve(root, report.pair.jobsDir) : null;
    if (!baselineDir || !existsSync(baselineDir)) continue;
    const ours = stat(trials(join(root, entry.jobsDir)).map(mixdogFirst));
    const baseline = stat(trials(baselineDir).map(codexFirst));
    if (!ours || !baseline) {
        console.log(`${key}: no first-request figure (logs missing on one side)`);
        continue;
    }
    archive[key] = { jobsDir: entry.jobsDir, baselineJobsDir: relative(root, baselineDir).replaceAll(sep, '/'), ours, baseline };
    console.log(`${key}: ${ours.medianTokens} vs ${baseline.medianTokens} tokens (${ours.trials} vs ${baseline.trials} trials)`);
}
if (process.argv.includes('--write')) {
    writeFileSync(join(here, 'first-context.json'), `${JSON.stringify(archive, null, 2)}\n`);
    console.log('wrote analysis/first-context.json');
}
