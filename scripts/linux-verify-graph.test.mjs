// Evaluates the needs/if job graph of linux-desktop-verify.yml (and the release
// wiring around it) the way GitHub Actions does, to prove that the required
// proof jobs still run when the native tools are prebuilt by the caller.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parse } from 'yaml'; // throws on duplicate mapping keys

const load = (name) => parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
const verify = load('linux-desktop-verify.yml');
const release = load('release.yml');

const STATUS_FN = /\b(success|failure|always|cancelled)\(\)/;
const needsOf = (job) => [job.needs ?? []].flat();

/**
 * Evaluate one job's `if` over the needs results. Supports the expression
 * subset the workflows use: needs.<job>.result|outputs.<k>, inputs.<k>,
 * success()/cancelled()/failure()/always(), ==, !=, !, &&, ||, parentheses.
 */
function jobRuns(job, { results, outputs, inputs }) {
  const needs = Object.fromEntries(needsOf(job).map((name) => [name, { result: results[name], outputs: outputs[name] ?? {} }]));
  const success = () => Object.values(needs).every((need) => need.result === 'success');
  const fns = { success, failure: () => !success(), always: () => true, cancelled: () => false };
  let expr = job.if === undefined ? 'success()' : String(job.if).trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  if (!STATUS_FN.test(expr)) expr = `success() && (${expr})`; // implicit success()
  const js = expr.replace(/\b(success|failure|always|cancelled)\(\)/g, '__fns.$1()')
    .replace(/\bneeds\.([\w-]+)/g, (_, name) => `__needs[${JSON.stringify(name)}]`)
    .replace(/\binputs\.(\w+)/g, '__inputs.$1');
  assert.doesNotMatch(js.replace(/'[^']*'/g, "''"), /[^\w\s.\[\]"'()&|!=\-]/, `unsupported expression: ${expr}`);
  return Boolean(new Function('__fns', '__needs', '__inputs', `return (${js});`)(fns, needs, inputs));
}

/** Simulate the whole workflow; every job that is allowed to run ends in `outcomes[job]` (default success). */
function simulate({ inputs, planFull, outcomes = {} }) {
  const results = {};
  const outputs = { plan: { full: String(planFull) } };
  const pending = new Set(Object.keys(verify.jobs));
  while (pending.size) {
    const ready = [...pending].filter((name) => needsOf(verify.jobs[name]).every((dep) => dep in results));
    assert.ok(ready.length, 'needs graph has a cycle or unknown dependency');
    for (const name of ready) {
      pending.delete(name);
      results[name] = jobRuns(verify.jobs[name], { results, outputs, inputs }) ? (outcomes[name] ?? 'success') : 'skipped';
    }
  }
  return results;
}

const PROOFS = ['plan', 'tests', 'verify', 'build-next', 'update-path', 'container-smoke'];

test('release call (native_tools_prebuilt, full): native-tools skipped, every proof job runs', () => {
  const results = simulate({ inputs: { full: true, native_tools_prebuilt: true, ref: 'abc' }, planFull: true });
  assert.equal(results['native-tools'], 'skipped');
  for (const name of PROOFS) assert.equal(results[name], 'success', `${name} must run`);
});

test('standalone dispatch full=true: native-tools builds, every proof job runs', () => {
  const results = simulate({ inputs: { full: true }, planFull: true });
  assert.equal(results['native-tools'], 'success');
  for (const name of PROOFS) assert.equal(results[name], 'success', `${name} must run`);
});

test('fast lane (push, not full): heavy proofs are skipped, tests and verify still run', () => {
  const results = simulate({ inputs: {}, planFull: false });
  for (const name of ['plan', 'native-tools', 'tests', 'verify']) assert.equal(results[name], 'success', name);
  for (const name of ['build-next', 'update-path', 'container-smoke']) assert.equal(results[name], 'skipped', name);
});

test('a failed native-tools build or a failed verify blocks the dependent proofs (never runs them on bad input)', () => {
  const built = simulate({ inputs: { full: true }, planFull: true, outcomes: { 'native-tools': 'failure' } });
  for (const name of ['tests', 'verify', 'build-next', 'update-path', 'container-smoke']) assert.equal(built[name], 'skipped', name);
  const failedVerify = simulate({ inputs: { full: true, native_tools_prebuilt: true }, planFull: true, outcomes: { verify: 'failure' } });
  for (const name of ['update-path', 'container-smoke']) assert.equal(failedVerify[name], 'skipped', name);
  assert.equal(failedVerify['build-next'], 'success');
});

test('every job downstream of native-tools/tests/verify carries an explicit !cancelled() condition', () => {
  const direct = (name) => Object.entries(verify.jobs).filter(([, job]) => needsOf(job).includes(name)).map(([job]) => job);
  const downstream = new Set();
  const walk = (name) => direct(name).forEach((job) => { if (!downstream.has(job)) { downstream.add(job); walk(job); } });
  ['native-tools', 'tests', 'verify'].forEach(walk);
  assert.deepEqual([...downstream].sort(), ['build-next', 'container-smoke', 'tests', 'update-path', 'verify']);
  for (const name of downstream) {
    assert.match(String(verify.jobs[name].if), /!cancelled\(\)/, `${name} needs an explicit status condition`);
    if (needsOf(verify.jobs[name]).includes('native-tools')) {
      assert.match(String(verify.jobs[name].if), /needs\.native-tools\.result == 'skipped'/, `${name} must accept a skipped native-tools`);
    }
  }
});

test('release.yml builds native tools once, passes prebuilt, and publish still needs the proofs', () => {
  const calls = Object.entries(release.jobs).filter(([, job]) => job.uses === './.github/workflows/linux-native-tools.yml');
  assert.deepEqual(calls.map(([name]) => name), ['linux-native-tools']);
  const full = release.jobs['linux-verify-full'];
  assert.equal(full.uses, './.github/workflows/linux-desktop-verify.yml');
  assert.equal(full.with.native_tools_prebuilt, true);
  assert.equal(full.with.full, true);
  assert.ok(needsOf(full).includes('linux-native-tools'), 'verify-full must run after the single native-tools build');
  assert.equal(full.if, undefined, 'a skipped verify-full would skip publish silently');
  assert.ok(needsOf(release.jobs['linux-verify-sha-gate']).includes('linux-verify-full'));
  const publish = release.jobs.publish;
  for (const dep of ['linux-verify-full', 'linux-verify-sha-gate']) assert.ok(needsOf(publish).includes(dep), `publish must need ${dep}`);
  assert.equal(publish.if, undefined, 'publish keeps the implicit success() over its needs');
  for (const job of ['desktop-linux-x64', 'desktop-linux-arm64']) {
    assert.ok(needsOf(release.jobs[job]).includes('linux-native-tools'), `${job} consumes the native-tools artifact`);
  }
  assert.match(readFileSync(new URL('../.github/workflows/desktop-package.yml', import.meta.url), 'utf8'), /name: native-tools-glibc228-\$\{\{ inputs\.arch \}\}/);
});
