#!/usr/bin/env node
// The commit a push selects the Rust core's crates against (release-gate.yml `changes`, step `paths`): the head of the newest
// completed run of this workflow on the branch whose core jobs all passed or were not selected. The other lanes select against the
// last commit the whole gate passed on; a run that failed in one of them (a relay or a desktop test) still proved the core at its
// commit, and its crates need no second build and test.
//
// A core job is skipped only when it was not selected or a job it needs did not pass, and every job it needs is checked here as well
// (core-base.test.mjs pins both against the workflow), so a run that passes this check proved the core at its head against
// its own base, as a run that passed whole does.
//
// Usage: node scripts/ci/core-base.mjs --repository <owner/name> --branch <branch>
//   prints the commit, or nothing when no run qualifies; a failed query exits non-zero
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// The jobs that select by their own paths or, on a push, always (every Node lane, core-real and the format check), never by
// core-select.mjs: their result says nothing about the core's crates. Any other job, `changes`, the core's jobs, the dev daemon
// core-entry drives and a job added or renamed later, must have passed or been skipped.
export const OTHER_LANES = new Set([
  'inventory',
  'runtime',
  'runtime-slow',
  'runtime-macos',
  'computer-backend',
  'desktop',
  'desktop-tests',
  'desktop-computer',
  'desktop-slow',
  'relay',
  'relay-rust',
  'spawn',
  'packages',
  'patch',
  'graph',
  'browser-import',
  'secure-desktop',
  'window',
  'mobile-scripts',
  'rustfmt',
  'core-real',
  // the nightly's writer of the workspace build cache: its build proves nothing the archive does not
  'workspace-cache',
  'complete',
]);

/** A job's name without its matrix suffix: `core-tests (linux 1/6)` is `core-tests`. */
export const stemOf = (name) => name.split(' (')[0];

/** Did the run whose jobs these are prove the core at its head? */
export function coreProven(jobs) {
  if (jobs.find((job) => job.name === 'changes')?.conclusion !== 'success') return false;
  return jobs.every(
    (job) => OTHER_LANES.has(stemOf(job.name)) || job.conclusion === 'success' || job.conclusion === 'skipped'
  );
}

/**
 * @param {object} options
 * @param {object[]} options.runs the workflow's runs on the branch, newest first (the REST API's order)
 * @param {(id: number) => object[] | null} options.jobsOf every job of the run's latest attempt, or null when they are not all known
 * @param {number} [options.limit] the most failed runs whose jobs are read
 */
export function coreBase({ runs, repository, jobsOf, limit = 10 }) {
  let read = 0;
  for (const run of runs) {
    if (run.status !== 'completed' || run.event === 'pull_request' || run.head_repository?.full_name !== repository) continue;
    if (run.conclusion === 'success') return run.head_sha;
    if (run.conclusion !== 'failure') continue;
    if (++read > limit) break;
    const jobs = jobsOf(run.id);
    if (jobs && coreProven(jobs)) return run.head_sha;
  }
  return '';
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repository') out.repository = argv[++i];
    else if (argv[i] === '--branch') out.branch = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!out.repository || !out.branch) throw new Error('usage: core-base.mjs --repository <owner/name> --branch <branch>');
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { repository, branch } = parseArgs(process.argv.slice(2));
  const api = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 1 << 26 }));
  const { workflow_runs: runs } = api(
    `repos/${repository}/actions/workflows/release-gate.yml/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=50`
  );
  const jobsOf = (id) => {
    const { total_count: total, jobs } = api(`repos/${repository}/actions/runs/${id}/jobs?filter=latest&per_page=100`);
    return jobs.length === total ? jobs : null;
  };
  console.log(coreBase({ runs, repository, jobsOf }));
}
