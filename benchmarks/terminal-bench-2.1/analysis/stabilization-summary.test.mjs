import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { summarizeRuns } from './stabilization-summary.mjs';

const run = (name, bundle, scale = 1) => ({
  run: name, fingerprint: 'same-preset', bundle, rules: 'same-rules', tools: 'same-tools',
  result: { passed: 1, total: 1, errors: 0, retries: 0 },
  tokens: { input: 100 * scale, cached: 60 * scale, cacheWrite: 0, output: 20 * scale },
  totals: { thinking: 12 * scale, thinkingComplete: true, missingThinkingRequests: 0, calls: 3, requests: 2 },
  wall: 10 * scale, agent: 8 * scale, cost: 0.1 * scale,
  tasks: [{ task: 'example', passed: true, agent: 8 * scale, calls: 3,
    output: 20 * scale, outputComplete: true, thinking: 12 * scale, thinkingComplete: true, streamSeconds: 6 * scale }],
});

test('aggregate all input/output without double-counting cache or reasoning and retain distinct bundles', () => {
  const result = summarizeRuns([run('one', 'base'), run('two', 'base', 3), run('three', 'candidate', 2)]);
  assert.equal(result.summary.tokens.inputPlusOutput, 720);
  assert.equal(result.summary.tokens.input, 600);
  assert.equal(result.summary.tokens.cached, 360);
  assert.equal(result.summary.tokens.uncachedInput, 240);
  assert.equal(result.summary.tokens.output, 120);
  assert.equal(result.summary.tokens.reasoning, 72);
  assert.equal(result.summary.tokens.nonReasoningOutput, 48);
  assert.equal(result.summary.wall.total, 60);
  assert.equal(result.summary.agent.total, 48);
  assert.equal(result.cohorts.length, 2);
  assert.equal(result.cohorts[0].runs, 2);
  assert.equal(result.cohorts[0].wall.median, 20);
  assert.equal(result.cohorts[0].taskTotals[0].reasoning, 48);
  assert.equal(result.cohorts[1].runs, 1);
});

test('spread and resolution are reported so a median gap cannot pose as a measured effect', () => {
  // Base: wall 100,120,80 (mean 100, sd 20, cv 0.2). Candidate: 90,110,70.
  const rows = [
    { ...run('b1', 'base'), wall: 100 }, { ...run('b2', 'base'), wall: 120 }, { ...run('b3', 'base'), wall: 80 },
    { ...run('c1', 'cand'), wall: 90 }, { ...run('c2', 'cand'), wall: 110 }, { ...run('c3', 'cand'), wall: 70 },
  ];
  const result = summarizeRuns(rows);
  const base = result.cohorts[0];
  assert.equal(base.wall.sd, 20);
  assert.equal(base.wall.cv, 0.2);
  // 2.802 * 0.2 * sqrt(2/3) ≈ 0.4576: three runs cannot resolve less than ~46%.
  assert.ok(Math.abs(base.wall.detectableFraction - 0.4576) < 0.001);
  // Runs per cohort needed for a 10% effect: 2 * (2.802 * 0.2 / 0.1)^2 ≈ 62.8 → 63.
  assert.equal(base.wall.runsFor['0.10'], 63);
  const wall = result.comparisons.find((row) => row.metric === 'wall');
  assert.equal(wall.base, 'base');
  assert.equal(wall.candidate, 'cand');
  assert.equal(wall.medianDelta, -10);
  assert.equal(wall.medianDeltaFraction, -0.1);
  assert.equal(wall.resolvable, false);
  // A single run has no spread; nothing is claimed either way.
  const single = summarizeRuns([run('only', 'base')]);
  assert.equal(single.cohorts[0].wall.sd, null);
  assert.equal(single.cohorts[0].wall.detectableFraction, null);
  assert.equal(single.comparisons.length, 0);
  assert.equal(single.cohorts[0].taskTotals[0].agentSd, null);
  assert.equal('rows' in single.cohorts[0], false);
});

test('a run that measured its own uncached input is aggregated without re-deriving it', () => {
  const measured = run('measured', 'base');
  // Providers that bill cache reads separately report a small uncached figure
  // next to a large cached one; subtracting from the prompt total is wrong.
  measured.tokens = { input: 1000, cached: 960, cacheWrite: 30, output: 20, uncachedInput: 40 };
  const result = summarizeRuns([measured]);
  assert.equal(result.summary.tokens.input, 1000);
  assert.equal(result.summary.tokens.cached, 960);
  assert.equal(result.summary.tokens.uncachedInput, 40);
  assert.equal(result.summary.tokens.cacheWrite, 30);
  assert.equal(result.summary.tokens.inputPlusOutput, 1020);
});

test('reject incomparable or duplicated observations rather than report misleading totals', () => {
  assert.throws(() => summarizeRuns([]), /At least one/);
  assert.throws(() => summarizeRuns([run('one', 'base'), { ...run('two', 'base'), fingerprint: 'other' }]), /fingerprints/);
  assert.throws(() => summarizeRuns([run('one', 'base'), run('one', 'base')]), /Duplicate/);
  assert.throws(() => summarizeRuns([{ ...run('one', 'base'), bundle: '' }]), /identity/);
  assert.throws(() => summarizeRuns([run('one', 'base'), { ...run('two', 'base'), rules: 'other' }]), /conflicting/);
});

test('legacy measurements without coverage cannot imply complete reasoning totals', () => {
  const legacy = run('legacy', 'base');
  delete legacy.totals.thinkingComplete;
  delete legacy.totals.missingThinkingRequests;
  const result = summarizeRuns([legacy]);
  assert.equal(result.summary.tokens.reasoning, null);
  assert.equal(result.summary.tokens.reasoningRecorded, 12);
  assert.equal(result.summary.tokens.reasoningMissingRequests, null);
  assert.equal(result.summary.tokens.nonReasoningOutput, null);
});

test('append reuses archived measurements and leaves the report intact when new input duplicates a run', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-stabilization-summary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'summary.json');
  writeFileSync(output, JSON.stringify(summarizeRuns([run('archived-without-raw-files', 'base')])));
  const jobs = join(root, 'new-run');
  const runDir = join(jobs, 'trials');
  const agent = join(runDir, 'example__new', 'agent');
  mkdirSync(agent, { recursive: true });
  const fixture = run('new-run', 'candidate', 2);
  writeFileSync(join(jobs, 'report.json'), JSON.stringify({
    preset: { fingerprint: fixture.fingerprint,
      contract: { rulesHash: fixture.rules, toolContractHash: fixture.tools },
      runtime: { bundleSha256: fixture.bundle } },
    paths: { runDir },
    result: fixture.result,
    timing: { wallSeconds: fixture.wall, agentTotalSeconds: fixture.agent },
    cost: { usd: fixture.cost },
    tokens: fixture.tokens,
    tasks: [{ task: 'example', passed: true, agentSeconds: fixture.agent }],
  }));
  writeFileSync(join(agent, 'agent-trace.jsonl'), [
    { kind: 'usage_raw', output_tokens: 20, thinking_tokens: 12 },
    { kind: 'sse', stream_total_ms: 12000 },
  ].map((row) => JSON.stringify(row)).join('\n'));
  writeFileSync(join(agent, 'mixdog.txt'), [
    { type: 'model.request.started' },
    { type: 'model.request.completed', usage: { output_tokens: 20 } },
    { type: 'model.request.started' },
    { type: 'model.request.completed', usage: { output_tokens: 20 } },
  ].map((row) => JSON.stringify(row)).join('\n'));
  const args = [fileURLToPath(new URL('stabilization-summary.mjs', import.meta.url)), '--append', '--out', output, jobs];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const saved = readFileSync(output, 'utf8');
  const combined = JSON.parse(saved);
  assert.equal(combined.summary.runs, 2);
  assert.equal(combined.summary.tokens.inputPlusOutput, 360);
  assert.equal(combined.summary.tokens.reasoning, null);
  assert.equal(combined.summary.tokens.reasoningRecorded, 24);
  assert.equal(combined.summary.tokens.reasoningMissingRequests, 1);
  assert.equal(combined.runs[1].tasks[0].output, 40);
  assert.equal(combined.runs[1].tasks[0].outputComplete, true);
  assert.equal(combined.runs[1].tasks[0].thinkingComplete, false);
  assert.deepEqual(combined.runs.map((row) => row.run), ['archived-without-raw-files', 'new-run']);
  const duplicate = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /Duplicate/);
  assert.equal(readFileSync(output, 'utf8'), saved);
});
