// Exports the verification-grade subset of the published runs into `raw-runs/`,
// which is committed so anyone can recompute every number in the READMEs.
//
// Full `jobs-*` directories stay local. Their session transcripts (mixdog.txt,
// trajectory.json, sessions/) are ~320MB and carry the entire agent prompt
// surface, none of which is needed to re-derive a score or a cost figure.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = 'benchmarks/terminal-bench-2.1';
const OUT = join(ROOT, 'raw-runs');

const RUNS = [
  'jobs-full-sol-xhigh-k5-20260825-182921',
  'jobs-full-codex',
  'jobs-full-opus5-solo-20260825-155233',
  'jobs-full-cc-n8',
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

const RUN_FILES = ['report.json', 'report.md', 'preset-run.json'];

// A few tasks hand the agent credential-shaped fixture data: sanitize-git-repo
// asks it to purge leaked keys from a repository, so the raw transcript quotes
// them verbatim. Those strings are task data, not live secrets, but GitHub push
// protection blocks them, so the transcript is left out of the published set.
// Every scoring and cost artifact for these tasks is still exported.
const TRANSCRIPT_DENY = new Set(['sanitize-git-repo']);
const TRANSCRIPTS = new Set(['agent/codex.txt', 'agent/claude-code.txt']);

let files = 0;
let bytes = 0;

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
  for (const f of RUN_FILES) copy(join(src, f), join(OUT, run, f));
  for (const day of readdirSync(src)) {
    const dayDir = join(src, day);
    if (!statSync(dayDir).isDirectory()) continue;
    for (const trial of readdirSync(dayDir)) {
      const trialDir = join(dayDir, trial);
      if (!statSync(trialDir).isDirectory()) continue;
      const task = trial.replace(/__[^_]+$/, '');
      for (const f of TRIAL_FILES) {
        if (TRANSCRIPT_DENY.has(task) && TRANSCRIPTS.has(f)) continue;
        copy(join(trialDir, f), join(OUT, run, day, trial, f));
      }
    }
  }
  console.log(`exported ${run}`);
}

console.log(`raw-runs: ${files} files, ${(bytes / 1048576).toFixed(1)}MB`);
