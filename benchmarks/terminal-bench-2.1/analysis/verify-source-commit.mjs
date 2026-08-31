#!/usr/bin/env node
// Proves which source commit a published run executed.
//
// Benchmark trials run the npm-installed dependency shell with the local
// source tree overlaid on top, so the package version alone does not identify
// the code under measurement. Every run archives digests of its complete
// model-facing contract — rule files, tool schemas, and the delivered prompt
// surface — and those digests are reproducible: extract the claimed commit
// into a clean tree, recompute them there with that commit's own
// contract-hash.mjs, and compare against what the run recorded.
//
//   node analysis/verify-source-commit.mjs
//   node analysis/verify-source-commit.mjs --run jobs-full-sol-xhigh-k5-20260825-182921
//   node analysis/verify-source-commit.mjs --run <jobsDir> --commit <sha>
//
// Exit code is 0 only when every checked digest matches.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const BENCH_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(BENCH_ROOT, '..', '..');
const PROVENANCE_PATH = join(BENCH_ROOT, 'source-provenance.json');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? String(process.argv[index + 1]) : '';
}

// The archived digests are the run's own record; raw-runs/ is the committed
// copy and the local jobs directory is the original.
function recordedContract(jobsDir) {
  const candidates = [
    join(BENCH_ROOT, 'raw-runs', jobsDir, 'preset-run.json'),
    join(BENCH_ROOT, 'raw-runs', jobsDir, 'report.json'),
    join(BENCH_ROOT, jobsDir, 'preset-run.json'),
    join(BENCH_ROOT, jobsDir, 'report.json'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const document = readJson(path);
    const contract = document.contract ?? document?.preset?.contract;
    if (contract?.rulesHash) return { contract, path };
  }
  throw new Error(`no archived contract digests found for ${jobsDir}`);
}

function extractCommit(commit, workDir) {
  const archive = join(workDir, 'source.tar');
  execFileSync('git', ['archive', '--format=tar', '--output', archive, commit], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tree = join(workDir, 'tree');
  mkdirSync(tree, { recursive: true });
  execFileSync('tar', ['-x', '-f', archive, '-C', tree], { stdio: ['ignore', 'pipe', 'pipe'] });
  rmSync(archive, { force: true });
  return tree;
}

// The extracted tree carries source only. Dependencies are linked, never
// copied: a mirror of node_modules would be gigabytes per verification.
function linkDependencies(tree) {
  const target = join(REPO_ROOT, 'node_modules');
  if (!existsSync(target)) {
    throw new Error('node_modules is missing at the repository root; run npm install first');
  }
  const link = join(tree, 'node_modules');
  if (existsSync(link)) return null;
  symlinkSync(target, link, platform() === 'win32' ? 'junction' : 'dir');
  return link;
}

// Remove the link itself, never its contents: deleting through it would take
// the repository's real dependency tree with it.
function removeLink(link) {
  if (!link || !existsSync(link)) return true;
  for (const remove of [unlinkSync, rmdirSync]) {
    try {
      remove(link);
      return true;
    } catch {
      // Try the other removal shape before giving up.
    }
  }
  return false;
}

function recomputeContract(tree, contractArgs) {
  const script = join(tree, 'benchmarks', 'terminal-bench-2.1', 'analysis', 'contract-hash.mjs');
  if (!existsSync(script)) {
    throw new Error('the commit has no analysis/contract-hash.mjs to reproduce digests with');
  }
  const stdout = execFileSync(process.execPath, [script, ...contractArgs], {
    cwd: tree,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  return JSON.parse(stdout);
}

const FIELDS = [
  'rulesHash',
  'rulesBytes',
  'promptSurfaceHash',
  'promptSurfaceBytes',
  'toolContractHash',
  'toolContractBytes',
];

function verifyRun(entry, commitOverride) {
  const commit = commitOverride || String(entry.sourceCommit || '');
  if (!commit) throw new Error(`${entry.jobsDir}: no sourceCommit recorded`);
  const { contract, path } = recordedContract(entry.jobsDir);
  const workDir = mkdtempSync(join(tmpdir(), 'mixdog-tb-verify-'));
  let link = null;
  try {
    const tree = extractCommit(commit, workDir);
    const version = readJson(join(tree, 'package.json')).version;
    link = linkDependencies(tree);
    const rebuilt = recomputeContract(tree, entry.contractArgs ?? []);
    const checks = FIELDS.map((field) => ({
      field,
      recorded: contract[field],
      rebuilt: rebuilt[field],
      ok: String(contract[field]) === String(rebuilt[field]),
    }));
    if (entry.mixdogVersion) {
      checks.unshift({
        field: 'mixdogVersion',
        recorded: entry.mixdogVersion,
        rebuilt: version,
        ok: String(entry.mixdogVersion) === String(version),
      });
    }
    return { commit, checks, evidence: path };
  } finally {
    if (removeLink(link)) {
      rmSync(workDir, { recursive: true, force: true });
    } else {
      console.warn(`warning: could not remove ${link}; left ${workDir} in place`);
    }
  }
}

const provenance = readJson(PROVENANCE_PATH);
if (provenance.schemaVersion !== 1) {
  console.error(`unsupported source-provenance schemaVersion: ${provenance.schemaVersion}`);
  process.exit(1);
}
const only = optionValue('--run');
const commitOverride = optionValue('--commit');
const entries = provenance.runs.filter((entry) => !only || entry.jobsDir === only);
if (entries.length === 0) {
  console.error(only ? `no pinned run named ${only}` : 'source-provenance.json pins no runs');
  process.exit(1);
}
if (commitOverride && entries.length !== 1) {
  console.error('--commit requires a single --run');
  process.exit(1);
}

let failed = 0;
for (const entry of entries) {
  const { commit, checks, evidence } = verifyRun(entry, commitOverride);
  const short = (value) => String(value).replace(/^sha256:/, '').slice(0, 16);
  console.log(`\n=== ${entry.label ?? entry.jobsDir}`);
  console.log(`  run      ${entry.jobsDir}`);
  console.log(`  commit   ${commit}`);
  console.log(`  recorded ${evidence.replace(`${BENCH_ROOT}\\`, '').replace(`${BENCH_ROOT}/`, '')}`);
  for (const check of checks) {
    const status = check.ok ? 'ok      ' : 'MISMATCH';
    console.log(`  ${status} ${check.field.padEnd(19)} ${short(check.rebuilt)}${check.ok ? '' : ` != recorded ${short(check.recorded)}`}`);
    if (!check.ok) failed += 1;
  }
}

console.log(
  failed === 0
    ? `\nverified: every recorded digest reproduces from its pinned commit (${entries.length} run${entries.length === 1 ? '' : 's'})`
    : `\nFAILED: ${failed} digest mismatch(es)`,
);
process.exit(failed === 0 ? 0 : 1);
