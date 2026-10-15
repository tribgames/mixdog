// Exports the verification-grade subset of the published runs into
// `records/<harness>/<model>/<date>[-k5]/` (located through `records/index.json`,
// which this script adds to or updates), which is committed so anyone can recompute every number in the READMEs.
//
// Full `jobs-*` directories stay local. Their session transcripts (mixdog.txt,
// trajectory.json, sessions/) are ~320MB and carry the entire agent prompt
// surface, none of which is needed to re-derive a score or a cost figure.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RECORDS_DIR, readHistoryIndex } from './run-dir.mjs';

const ROOT = 'benchmarks/terminal-bench-2.1';
const RECORDS = join(ROOT, RECORDS_DIR);
const INDEX_FILE = join(RECORDS, 'index.json');
const index = readHistoryIndex(ROOT);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const RUNS = [
  'jobs-full-sol-xhigh-k5-20260825-182921',
  'jobs-full-codex-k5-20260831-050151',
  'jobs-full-codex',
  'jobs-full-opus5-solo-20260825-155233',
  'jobs-full-cc-n8',
  'jobs-full-sol61-20261015-052653',
  'jobs-codex-sol61-xhigh-full',
];

// Per trial: Harbor's verdict, the official verifier output, the pinned task
// checksum, and the usage snapshot each published cost figure is priced from.
// The baselines ship no usage.json, so their raw agent logs are the only
// evidence for the Codex and Claude Code cost and context numbers.
const TRIAL_FILES = [
  'config.json',
  'result.json',
  'exception.txt',
  'verifier/reward.txt',
  'verifier/ctrf.json',
  'verifier/test-stdout.txt',
  'artifacts/manifest.json',
  'agent/usage.json',
  'agent/codex.txt',
  'agent/claude-code.txt',
];

// `runtime-provenance.json` names the source commit and bundle digests the run
// executed; `runtime-manifest.json` lists every bundled file with its sha256,
// so the executed tree can be diffed against any commit without a rebuild.
const RUN_FILES = [
  'report.json',
  'report.md',
  'preset-run.json',
  'runtime-provenance.json',
  'runtime-manifest.json',
];

// A few tasks hand the agent credential-shaped fixture data: sanitize-git-repo
// asks it to purge leaked keys from a repository, so the raw transcript quotes
// them verbatim. Those strings are task data, not live secrets, but GitHub push
// protection blocks them, so the transcript is left out of the published set.
// Every scoring and cost artifact for these tasks is still exported.
const TRANSCRIPT_DENY = new Set(['sanitize-git-repo']);
const TRANSCRIPTS = new Set(['agent/codex.txt', 'agent/claude-code.txt']);

let files = 0;
let bytes = 0;

// A run without an index entry is filed from its own data: harness and model
// from the first trial config, date from the jobs directory's run id. An
// imported agent names no harness there, so its module path does; a Mixdog run
// names no model either, so its model is the lead route in preset-run.json.
const IMPORTED_HARNESS = [
  [/mixdog_agent/, 'mixdog'],
  [/claude_code/, 'claude-code'],
];
function newEntry(run, src) {
  const day = readdirSync(src).find((d) => statSync(join(src, d)).isDirectory());
  const trial = readdirSync(join(src, day)).find((t) => existsSync(join(src, day, t, 'config.json')));
  const agent = readJson(join(src, day, trial, 'config.json')).agent;
  const stamp = run.match(/(\d{4})(\d{2})(\d{2})-\d{6}/);
  const date = stamp ? `${stamp[1]}-${stamp[2]}-${stamp[3]}` : day.slice(0, 10);
  const imported = IMPORTED_HARNESS.find(([pattern]) => pattern.test(String(agent.import_path || '')));
  const harness = agent.name || imported?.[1];
  const presetRun = join(src, 'preset-run.json');
  const lead = existsSync(presetRun) ? readJson(presetRun).definition?.routes?.lead : null;
  const model = agent.model_name || lead?.model;
  if (!harness || !model) {
    throw new Error(`${run}: harness or model is not recorded; add its records/index.json entry by hand`);
  }
  return { jobsDir: run, path: '', model, date, harness, k: 1, score: '', source: 'mixdog' };
}

// Score and attempt count from the verdicts that were exported.
function tally(src) {
  let passed = 0;
  let total = 0;
  const perTask = new Map();
  for (const day of readdirSync(src)) {
    if (!statSync(join(src, day)).isDirectory()) continue;
    for (const trial of readdirSync(join(src, day))) {
      const file = join(src, day, trial, 'result.json');
      if (!existsSync(file)) continue;
      const reward = readJson(file).verifier_result?.rewards?.reward;
      if (reward == null) continue;
      total += 1;
      if (reward === 1) passed += 1;
      const task = trial.replace(/__[^_]+$/, '');
      perTask.set(task, (perTask.get(task) ?? 0) + 1);
    }
  }
  return { score: `${passed}/${total}`, k: Math.max(1, ...perTask.values()) };
}

const copy = (from, to) => {
  if (!existsSync(from)) return;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  files += 1;
  bytes += statSync(from).size;
};

for (const run of RUNS) {
  const src = join(ROOT, run);
  if (!existsSync(src)) {
    console.log(`skip (missing): ${run}`);
    continue;
  }
  let entry = index.find((e) => e.jobsDir === run);
  const result = tally(src);
  if (!entry) {
    entry = newEntry(run, src);
    entry.path = `${entry.harness}/${entry.model}/${entry.date}${result.k > 1 ? `-k${result.k}` : ''}`;
    index.push(entry);
  }
  Object.assign(entry, result);
  const OUT = join(RECORDS, entry.path);
  for (const f of RUN_FILES) copy(join(src, f), join(OUT, f));
  for (const day of readdirSync(src)) {
    const dayDir = join(src, day);
    if (!statSync(dayDir).isDirectory()) continue;
    for (const trial of readdirSync(dayDir)) {
      const trialDir = join(dayDir, trial);
      if (!statSync(trialDir).isDirectory()) continue;
      const task = trial.replace(/__[^_]+$/, '');
      for (const f of TRIAL_FILES) {
        if (TRANSCRIPT_DENY.has(task) && TRANSCRIPTS.has(f)) continue;
        copy(join(trialDir, f), join(OUT, day, trial, f));
      }
    }
  }
  console.log(`exported ${run}`);
}

writeFileSync(INDEX_FILE, `${JSON.stringify(index, null, 2)}\n`);
console.log(`exported: ${files} files, ${(bytes / 1048576).toFixed(1)}MB`);
