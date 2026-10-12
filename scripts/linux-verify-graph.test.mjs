// Evaluates the needs/if job graph of linux-desktop-verify.yml and the release
// wiring around it, to prove the required proof jobs still run when the native
// tools are prebuilt by the caller.
//
// Fidelity of the model (what is and is not simulated):
//  - Implicit `success()` (a job without a status function in its `if`) requires
//    EVERY ancestor in the needs chain to have succeeded: a skipped, failed or
//    cancelled ancestor skips the job, even a transitive one whose direct deps
//    all ran. This is deliberately the conservative reading of GitHub's rule.
//  - failure() is true only if an ancestor failed (skips do not count);
//    cancelled() is the run-level cancellation flag; always() is true.
//  - A reusable-workflow call job (`uses:`) is simulated by running the called
//    workflow's jobs; its result is failure/cancelled if any inner job failed/
//    was cancelled, skipped if all inner jobs were skipped, else success (inner
//    skips do NOT fail the call, so a silently skipped proof is invisible to the caller).
//  - Not modelled: matrix expansion, step-level behaviour, `[linux-full]` commit
//    messages and tag refs in the plan job (plan.full mirrors inputs.full).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parse } from 'yaml'; // throws on duplicate mapping keys

const read = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
const load = (name) => parse(read(name));
const verify = load('linux-desktop-verify.yml');
const release = load('release.yml');

const STATUS_FN = /\b(success|failure|always|cancelled)\(\)/;
const needsOf = (job) => [job.needs ?? []].flat();

function ancestorsOf(jobs, name, seen = new Set()) {
  for (const dep of needsOf(jobs[name])) {
    if (!seen.has(dep)) {
      seen.add(dep);
      ancestorsOf(jobs, dep, seen);
    }
  }
  return seen;
}

/** Does the job run, given the results of the jobs that finished before it? */
function jobRuns(jobs, name, { results, outputs, inputs, cancelled }) {
  const job = jobs[name];
  const ancestors = [...ancestorsOf(jobs, name)].map((dep) => results[dep]);
  const needs = Object.fromEntries(
    needsOf(job).map((dep) => [dep, { result: results[dep], outputs: outputs[dep] ?? {} }])
  );
  const fns = {
    success: () => ancestors.every((result) => result === 'success'),
    failure: () => ancestors.includes('failure'),
    always: () => true,
    cancelled: () => cancelled,
  };
  let expr =
    job.if === undefined
      ? 'success()'
      : String(job.if)
          .trim()
          .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  if (!STATUS_FN.test(expr)) expr = `success() && (${expr})`; // implicit success()
  const js = expr
    .replace(/\b(success|failure|always|cancelled)\(\)/g, '__fns.$1()')
    .replace(/\bneeds\.([\w-]+)/g, (_, dep) => `__needs[${JSON.stringify(dep)}]`)
    .replace(/\binputs\.(\w+)/g, '__inputs.$1');
  assert.doesNotMatch(js.replace(/'[^']*'/g, "''"), /[^\w\s.[\]"'()&|!=-]/, `unsupported expression: ${expr}`);
  return Boolean(new Function('__fns', '__needs', '__inputs', `return (${js});`)(fns, needs, inputs));
}

const aggregate = (results) => {
  const values = Object.values(results);
  if (values.includes('failure')) return 'failure';
  if (values.includes('cancelled')) return 'cancelled';
  return values.every((result) => result === 'skipped') ? 'skipped' : 'success';
};

/** `with:` of a call job merged over the callee's workflow_call input defaults. */
function callInputs(callee, withMap = {}) {
  const defaults = Object.fromEntries(
    Object.entries(callee.on.workflow_call?.inputs ?? {}).map(([k, v]) => [k, v.default])
  );
  return { ...defaults, ...withMap };
}

/**
 * Run a workflow graph. `nested[job]` = { wf, outcomes, nested } makes a `uses:` job
 * run the called workflow; `outcomes[job]` forces the result of a job that runs.
 * Returns { results, inner } with inner[job] the nested run of a call job.
 */
function runWorkflow(wf, { inputs = {}, outcomes = {}, cancelled = false, nested = {}, only } = {}) {
  const jobs = only ? Object.fromEntries(only.map((name) => [name, wf.jobs[name]])) : wf.jobs;
  const results = {};
  const inner = {};
  // plan.full mirrors the plan job's shell: INPUT_FULL === 'true'
  const outputs = { plan: { full: String(inputs.full === true) } };
  const pending = new Set(Object.keys(jobs));
  while (pending.size) {
    const ready = [...pending].filter((name) => needsOf(jobs[name]).every((dep) => dep in results));
    assert.ok(ready.length, 'needs graph has a cycle or unknown dependency');
    for (const name of ready) {
      pending.delete(name);
      if (!jobRuns(jobs, name, { results, outputs, inputs, cancelled })) {
        results[name] = 'skipped';
        continue;
      }
      const call = nested[name];
      if (call) {
        inner[name] = runWorkflow(call.wf, {
          inputs: callInputs(call.wf, jobs[name].with),
          outcomes: call.outcomes,
          nested: call.nested,
          cancelled,
        });
        results[name] = outcomes[name] ?? aggregate(inner[name].results);
      } else {
        results[name] = outcomes[name] ?? 'success';
      }
    }
  }
  return { results, inner };
}

const PROOFS = ['plan', 'tests', 'verify', 'build-next', 'update-path', 'container-smoke'];
const FULL_LANE_ONLY = ['build-next', 'update-path', 'container-smoke'];
const standalone = (wf = verify, extra = {}) => runWorkflow(wf, { inputs: { full: true }, ...extra }).results;
const asCalledByRelease = (wf = verify, outcomes = {}) =>
  runWorkflow(wf, {
    inputs: callInputs(wf, release.jobs['linux-verify-full'].with),
    outcomes,
  }).results;

/** The linux-desktop-verify job conditions as they were before e4c0918d6 (update-path/container-smoke kept implicit success()). */
const brokenVerify = {
  ...verify,
  jobs: {
    ...verify.jobs,
    'update-path': {
      ...verify.jobs['update-path'],
      needs: ['plan', 'verify', 'build-next'],
      if: "needs.plan.outputs.full == 'true'",
    },
    'container-smoke': {
      ...verify.jobs['container-smoke'],
      needs: ['plan', 'verify'],
      if: "needs.plan.outputs.full == 'true'",
    },
  },
};

test('release call (native_tools_prebuilt, full): native-tools skipped, every proof job runs', () => {
  const results = asCalledByRelease();
  assert.equal(results['native-tools'], 'skipped');
  for (const name of PROOFS) assert.equal(results[name], 'success', `${name} must run`);
});

test('standalone dispatch full=true: native-tools builds, every proof job runs', () => {
  const results = standalone();
  assert.equal(results['native-tools'], 'success');
  for (const name of PROOFS) assert.equal(results[name], 'success', `${name} must run`);
});

test('fast lane (push, not full): heavy proofs are skipped, tests and verify still run', () => {
  const { results } = runWorkflow(verify, { inputs: {} });
  for (const name of ['plan', 'native-tools', 'tests', 'verify']) assert.equal(results[name], 'success', name);
  for (const name of FULL_LANE_ONLY) assert.equal(results[name], 'skipped', name);
});

test('failed native-tools, verify or plan blocks the dependent proofs; failure() never counts skips', () => {
  const built = standalone(verify, { outcomes: { 'native-tools': 'failure' } });
  for (const name of ['tests', 'verify', 'build-next', 'update-path', 'container-smoke'])
    assert.equal(built[name], 'skipped', name);
  const failedVerify = asCalledByRelease(verify, { verify: 'failure' });
  for (const name of ['update-path', 'container-smoke']) assert.equal(failedVerify[name], 'skipped', name);
  assert.equal(failedVerify['build-next'], 'success');
  const failedPlan = asCalledByRelease(verify, { plan: 'failure' });
  for (const name of ['verify', 'build-next', 'update-path', 'container-smoke'])
    assert.equal(failedPlan[name], 'skipped', name);
  // failure() is true only for a failed ancestor, not for a skipped one
  const jobs = { a: {}, b: { needs: 'a', if: 'failure()' } };
  assert.equal(jobRuns(jobs, 'b', { results: { a: 'skipped' }, outputs: {}, inputs: {}, cancelled: false }), false);
  assert.equal(jobRuns(jobs, 'b', { results: { a: 'failure' }, outputs: {}, inputs: {}, cancelled: false }), true);
});

test('run cancellation: !cancelled() jobs and implicit-success jobs do not start', () => {
  const { results } = runWorkflow(verify, { inputs: { full: true, native_tools_prebuilt: true }, cancelled: true });
  for (const name of ['tests', 'verify', 'build-next', 'update-path', 'container-smoke'])
    assert.equal(results[name], 'skipped', name);
});

test('implicit success() needs every ancestor to have succeeded (skipped propagates transitively)', () => {
  const jobs = { a: {}, b: { needs: 'a', if: '${{ !cancelled() }}' }, c: { needs: 'b' } };
  const run = (a, b) => jobRuns(jobs, 'c', { results: { a, b }, outputs: {}, inputs: {}, cancelled: false });
  assert.equal(run('success', 'success'), true);
  assert.equal(run('skipped', 'success'), false, 'c skipped although its only direct dep b ran');
  assert.equal(run('failure', 'success'), false);
});

test('regression fixture: before e4c0918d6 the implicit-success proofs were skipped when native-tools was skipped', () => {
  const results = asCalledByRelease(brokenVerify);
  assert.equal(results['native-tools'], 'skipped');
  for (const name of ['plan', 'tests', 'verify', 'build-next']) assert.equal(results[name], 'success', name);
  assert.equal(results['update-path'], 'skipped');
  assert.equal(results['container-smoke'], 'skipped');
  // standalone (native-tools builds) was fine, so only the release call was affected
  const built = standalone(brokenVerify);
  for (const name of PROOFS) assert.equal(built[name], 'success', name);
});

test('every job downstream of native-tools/tests/verify has an explicit status condition and accepts a skipped native-tools', () => {
  const direct = (name) =>
    Object.entries(verify.jobs)
      .filter(([, job]) => needsOf(job).includes(name))
      .map(([job]) => job);
  const downstream = new Set();
  const walk = (name) =>
    direct(name).forEach((job) => {
      if (!downstream.has(job)) {
        downstream.add(job);
        walk(job);
      }
    });
  ['native-tools', 'tests', 'verify'].forEach(walk);
  assert.deepEqual([...downstream].sort(), ['build-next', 'container-smoke', 'tests', 'update-path', 'verify']);
  for (const name of downstream) {
    assert.match(String(verify.jobs[name].if), /!cancelled\(\)/, `${name} needs an explicit status condition`);
    if (ancestorsOf(verify.jobs, name).has('native-tools')) {
      assert.ok(needsOf(verify.jobs[name]).includes('native-tools'), `${name} must list native-tools in needs`);
      assert.match(
        String(verify.jobs[name].if),
        /needs\.native-tools\.result == 'skipped'/,
        `${name} must accept a skipped native-tools`
      );
    }
  }
});

const publishSubgraph = () => [...ancestorsOf(release.jobs, 'publish'), 'publish'];
const releaseRun = (nestedOutcomes = {}, outcomes = {}) =>
  runWorkflow(release, {
    only: publishSubgraph(),
    outcomes,
    nested: {
      'linux-native-tools': { wf: load('linux-native-tools.yml') },
      'linux-verify-full': { wf: verify, outcomes: nestedOutcomes, nested: {} },
    },
  });

test('release.yml: native tools built once, the full lane consumes them, and publish gates on every proof', () => {
  const calls = Object.entries(release.jobs).filter(
    ([, job]) => job.uses === './.github/workflows/linux-native-tools.yml'
  );
  assert.deepEqual(
    calls.map(([name]) => name),
    ['linux-native-tools']
  );
  const full = release.jobs['linux-verify-full'];
  assert.equal(full.uses, './.github/workflows/linux-desktop-verify.yml');
  assert.equal(full.with.native_tools_prebuilt, true);
  assert.equal(full.with.full, true);
  assert.ok(needsOf(full).includes('linux-native-tools'));
  assert.equal(full.if, undefined, 'a skipped verify-full would skip publish silently');
  for (const dep of ['linux-verify-full', 'linux-verify-sha-gate'])
    assert.ok(needsOf(release.jobs.publish).includes(dep), `publish must need ${dep}`);
  assert.equal(release.jobs.publish.if, undefined);
  for (const job of ['desktop-linux-x64', 'desktop-linux-arm64'])
    assert.ok(needsOf(release.jobs[job]).includes('linux-native-tools'), job);
  assert.match(read('desktop-package.yml'), /name: native-tools-glibc228-\$\{\{ inputs\.arch \}\}/);
});

test('release graph (reusable call simulated): publish runs only when every inner proof really ran', () => {
  const ok = releaseRun();
  assert.equal(ok.results['linux-verify-full'], 'success');
  assert.equal(ok.results.publish, 'success');
  const inner = ok.inner['linux-verify-full'].results;
  assert.equal(inner['native-tools'], 'skipped');
  for (const name of PROOFS) assert.equal(inner[name], 'success', `${name} must have run inside the release call`);

  const failed = releaseRun({ 'update-path': 'failure' });
  assert.equal(failed.results['linux-verify-full'], 'failure');
  assert.equal(failed.results.publish, 'skipped');

  const nativeFailed = releaseRun({}, { 'linux-native-tools': 'failure' });
  assert.equal(nativeFailed.results['linux-verify-full'], 'skipped');
  assert.equal(nativeFailed.results.publish, 'skipped');
});

test('release graph with the pre-fix conditions: publish would have proceeded with the proofs silently skipped', () => {
  const broken = runWorkflow(release, {
    only: publishSubgraph(),
    nested: { 'linux-native-tools': { wf: load('linux-native-tools.yml') }, 'linux-verify-full': { wf: brokenVerify } },
  });
  assert.equal(broken.results['linux-verify-full'], 'success', 'inner skips do not fail the reusable call');
  assert.equal(broken.results.publish, 'success');
  assert.equal(broken.inner['linux-verify-full'].results['update-path'], 'skipped');
});
