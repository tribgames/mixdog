import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

import { parse } from 'yaml'; // throws on duplicate mapping keys

// The wiring of .github/workflows/release-gate.yml and rust-core-unix.yml that a typo breaks silently: a job that needs a job that
// does not exist, an artifact downloaded that no needed job uploaded, an output the selector never writes, a job without a timeout.
const ROOT = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');
const gateText = read('.github/workflows/release-gate.yml');
const gate = parse(gateText);
const unix = parse(read('.github/workflows/rust-core-unix.yml'));
const needsOf = (job) => [job.needs ?? []].flat();
const stepsOf = (job) => job.steps ?? [];

function ancestors(jobs, name, seen = new Set()) {
  for (const dep of needsOf(jobs[name])) {
    if (!seen.has(dep)) {
      seen.add(dep);
      ancestors(jobs, dep, seen);
    }
  }
  return seen;
}

for (const [label, workflow] of [
  ['release-gate.yml', gate],
  ['rust-core-unix.yml', unix],
]) {
  test(`${label}: every needs names an existing job, no job needs itself or a cycle, every job has a timeout`, () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const dep of needsOf(job)) assert.ok(workflow.jobs[dep], `${name} needs ${dep}, which does not exist`);
      assert.ok(!ancestors(workflow.jobs, name).has(name), `${name} is in a needs cycle`);
      const timeout = job['timeout-minutes'];
      assert.ok(Number.isFinite(timeout) && timeout > 0, `${name} has no timeout-minutes`);
    }
  });

  test(`${label}: every third-party action is pinned by a commit hash, and every local action exists with the inputs it is given`, () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const step of stepsOf(job)) {
        if (!step.uses) continue;
        if (step.uses.startsWith('./')) {
          const action = parse(read(`${step.uses.slice(2)}/action.yml`));
          for (const input of Object.keys(step.with ?? {})) assert.ok(action.inputs?.[input], `${name}: ${step.uses} has no input ${input}`);
        } else {
          assert.match(step.uses, /@[0-9a-f]{40}\b/, `${name}: ${step.uses} is not pinned by a commit hash`);
        }
      }
    }
  });

  test(`${label}: every artifact a job downloads is uploaded by a job it needs, directly or through the jobs it needs`, () => {
    const uploads = new Map();
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const step of stepsOf(job)) {
        if (step.uses?.startsWith('actions/upload-artifact@')) uploads.set(name, [...(uploads.get(name) ?? []), step.with.name]);
      }
    }
    // A matrix name (`core-tests-${{ matrix.os }}`) is compared up to its first expression.
    const stem = (name) => name.split('${{')[0];
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const step of stepsOf(job)) {
        if (!step.uses?.startsWith('actions/download-artifact@')) continue;
        const wanted = stem(step.with.name);
        const from = [...ancestors(workflow.jobs, name)].filter((up) => (uploads.get(up) ?? []).some((have) => stem(have) === wanted));
        assert.ok(from.length > 0, `${name} downloads ${step.with.name}, which no job it needs uploads`);
      }
    }
  });
}

test('release-gate.yml: complete requires every other job, and checks the result of each it lists', () => {
  const others = Object.keys(gate.jobs).filter((name) => name !== 'complete');
  assert.deepEqual([...needsOf(gate.jobs.complete)].sort(), [...others].sort());
  const script = stepsOf(gate.jobs.complete)[0].run;
  const results = Object.values(stepsOf(gate.jobs.complete)[0].env).filter((value) => /needs\./.test(value));
  assert.equal(results.length, others.length);
  for (const name of others) assert.match(JSON.stringify(stepsOf(gate.jobs.complete)[0].env), new RegExp(`needs\\.${name}\\.result`));
  for (const variable of Object.keys(stepsOf(gate.jobs.complete)[0].env)) assert.match(script, new RegExp(`\\$${variable}\\b`), `${variable} is never checked`);
});

test('release-gate.yml: every output a job reads from `changes` is declared, and written by the selection or by core-select.mjs', () => {
  const declared = Object.keys(gate.jobs.changes.outputs);
  const used = new Set([...gateText.matchAll(/needs\.changes\.outputs\.(\w+)/g)].map((match) => match[1]));
  for (const name of used) assert.ok(declared.includes(name), `needs.changes.outputs.${name} is not declared`);
  const selectionScript = stepsOf(gate.jobs.changes).find((step) => step.id === 'paths').run;
  const selectorSource = read('scripts/ci/core-select.mjs');
  for (const [name, expression] of Object.entries(gate.jobs.changes.outputs)) {
    const [, step, output] = /steps\.(\w+)\.outputs\.(\w+)/.exec(expression);
    if (step === 'paths') {
      const written = new RegExp(`(?:flag ${output}\\b|"${output}=|\\b${output}\\b[^\\n]*(?:;|do))`).test(selectionScript);
      assert.ok(written, `${name}: the selection step never writes ${output}`);
    } else {
      assert.match(selectorSource, new RegExp(`\\b${output}\\b`), `${name}: core-select.mjs never prints ${output}`);
    }
  }
});

test('release-gate.yml: unowned shared inputs cannot be excluded by workflow path filters', () => {
  for (const event of ['pull_request', 'push']) {
    assert.ok(Object.hasOwn(gate.on, event));
    assert.equal(gate.on[event]?.paths, undefined, `${event} must reach the conservative selector for every input`);
    assert.equal(gate.on[event]?.['paths-ignore'], undefined);
  }
});

test('release-gate.yml: the Rust core is built once per system and its tests run from that build', () => {
  const build = gate.jobs['core-build'];
  const tests = gate.jobs['core-tests'];
  assert.deepEqual(needsOf(tests), ['changes', 'core-build']);
  const run = (job) => stepsOf(job).map((step) => step.run ?? '').join('\n');
  assert.match(run(build), /cargo nextest archive /);
  assert.doesNotMatch(run(tests), /cargo (build|test|nextest archive)/, 'a test leg compiles nothing');
  assert.match(run(tests), /--archive-file core-tests\.tar\.zst/);
  assert.match(run(tests), /--partition "count:\$\{PART\}\/\$\{OF\}"/);
  assert.match(run(tests), /--profile ci/);
  // Only a push to main writes the dependency cache.
  for (const name of ['core-build', 'core-lint', 'core-real']) {
    const save = stepsOf(gate.jobs[name]).filter((step) => step.uses?.startsWith('actions/cache/save@'));
    assert.equal(save.length, 1, `${name} saves the cache once`);
    assert.match(save[0].if, /refs\/heads\/main/);
    assert.equal(stepsOf(gate.jobs[name]).filter((step) => step.uses?.startsWith('actions/cache@')).length, 0, `${name} uses restore and save, not a cache that saves on every miss`);
  }
  // Nothing else builds the mixdogd the desktop replays drive.
  assert.doesNotMatch(JSON.stringify(gate.jobs['desktop-slow']), /cargo/);
  assert.doesNotMatch(JSON.stringify(gate.jobs['desktop-tests']), /cargo|MIXDOGD_BIN/);
});

test('release-gate.yml: the Node lanes install and build nothing a root test does not read', () => {
  for (const name of ['runtime', 'runtime-slow', 'runtime-macos']) {
    const text = JSON.stringify(gate.jobs[name]);
    assert.doesNotMatch(text, /office-runtime|libreoffice|build:spawn:test|stage-native-tools|test-shard/i, `${name} still carries the deleted setup`);
  }
});

test('release-gate.yml: every script a step runs from scripts/ci exists', () => {
  for (const [, path] of gateText.matchAll(/(scripts\/ci\/[\w.-]+\.mjs)/g)) assert.ok(existsSync(new URL(path, ROOT)), path);
  assert.ok(readdirSync(new URL('scripts/ci/', ROOT)).includes('core-select.test.mjs'));
});

test('release-gate.yml: phone e2e, full React typecheck, recorder suite and archive required features have owners', () => {
  assert.match(JSON.stringify(gate.jobs['relay-rust']), /npm run check:source --prefix apps\/mobile/);
  assert.match(JSON.stringify(gate.jobs['relay-rust']), /npm run test:e2e --prefix apps\/mobile/);
  assert.match(JSON.stringify(gate.jobs.packages), /npm run typecheck --prefix apps\/mobile/);
  assert.match(JSON.stringify(gate.jobs.packages), /npm ci --prefix apps\/desktop/);
  assert.match(JSON.stringify(gate.jobs['core-real']), /npm run test:bench-tools/);
  assert.match(JSON.stringify(gate.jobs['core-build']), /core_features/);
  assert.match(JSON.stringify(gate.jobs['core-tests']), /--no-tests=fail/);
});

test('release-gate.yml: toolchain actions consume the root pin and desktop output key covers the current closure', () => {
  for (const job of Object.values(gate.jobs)) for (const step of stepsOf(job)) {
    if (step.uses?.startsWith('dtolnay/rust-toolchain@')) assert.equal(step.with.toolchain, '${{ steps.rust-pin.outputs.version }}');
  }
  const key = stepsOf(gate.jobs.desktop).find((step) => step.id === 'desktop-out').with.key;
  assert.match(key, /desktop-out-v5/);
  for (const input of ['packages/**', 'src/**', 'apps/desktop/scripts/**']) assert.ok(key.includes(input));
});

test('release-gate.yml: every bash step parses after expression placeholders are replaced', () => {
  const bash = process.platform === 'win32' ? `${process.env.ProgramFiles || 'C:/Program Files'}/Git/bin/bash.exe` : 'bash';
  for (const [name, job] of Object.entries(gate.jobs)) for (const step of stepsOf(job)) {
    if (!step.run || (step.shell && !step.shell.startsWith('bash'))) continue;
    const script = step.run.replace(/\$\{\{[\s\S]*?\}\}/g, 'placeholder');
    assert.doesNotThrow(() => execFileSync(bash, ['-n'], { input: script, encoding: 'utf8', timeout: 5000 }), `${name}: ${step.name}`);
  }
});
