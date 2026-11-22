import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

import { parse } from 'yaml'; // throws on duplicate mapping keys
import { PROTOCOL_CLIENT_TEST_PATH } from './node-shards.mjs';
import { SHIPPED_MIXDOGD } from './coverage/wiring.mjs';
import { inputProblems, isCoreInput } from './core-inputs.mjs';

// The wiring of .github/workflows/release-gate.yml and rust-core-unix.yml that a typo breaks silently: a job that needs a job that
// does not exist, an artifact downloaded that no needed job uploaded, an output the selector never writes, a job without a timeout.
const ROOT = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');
const gateText = read('.github/workflows/release-gate.yml');
const gate = parse(gateText);
const unix = parse(read('.github/workflows/rust-core-unix.yml'));
const bashPath = () =>
  process.platform === 'win32' ? `${process.env.ProgramFiles || 'C:/Program Files'}/Git/bin/bash.exe` : 'bash';
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

// the tables name their workflows by literal file name so the coverage inventory can name every case they register
for (const label of ['release-gate.yml', 'rust-core-unix.yml']) {
  const workflow = { 'release-gate.yml': gate, 'rust-core-unix.yml': unix }[label];
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
          for (const input of Object.keys(step.with ?? {}))
            assert.ok(action.inputs?.[input], `${name}: ${step.uses} has no input ${input}`);
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
        if (step.uses?.startsWith('actions/upload-artifact@'))
          uploads.set(name, [...(uploads.get(name) ?? []), step.with.name]);
      }
    }
    // A matrix name (`core-tests-${{ matrix.os }}`) is compared up to its first expression.
    const stem = (name) => name.split('${{')[0];
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const step of stepsOf(job)) {
        if (!step.uses?.startsWith('actions/download-artifact@')) continue;
        // a pattern download (the evidence of every leg, the nextest listings) names a family; the composite upload-evidence action and
        // the listing upload of core-tests produce them, and the reconciliation fails when a declared one is absent
        if (step.with.pattern) {
          assert.ok(name === 'complete', `${name} downloads a pattern`);
          continue;
        }
        // the release's own build of mixdogd, which core-real waits for on the release's call (wiring.mjs SHIPPED_MIXDOGD)
        if (name === 'core-real' && step.with.name === SHIPPED_MIXDOGD) continue;
        const wanted = stem(step.with.name);
        const from = [...ancestors(workflow.jobs, name)].filter((up) =>
          (uploads.get(up) ?? []).some((have) => stem(have) === wanted)
        );
        assert.ok(from.length > 0, `${name} downloads ${step.with.name}, which no job it needs uploads`);
      }
    }
  });
}

test('release-gate.yml: complete requires every other job, and checks the result of each it lists', () => {
  const others = Object.keys(gate.jobs).filter((name) => name !== 'complete');
  assert.deepEqual([...needsOf(gate.jobs.complete)].sort(), [...others].sort());
  const script = stepsOf(gate.jobs.complete)[0].run;
  const results = Object.values(stepsOf(gate.jobs.complete)[0].env).filter((value) =>
    /needs\.[\w-]+\.result/.test(value)
  );
  assert.equal(results.length, others.length);
  for (const name of others)
    assert.match(JSON.stringify(stepsOf(gate.jobs.complete)[0].env), new RegExp(`needs\\.${name}\\.result`));
  for (const variable of Object.keys(stepsOf(gate.jobs.complete)[0].env))
    assert.match(script, new RegExp(`\\$${variable}\\b`), `${variable} is never checked`);
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
      const written = new RegExp(`(?:flag ${output}\\b|"${output}=|\\b${output}\\b[^\\n]*(?:;|do))`).test(
        selectionScript
      );
      assert.ok(written, `${name}: the selection step never writes ${output}`);
    } else {
      // The `core` step is core-select.mjs; the `shards` step is node-shards.mjs.
      const source = step === 'shards' ? read('scripts/ci/node-shards.mjs') : selectorSource;
      assert.match(source, new RegExp(`\\b${output}\\b`), `${name}: the script of step ${step} never prints ${output}`);
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

const runOf = (job) =>
  stepsOf(job)
    .map((step) => step.run ?? '')
    .join('\n');
const computerSteps = () => {
  const desktop = gate.jobs['desktop-computer'];
  return {
    desktop,
    helper: desktop.steps.find((step) => step.name === 'Build the native Computer Use helper'),
    suite: desktop.steps.find((step) => step.name === 'Run the Computer Use suites on Windows'),
  };
};

test('release-gate.yml: the Rust core is built once per system and its tests run from that build', () => {
  for (const os of ['linux', 'macos', 'windows']) {
    const own = gate.jobs[`core-tests-${os}`];
    // a system's legs wait for its own archive alone, and every system's jobs run the same steps
    assert.deepEqual(needsOf(own), ['changes', `core-build-${os}`]);
    if (os !== 'linux') assert.match(own.if, new RegExp(`core_${os} == 'true'`), `${os} tests only where the selection runs ${os}`);
    assert.equal(
      gate.jobs[`core-build-${os}`].strategy.matrix,
      `\${{ fromJSON(needs.changes.outputs.build_matrix_${os}) }}`
    );
    assert.equal(own.strategy.matrix, `\${{ fromJSON(needs.changes.outputs.test_matrix_${os}) }}`);
    assert.deepEqual(gate.jobs[`core-build-${os}`].steps, gate.jobs['core-build-linux'].steps);
    assert.deepEqual([own.steps, own.env], [gate.jobs['core-tests-linux'].steps, gate.jobs['core-tests-linux'].env]);
  }
  const build = gate.jobs['core-build-linux'];
  const tests = gate.jobs['core-tests-linux'];
  assert.match(runOf(build), /cargo nextest archive /);
  // the dev daemon builds beside the archive, so no consumer of either waits for both builds of the slowest system; the
  // partitions take no daemon, only the entry scenarios do
  // a job per system: each consumer waits for the daemon of its own system, never for the other's build
  assert.deepEqual(gate.jobs['mixdogd-windows'].steps, gate.jobs['mixdogd-linux'].steps);
  for (const os of ['linux', 'windows']) {
    assert.deepEqual(needsOf(gate.jobs[`mixdogd-${os}`]), ['changes']);
    assert.equal(gate.jobs[`mixdogd-${os}`].if, `needs.changes.outputs.mixdogd_${os} == 'true'`);
    assert.deepEqual(gate.jobs[`mixdogd-${os}`].strategy.matrix.include.map((entry) => entry.os), [os]);
  }
  assert.deepEqual(needsOf(gate.jobs['core-entry']), ['changes', 'core-build-linux', 'mixdogd-linux']);
  for (const name of ['desktop-slow', 'runtime-slow']) assert.deepEqual(needsOf(gate.jobs[name]), ['changes', 'mixdogd-linux'], name);
  for (const [name, job] of Object.entries(gate.jobs))
    assert.ok(!needsOf(job).includes('mixdogd'), `${name} waits for a daemon matrix`);
  assert.doesNotMatch(JSON.stringify(tests), /mixdogd-dev|MIXDOGD_BIN/);
  assert.doesNotMatch(runOf(build), /dev-controls/);
  for (const name of ['runtime-slow', 'desktop-slow', 'desktop-computer'])
    assert.ok(
      !needsOf(gate.jobs[name]).some((need) => need.startsWith('core-build')),
      `${name} waits for the archive builds it does not read`
    );
  assert.doesNotMatch(runOf(tests), /cargo (build|test|nextest archive)/, 'a test leg compiles nothing');
  assert.match(runOf(tests), /--archive-file core-tests\.tar\.zst/);
  assert.match(runOf(tests), /--partition "count:\$\{PART\}\/\$\{OF\}"/);
  assert.match(runOf(tests), /--profile ci/);
});

test('release-gate.yml: only a push to main writes the Rust dependency cache', () => {
  // the build's timing reports go to their artifact, not into the saved build folder
  const build = stepsOf(gate.jobs['core-build-linux']);
  const removed = build.findIndex((step) => step.run === 'rm -rf native/core/target/cargo-timings');
  const uploaded = build.findIndex((step) => /core-timings/.test(step.with?.name ?? ''));
  assert.ok(uploaded >= 0, 'the timing reports are uploaded');
  assert.ok(removed > uploaded);
  assert.ok(removed < build.findIndex((step) => step.uses?.startsWith('actions/cache/save@')));
  for (const name of ['core-build-linux', 'core-build-macos', 'core-build-windows', 'core-lint', 'core-real']) {
    const save = stepsOf(gate.jobs[name]).filter(
      (step) => step.uses?.startsWith('actions/cache/save@') && !/steps\.store\./.test(step.with.key)
    );
    assert.equal(save.length, 1, `${name} saves the cache once`);
    assert.match(save[0].if, /refs\/heads\/main/);
    assert.equal(
      stepsOf(gate.jobs[name]).filter((step) => step.uses?.startsWith('actions/cache@')).length,
      0,
      `${name} uses restore and save, not a cache that saves on every miss`
    );
  }
});

test('release-gate.yml: the desktop replays and fast shards build no Rust and depend on no producer', () => {
  assert.doesNotMatch(JSON.stringify(gate.jobs['desktop-slow']), /cargo/);
  assert.deepEqual(gate.jobs['desktop-tests'].needs, 'changes');
  assert.doesNotMatch(JSON.stringify(gate.jobs['desktop-tests']), /cargo|MIXDOGD_BIN|computer|windows/);
});

test('release-gate.yml: desktop-computer builds the Computer Use helper once, before its suites', () => {
  const { desktop, helper, suite } = computerSteps();
  assert.equal(desktop['runs-on'], 'windows-latest');
  assert.equal(
    helper.run,
    'cargo build --locked --manifest-path native/mixdog-computer/Cargo.toml --bin mixdog-computer --target-dir native/mixdog-computer/target'
  );
  assert.ok(desktop.steps.indexOf(helper) < desktop.steps.indexOf(suite));
  assert.equal(
    suite.env.MIXDOG_COMPUTER_BIN,
    '${{ github.workspace }}/native/mixdog-computer/target/debug/mixdog-computer.exe'
  );
  assert.doesNotMatch(JSON.stringify({ ...desktop, steps: desktop.steps.filter((step) => step !== helper) }), /cargo/);
  assert.doesNotMatch(JSON.stringify(helper), /MIXDOGD_BIN/);
});

test("release-gate.yml: desktop-computer takes this run's Windows daemon and the desktop bundle before its suites", () => {
  const { desktop, suite } = computerSteps();
  assert.equal(suite.env.MIXDOGD_BIN, '${{ github.workspace }}/mixdogd-dev/mixdogd.exe');
  assert.deepEqual(desktop.needs, ['changes', 'desktop', 'mixdogd-windows']);
  const fetched = desktop.steps.filter((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.deepEqual(
    fetched.map((step) => [step.with.name, step.with.path]),
    [
      ['mixdogd-dev-${{ env.GATE_KEY }}-windows', 'mixdogd-dev'],
      ['desktop-out-${{ env.GATE_KEY }}', 'apps/desktop/out'],
    ]
  );
  assert.ok(fetched.every((step) => desktop.steps.indexOf(step) < desktop.steps.indexOf(suite)));
});

test('release-gate.yml: desktop-computer installs and stages the root packages before its suites', () => {
  const { desktop, suite } = computerSteps();
  const install = desktop.steps.find((step) => step.name === 'Install dependencies');
  const stage = desktop.steps.find((step) => step.name?.startsWith('Stage the root packages'));
  assert.match(install.run, /lock-subset\.mjs ci-boot-subset onnxruntime-node pptxgenjs jszip strip-ansi unpdf tsx/);
  // scripts/test.mjs always loads tsx (scripts/test-tsx.mjs): the root-tree invocation fails without it
  assert.match(stage.run, /test -f node_modules\/tsx\/package\.json/);
  assert.match(stage.run, /copyPptxgenjsData/);
  assert.ok(
    desktop.steps.indexOf(install) < desktop.steps.indexOf(stage) &&
      desktop.steps.indexOf(stage) < desktop.steps.indexOf(suite)
  );
});

test('release-gate.yml: the desktop job runs for desktop or computer changes and uploads its bundle', () => {
  assert.equal(
    gate.jobs.desktop.if,
    "needs.changes.outputs.desktop == 'true' || needs.changes.outputs.desktop_computer == 'true'"
  );
  assert.ok(stepsOf(gate.jobs.desktop).some((step) => step.with?.name === 'desktop-out-${{ env.GATE_KEY }}'));
  assert.match(gate.jobs['mixdogd-windows'].steps.find((step) => step.name === 'Upload mixdogd').with.name, /-windows/);
});

test('release-gate.yml: the Node lanes install and build nothing a root test does not read', () => {
  for (const name of ['runtime', 'runtime-slow', 'runtime-macos']) {
    const text = JSON.stringify(gate.jobs[name]);
    assert.doesNotMatch(
      text,
      /office-runtime|libreoffice|build:spawn:test|stage-native-tools/i,
      `${name} still carries the deleted setup`
    );
  }
  // Only the Linux default lane is sharded, by the count scripts/ci/node-shards.mjs sizes from the files it discovers.
  assert.match(JSON.stringify(gate.jobs.runtime), /--test-shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ matrix\.of \}\}/);
  assert.match(gate.jobs.runtime.strategy.matrix, /needs\.changes\.outputs\.runtime_matrix/);
  assert.doesNotMatch(JSON.stringify(gate.jobs['runtime-macos']), /test-shard/);
  assert.doesNotMatch(JSON.stringify(gate.jobs['runtime-slow']), /test-shard/);
});

test('release-gate.yml: every script a step runs from scripts/ci exists', () => {
  for (const [, path] of gateText.matchAll(/(scripts\/ci\/[\w.-]+\.mjs)/g))
    assert.ok(existsSync(new URL(path, ROOT)), path);
  assert.ok(readdirSync(new URL('scripts/ci/', ROOT)).includes('core-select.test.mjs'));
});

test('release-gate.yml: phone e2e, full React typecheck and archive required features have owners', () => {
  assert.match(JSON.stringify(gate.jobs['relay-rust']), /npm run check:source --prefix apps\/mobile/);
  assert.match(JSON.stringify(gate.jobs['relay-rust']), /npm run test:e2e --prefix apps\/mobile/);
  assert.match(JSON.stringify(gate.jobs.packages), /npm run typecheck --prefix apps\/mobile/);
  assert.match(JSON.stringify(gate.jobs.packages), /npm_ci --prefix apps\/desktop/);
  assert.match(JSON.stringify(gate.jobs.packages), /npm_ci --prefix apps\/mobile/);
  assert.match(JSON.stringify(gate.jobs['core-build-linux']), /core_build_features/);
  assert.match(JSON.stringify(gate.jobs['core-tests-linux']), /--no-tests=fail/);
});

test('release-gate.yml: a pull request restores shared caches and never saves one of its own', () => {
  for (const [name, job] of Object.entries(gate.jobs)) {
    for (const step of stepsOf(job)) {
      // `actions/cache` saves from a post step on every miss, a pull request included.
      assert.ok(!step.uses?.startsWith('actions/cache@'), `${name}: ${step.name ?? step.uses} saves on a pull request`);
      if (step.uses?.startsWith('actions/cache/save@')) {
        assert.match(
          step.if,
          /github\.event_name != 'pull_request'|github\.ref == 'refs\/heads\/main'/,
          `${name}: ${step.name} must not run on a pull request`
        );
      }
      // setup-node's own cache saves the same way: the repository's wrapper restores only on a pull request.
      assert.ok(
        !(step.uses?.startsWith('actions/setup-node@') && step.with?.cache),
        `${name}: use ./.github/actions/setup-node-ci for a cached setup-node`
      );
    }
  }
  const action = parse(read('.github/actions/setup-node-ci/action.yml'));
  const restore = action.runs.steps.find((step) => step.uses?.startsWith('actions/cache/restore@'));
  assert.equal(restore.if, "github.event_name == 'pull_request'");
  assert.match(action.runs.steps[0].with.cache, /github\.event_name != 'pull_request' && 'npm' \|\| ''/);
});

test('release-gate.yml: release-profile builds run on a push to main or a manual run, not on a pull request', () => {
  const real = gate.jobs['core-real'];
  assert.match(real.if, /github\.event_name == 'pull_request' && needs\.changes\.outputs\.core_scripts == 'true'/);
  for (const step of stepsOf(real).filter((s) =>
    /Build mixdogd as it ships|Boot mixdogd|stop past its deadline/.test(s.name ?? '')
  )) {
    assert.match(step.if, /github\.event_name != 'pull_request'/, step.name);
  }
  const relay = stepsOf(gate.jobs['relay-rust']);
  const release = relay.find((step) => step.name === 'Build the relay as it ships');
  const debug = relay.find((step) => /test profile \(pull request\)/.test(step.name ?? ''));
  assert.equal(release.if, "github.event_name != 'pull_request' && steps.store.outputs.cache-hit != 'true'");
  assert.equal(debug.if, "github.event_name == 'pull_request' && steps.store.outputs.cache-hit != 'true'");
  assert.doesNotMatch(debug.run, /--release/);
  // The pull request reads the entry core-build writes (same key formula, the dev profile's family).
  const restore = relay.find((step) => step.name === 'Restore the compiled test dependencies');
  const buildKey = stepsOf(gate.jobs['core-build-linux'])
    .find((step) => step.id === 'deps')
    .with.key.split('-${{ hashFiles')[1]
    .replace('${{ env.HALF }}', '');
  assert.ok(restore.with.key.includes(buildKey), 'relay-rust and core-build hash the same inputs');
  assert.match(restore.with.key, /^core-deps-linux-/);
});

test('release-gate.yml: core-tests install only the packages the tests read, without scripts, and no relay twin host; the machine-path check runs in changes', () => {
  const tests = stepsOf(gate.jobs['core-tests-linux'])
    .map((step) => step.run ?? '')
    .join('\n');
  assert.match(tests, /node scripts\/ci\/lock-subset\.mjs ci-node-subset pptxgenjs jszip @napi-rs\/canvas/);
  assert.match(tests, /npm ci --prefix ci-node-subset --ignore-scripts /);
  // mixdog-office tests/pptx_script.rs passes by returning early without the package, so the leg proves it is there
  assert.match(tests, /test -f node_modules\/pptxgenjs\/package\.json/);
  assert.match(tests, /test -f node_modules\/@napi-rs\/canvas\/package\.json/);
  assert.doesNotMatch(tests, /apps\/relay/);
  assert.doesNotMatch(
    JSON.stringify(gate.jobs['core-tests-linux']),
    /setup-node-ci/,
    'no npm download cache restore for a two-package install'
  );
  assert.ok(stepsOf(gate.jobs.changes).some((step) => step.run === 'node scripts/check-machine-paths.mjs'));
  assert.ok(existsSync(new URL('scripts/check-machine-paths.mjs', ROOT)));
});

test('release-gate.yml: a split cache restore never falls back to an entry built for another lockfile', () => {
  const restores = (name) => stepsOf(gate.jobs[name]).filter((step) => step.uses?.startsWith('actions/cache/restore@'));
  // Targets of standalone crates: the lockfile hash is in every restore key, the sources may differ.
  for (const [job, lock] of [
    ['computer-backend', 'mixdog-computer'],
    ['patch', 'mixdog-patch'],
    ['graph', 'mixdog-graph'],
  ]) {
    for (const step of restores(job)) {
      assert.match(
        step.with['restore-keys'],
        new RegExp(`hashFiles\\('native/${lock}/Cargo\\.lock'\\)`),
        `${job}: ${step.name}`
      );
      assert.ok(
        step.with.key.includes(`hashFiles('native/${lock}/Cargo.lock') }}-\${{ hashFiles('native/${lock}/src/**') }}`),
        `${job}: ${step.name}`
      );
    }
  }
  // The whole key is the dependency fingerprint (spawn) or the same fingerprint core-build / core-real write (relay-rust): exact or cold.
  for (const step of [...restores('spawn'), ...restores('relay-rust')]) {
    assert.equal(step.with['restore-keys'], undefined, `${step.name} must not fall back to a prefix`);
  }
  const real = stepsOf(gate.jobs['core-real']).find((step) => step.id === 'deps').with.key;
  const relayRelease = restores('relay-rust').find((step) => step.name === 'Restore the compiled release dependencies')
    .with.key;
  // the shipping profile's entry: core-real on a push builds without the thin-LTO link, into an entry of its own
  assert.equal(
    relayRelease.replace('core-release-linux-', ''),
    real.replace('core-release-${{ matrix.os }}-', '').replace("${{ env.SHIPPING != 'true' && 'nolto-' || '' }}", ''),
    'relay-rust reads the entry core-real (linux) writes in the shipping profile'
  );
});

test('release-gate.yml: every lane filter is checked against the compiled test list of the archive core-build makes, before a release', () => {
  const tests = gate.jobs['core-tests-linux'];
  assert.deepEqual(needsOf(tests), ['changes', 'core-build-linux']);
  const index = stepsOf(tests).findIndex(
    (step) => step.name === 'Check that every lane filter selects a compiled test'
  );
  const download = stepsOf(tests).findIndex((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.ok(download >= 0 && index > download, 'the check runs on the downloaded archive');
  const step = stepsOf(tests)[index];
  assert.equal(step.if, "matrix.os == 'linux' && matrix.part == 1");
  assert.match(
    step.run,
    /cargo nextest list --archive-file core-tests\.tar\.zst --workspace-remap native\/core --message-format json/
  );
  assert.match(step.run, /node scripts\/ci\/check-lane-filters\.mjs nextest-list\.json/);
  // a pull request archive holds only some crates; a main push or manual run archives all and requires every lane package
  assert.match(step.run, /CORE_SCOPE" != all .*--allow-missing-packages/s);
  assert.match(step.env.CORE_SCOPE, /needs\.changes\.outputs\.core_scope/);
  assert.ok('core_scope' in gate.jobs.changes.outputs);
  // the lane runner keeps its own zero-selection failure; release.yml no longer re-runs the lanes (the full gate of the release commit
  // runs their tests in core-tests)
  assert.match(read('scripts/rust-core/k1-lanes.mjs'), /selects no test that runs/);
  assert.equal(parse(read('.github/workflows/release.yml')).jobs['rust-lanes'], undefined);
  assert.ok(existsSync(new URL('scripts/ci/check-lane-filters.mjs', ROOT)));
});

test('release-gate.yml: core-real runs the harness suites after the helper is built', () => {
  const run = stepsOf(gate.jobs['core-real'])
    .map((step) => step.run ?? '')
    .join('\n');
  const names = stepsOf(gate.jobs['core-real']).map((step) => step.name);
  assert.ok(
    names.indexOf('Build the process-tree helper') <
      names.indexOf('Terminal-bench harness suites for the Rust core (OAuth preflight, prebake)')
  );
  assert.match(
    run,
    /anthropic_oauth_preflight_rust\.test\.mjs benchmarks\/terminal-bench-2\.1\/harness\/prebake-rust\.test\.mjs/
  );
  // `node --test` of a missing file fails the job: every test file the job names exists
  for (const path of run.match(
    /(?:scripts\/rust-core|benchmarks\/token-lang|benchmarks\/terminal-bench-2\.1\/harness)\/[\w./-]+\.test\.mjs/g
  ))
    assert.ok(existsSync(new URL(path, ROOT)), `${path} does not exist`);
  const selection = stepsOf(gate.jobs.changes).find((step) => step.id === 'paths').run;
  assert.match(
    selection,
    /CORE_SCRIPTS_RE=.*terminal-bench-2\\\.1\/harness\/\(anthropic_oauth_preflight_rust\|prebake-rust\)/
  );
  for (const file of ['anthropic_oauth_preflight_rust.test.mjs', 'prebake-rust.test.mjs'])
    assert.ok(existsSync(new URL(`benchmarks/terminal-bench-2.1/harness/${file}`, ROOT)), file);
});

test('release-gate.yml: the standalone window and browser-import test jobs run their own manifests', () => {
  assert.match(
    JSON.stringify(gate.jobs.window),
    /run-nextest\.mjs .*--manifest-path native\/mixdog-window\/Cargo\.toml/
  );
  assert.match(
    JSON.stringify(gate.jobs['browser-import']),
    /run-nextest\.mjs .*--manifest-path \\+"\$RUNNER_TEMP\/browser-import\/Cargo\.toml/
  );
  assert.equal(gate.jobs.window['runs-on'], 'windows-latest');
});

test('release-gate.yml: toolchain actions consume the root pin and desktop output key covers the current closure', () => {
  for (const job of Object.values(gate.jobs))
    for (const step of stepsOf(job)) {
      if (step.uses?.startsWith('dtolnay/rust-toolchain@'))
        assert.equal(step.with.toolchain, '${{ steps.rust-pin.outputs.version }}');
    }
  const key = stepsOf(gate.jobs.desktop).find((step) => step.id === 'desktop-out').with.key;
  const release = parse(read('.github/workflows/release.yml'));
  assert.equal(stepsOf(release.jobs['desktop-build']).find((step) => step.id === 'desktop-out').with.key, key);
  const manifestCommand = (job) => stepsOf(job).find((step) => step.id === 'desktop-key').run;
  assert.equal(manifestCommand(gate.jobs.desktop), manifestCommand(release.jobs['desktop-build']));
  assert.match(
    manifestCommand(gate.jobs.desktop),
    /manifest-cache-key\.mjs package-lock\.json apps\/desktop\/package-lock\.json/
  );
  for (const input of [
    'packages/**',
    'src/**',
    'apps/desktop/scripts/**',
    'apps/mobile/src/**',
    'apps/relay/lib/feedback-attachments.mjs',
    'apps/relay/lib/media-http.mjs',
    'apps/relay/lib/relay-close-codes.mjs',
  ]) {
    assert.ok(key.includes(input));
  }
});

test('release-gate.yml: every bash step parses after expression placeholders are replaced', () => {
  const bash = bashPath();
  for (const [name, job] of Object.entries(gate.jobs))
    for (const step of stepsOf(job)) {
      if (!step.run || (step.shell && !step.shell.startsWith('bash'))) continue;
      const script = step.run.replace(/\$\{\{[\s\S]*?\}\}/g, 'placeholder');
      assert.doesNotThrow(
        () => execFileSync(bash, ['-n'], { input: script, encoding: 'utf8', timeout: 5000 }),
        `${name}: ${step.name}`
      );
    }
});

test('release-gate.yml: the Postgres-backed tests run from the core-build archive under the profile that selects them, with the shipped runtime', () => {
  const job = gate.jobs['core-pg'];
  assert.deepEqual(needsOf(job), ['changes', 'core-build-linux']);
  // macOS runs both profiles in one job, each its own slot, from its own archive
  const mac = gate.jobs['core-pg-macos'];
  assert.deepEqual(needsOf(mac), ['changes', 'core-build-macos']);
  assert.equal(mac.env.MIXDOG_LEG, 'macos/core-pg/1of1');
  const profiles = stepsOf(mac).filter((step) => /--run-ignored only/.test(step.run ?? ''));
  assert.deepEqual(
    profiles.map((step) => step.env.MIXDOG_SLOT),
    ['services-pg', 'pg']
  );
  for (const step of profiles) {
    assert.match(step.run, new RegExp(`--profile ${step.env.MIXDOG_SLOT} `));
    assert.match(step.run, /--archive-file core-tests\.tar\.zst --workspace-remap native\/core/);
    assert.match(step.run, /--no-tests=fail/);
  }
  assert.match(runOf(mac), /node scripts\/ci\/provision-pg-runtime\.mjs/);
  // the second profile runs after the first one's tests fail, never after a failed setup
  const provision = stepsOf(mac).find((step) => /provision-pg-runtime/.test(step.run ?? ''));
  assert.match(profiles[1].if, new RegExp(`!cancelled\\(\\) && steps\\.${provision.id}\\.outcome == 'success'`));
  assert.match(job.strategy.matrix, /needs\.changes\.outputs\.core_pg_matrix/);
  const run = stepsOf(job)
    .map((step) => step.run ?? '')
    .join('\n');
  assert.doesNotMatch(run, /cargo (build|test|nextest archive)/, 'the job compiles nothing');
  assert.match(run, /--archive-file core-tests\.tar\.zst --workspace-remap native\/core/);
  assert.match(run, /--profile "\$\{\{ matrix\.profile \}\}"/);
  assert.match(run, /--run-ignored only/);
  assert.match(run, /--no-tests=fail/);
  assert.match(run, /node scripts\/ci\/provision-pg-runtime\.mjs "\$RUNNER_TEMP\/pg-runtime" \| tee -a "\$GITHUB_ENV"/);
  assert.equal(stepsOf(job).filter((step) => step.uses?.startsWith('actions/cache')).length, 0, 'no cache of its own');
  // every profile the selector hands out exists in nextest.toml, with the filter that names its crate
  const nextest = read('native/core/.config/nextest.toml');
  const selector = read('scripts/ci/core-select.mjs');
  for (const [, profile, pkg] of selector.matchAll(/\{ name: '([\w-]+)', package: '([\w-]+)' \}/g)) {
    const body = nextest.slice(nextest.indexOf(`[profile.${profile}]`));
    assert.ok(nextest.includes(`[profile.${profile}]`), profile);
    assert.match(body.slice(0, body.indexOf('\n]')), new RegExp(`package\\(${pkg}\\)`), `${profile} selects ${pkg}`);
  }
  // the tests the issue named: the daemon's session-project and ssh-origin modules are in the profile's filter and its time budget
  assert.match(nextest, /\[profile\.pg\][\s\S]*session_project_flow_tests[\s\S]*\^ssh_origin_tests::/);
  assert.match(
    nextest,
    /\[\[profile\.default\.overrides\]\]\nfilter = '''package\(mixdog-app-server-daemon\)[\s\S]*\^ssh_origin_tests::[\s\S]*terminate-after = 6/
  );
});

test('release-gate.yml: complete fails any job its own `if` selected that did not succeed, for every job of the graph', () => {
  const step = stepsOf(gate.jobs.complete)[0];
  const variable = (name) => name.toUpperCase().replace(/-/g, '_');
  const jobs = Object.keys(gate.jobs).filter((name) => name !== 'complete' && name !== 'changes');
  assert.deepEqual([...needsOf(gate.jobs.complete)].sort(), ['changes', ...jobs].sort());
  const flat = (text) => String(text).replace(/\s+/g, ' ').trim();
  for (const job of jobs) {
    assert.ok(gate.jobs[job].if !== undefined, `${job} has no \`if\`, so nothing says when it is selected`);
    // the selection is the job's own condition, verbatim, and the result is the job's own
    assert.equal(
      flat(step.env[`SEL_${variable(job)}`]),
      `\${{ ${flat(gate.jobs[job].if)} }}`,
      `${job}: SEL_ differs from the job's if`
    );
    assert.equal(step.env[variable(job)], `\${{ needs.${job}.result }}`);
    assert.match(
      step.run,
      new RegExp(`gate ${job} "\\$SEL_${variable(job)}" "\\$${variable(job)}"`),
      `${job} is never gated`
    );
  }
});

// The gate function of `complete`, run over a selected / result pair.
function runGate(selected, result) {
  const script = stepsOf(gate.jobs.complete)[0].run;
  const start = script.indexOf('gate() {');
  const body = script.slice(start, script.indexOf('\n          gate ', start)).replace(/^ {10}/gm, '');
  try {
    execFileSync(bashPath(), ['-c', `${body}\ngate job "${selected}" "${result}"`], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

test('release-gate.yml: complete passes a skipped job only when it was not selected', () => {
  // desktop_tests=true with desktop-tests skipped is the false green the review found
  assert.equal(runGate('true', 'skipped'), false);
  assert.equal(runGate('true', 'success'), true);
  for (const result of ['failure', 'cancelled']) {
    assert.equal(runGate('true', result), false);
    assert.equal(runGate('false', result), false);
  }
  assert.equal(runGate('false', 'skipped'), true);
  assert.equal(runGate('false', 'success'), true);
});

test('release-gate.yml: a failed shard discovery fails changes, and no one-shard matrix stands in for it', () => {
  const output = gate.jobs.changes.outputs.runtime_matrix;
  assert.doesNotMatch(output, /"shard":1/);
  const step = stepsOf(gate.jobs.changes).find((s) => s.id === 'shards');
  assert.match(step.run, /\| tee/);
  assert.equal(step.shell, 'bash', 'an explicit bash shell runs with pipefail');
  // every step that pipes into tee has pipefail: an explicit bash shell, a bash default, or set -o pipefail
  for (const [name, job] of Object.entries(gate.jobs)) {
    for (const s of stepsOf(job)) {
      if (!/\|\s*tee\b/.test(s.run ?? '')) continue;
      const shell = s.shell ?? job.defaults?.run?.shell;
      assert.ok(
        shell === 'bash' || /set -\w*o pipefail|set -\w*u?o? ?pipefail/.test(s.run),
        `${name}: ${s.name} pipes into tee without pipefail`
      );
    }
  }
});
test('release-gate.yml: the build is a clean checkout and no tracked script reads a file a clean checkout lacks', () => {
  const runs = (name) => stepsOf(gate.jobs[name]).map((step) => step.run ?? '');
  assert.ok(runs('changes').includes('node scripts/ci/check-clean-checkout.mjs --readers'));
  for (const name of ['core-build-linux', 'core-build-macos', 'core-build-windows', 'mixdogd-linux', 'mixdogd-windows', 'core-lint']) {
    const index = runs(name).indexOf('node scripts/ci/check-clean-checkout.mjs --build');
    assert.ok(index >= 0, `${name} checks its checkout`);
    assert.ok(stepsOf(gate.jobs[name]).findIndex((step) => step.uses?.startsWith('actions/checkout@')) < index);
  }
  // core-tests runs the archive of core-build on every system, a pull request's subset included: the whole workspace is
  // selected by the full gate (scope all), which is what the release gate runs, and by a change to a core input outside the crates
  assert.match(read('scripts/ci/core-select.mjs'), /if \(whole\) \{\s*scope = 'all'/);
});

// The `paths` step of `changes`, run as a pull request over a two-commit repository: which selector outputs a change turns on.
// `renames` are files of the base commit moved by the change; `changedOut` receives the list the step selected from.
function selected(changedPaths, { renames = [], changedOut } = {}) {
  const script = stepsOf(gate.jobs.changes).find((step) => step.id === 'paths').run;
  const dir = mkdtempSync(join(tmpdir(), 'gate-select-'));
  const slash = (path) => path.replaceAll('\\', '/');
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args],
      { cwd: dir, encoding: 'utf8' }
    );
  try {
    git('init', '-q');
    writeFileSync(join(dir, 'base.txt'), 'x');
    for (const [from] of renames) {
      mkdirSync(dirname(join(dir, from)), { recursive: true });
      writeFileSync(join(dir, from), 'a module of several lines\n'.repeat(20));
    }
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    for (const [from, to] of renames) {
      mkdirSync(dirname(join(dir, to)), { recursive: true });
      git('mv', from, to);
    }
    for (const path of changedPaths) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), 'changed');
    }
    git('add', '.');
    git('commit', '-q', '-m', 'change');
    const sha = git('rev-parse', 'HEAD').trim();
    const output = join(dir, 'github-output');
    writeFileSync(output, '');
    // the script's /tmp is the runner's; the test points it at the scratch directory
    const local = script.replaceAll('/tmp/', `${slash(dir)}/`);
    // From a file: the script is longer than a Windows command line takes.
    writeFileSync(join(dir, 'paths.sh'), local);
    execFileSync(bashPath(), [slash(join(dir, 'paths.sh'))], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        EVENT_NAME: 'pull_request',
        FULL_GATE: 'false',
        PR_BASE: base,
        PUSH_BASE: '',
        HEAD_MESSAGE: '',
        ACTOR: 'someone',
        GITHUB_SHA: sha,
        GITHUB_OUTPUT: slash(output),
      },
    });
    if (changedOut) changedOut.push(...readFileSync(join(dir, 'changed'), 'utf8').split('\n').filter(Boolean));
    const flags = Object.fromEntries(
      readFileSync(output, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('='))
    );
    return Object.keys(flags)
      .filter((name) => flags[name] === 'true')
      .sort();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('release-gate.yml: a change to the toolchain pin, the workflow or the core workspace selects every job that consumes it', () => {
  const TOOLCHAIN_JOBS = [
    'browser_import',
    'computer',
    'core_scripts',
    'graph',
    'patch',
    'relay',
    'secure_desktop',
    'spawn',
    'window',
  ];
  const WORKFLOW_JOBS = [...TOOLCHAIN_JOBS, 'desktop', 'desktop_tests', 'mobile', 'packages', 'runtime'];
  const WORKSPACE_JOBS = ['core_scripts', 'desktop', 'desktop_tests', 'relay', 'runtime', 'spawn'];
  const table = [
    ['.github/workflows/release-gate.yml', WORKFLOW_JOBS],
    ['native/core/Cargo.lock', WORKSPACE_JOBS],
    ['native/core/Cargo.toml', WORKSPACE_JOBS],
    ['apps/mobile/src/phone-client.ts', ['desktop', 'desktop_tests', 'mobile', 'relay']],
    ['apps/relay/lib/media-http.mjs', ['desktop', 'desktop_tests', 'relay']],
    ['CHANGELOG.md', ['desktop', 'desktop_tests']],
    ['changelog/ja.md', ['desktop', 'desktop_tests']],
    ['native/mixdog-window/src/lib.rs', ['runtime', 'window']],
    ['native/mixdog-browser-import/Cargo.toml', ['browser_import', 'runtime']],
    ['native/mixdog-graph/Cargo.toml', ['graph', 'runtime']],
  ];
  assert.deepEqual(selected(['rust-toolchain.toml']), [...TOOLCHAIN_JOBS, 'desktop_computer', 'rustfmt'].sort());
  for (const [path, jobs] of table) {
    const got = selected([path]);
    for (const job of jobs) assert.ok(got.includes(job), `${path} must select ${job}; selected ${got.join(', ')}`);
  }
  assert.deepEqual(selected(['docs/readme.md']), []);
  assert.deepEqual(selected(['apps/desktop/src/renderer/connectors.css']), ['desktop', 'desktop_css_only']);
  // each output the table names is read by a job's own `if`
  for (const job of TOOLCHAIN_JOBS.filter((name) => name !== 'core_scripts'))
    assert.ok(gateText.includes(`needs.changes.outputs.${job} == 'true'`), job);
});

test('release-gate.yml: nextest inputs and the computer helper select their PR consumers without adding unrelated lanes', () => {
  const standalone = [
    'browser_import',
    'computer',
    'core_scripts',
    'graph',
    'patch',
    'secure_desktop',
    'spawn',
    'window',
  ];
  const inputs = ['.github/actions/install-nextest/action.yml', 'native/.config/nextest-standalone.toml'];
  for (const paths of [inputs, ...inputs.map((path) => [path])]) {
    assert.deepEqual(selected(paths), standalone, paths.join(', '));
  }
  assert.deepEqual(selected(['native/mixdog-computer/Cargo.toml']), ['computer', 'desktop_computer', 'runtime', 'rustfmt']);
  // A helper-only PR runs the Windows job alone; any desktop test change runs the three Linux shards and the Windows job.
  assert.equal(
    gate.jobs['desktop-computer'].if,
    "needs.changes.outputs.desktop_tests == 'true' || needs.changes.outputs.desktop_computer == 'true'"
  );
  assert.equal(gate.jobs['desktop-tests'].if, "needs.changes.outputs.desktop_tests == 'true'");
  assert.deepEqual(gate.jobs['desktop-tests'].strategy.matrix, { shard: [1, 2, 3] });
});

// A test invocation of a workflow: a line of a step's `run` that starts a test runner (not a comment line).
const TEST_COMMAND =
  /(?:^|[\s;&|(])(?:npm (?:run )?test(?::\w+)?(?=\s|$)|node (?:\.\.\/)*scripts\/test\.mjs|node (?:\.\.\/)*scripts\/ci\/node-test\.mjs|node (?:\.\.\/)*scripts\/ci\/run-receipt\.mjs|node (?:\.\.\/)*scripts\/ci\/run-nextest\.mjs|cargo test(?=\s)|python3? -m unittest)/;
const receiptNames = (text) => [...text.matchAll(/receipts\/([\w.-]+)\.json/gi)].map((hit) => hit[1]);

function invocationsOf(job) {
  const found = [];
  for (const step of stepsOf(job)) {
    for (const raw of String(step.run ?? '').split('\n')) {
      const line = raw.trim();
      if (line && !line.startsWith('#') && TEST_COMMAND.test(line)) found.push({ step, line });
    }
  }
  return found;
}

for (const label of ['release-gate.yml', 'desktop-package.yml']) {
  const workflow = label === 'release-gate.yml' ? gate : parse(read(`.github/workflows/${label}`));
  test(`${label}: every test invocation leaves its own receipt and a later check of its job names it`, () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const declared = [];
      // a receipt name belongs to one invocation: an inline one to its command line, one in a step's env to that step
      const owner = new Map();
      for (const { step, line } of invocationsOf(job)) {
        const inline = /MIXDOG_RECEIPT="?\$RECEIPTS\/([\w.-]+)\.json/.exec(line)?.[1];
        const fromEnv = receiptNames(step.env?.MIXDOG_RECEIPT ?? '')[0];
        assert.ok(inline || fromEnv, `${name}: "${line}" leaves no receipt (MIXDOG_RECEIPT)`);
        // a cargo or unittest run is not a Node runner: only the wrapper reads its output into a receipt
        if (/cargo test|unittest/.test(line))
          assert.match(
            line,
            /run-receipt\.mjs unittest /,
            `${name}: "${line}" must run through scripts/ci/run-receipt.mjs`
          );
        const id = inline ? line : `step ${stepsOf(job).indexOf(step)}`;
        const receipt = inline ?? fromEnv;
        assert.ok(
          owner.get(receipt) === undefined || owner.get(receipt) === id,
          `${name}: receipt ${receipt} is shared by two invocations`
        );
        owner.set(receipt, id);
        declared.push({ name: receipt, step });
      }
      if (declared.length === 0) continue;
      // core-tests and core-pg leave one receipt per partition or profile whose skips are the reconciliation's (the ignore dispositions
      // of the unfiltered listing include tests a profile leg runs, which need no exception): `complete` reconciles them, there is no
      // per-job skip check to name them in
      if (/^core-(tests-|entry$|pg)/.test(name)) continue;
      const checks = stepsOf(job).filter((step) => /check-skips\.mjs receipts/.test(step.run ?? ''));
      assert.ok(checks.length > 0, `${name}: no check-skips.mjs receipts step`);
      const checked = new Set(
        checks.flatMap((step) => [
          ...receiptNames(step.run ?? ''),
          ...(/\$MIXDOG_RECEIPT/.test(step.run ?? '') ? receiptNames(step.env?.MIXDOG_RECEIPT ?? '') : []),
        ])
      );
      for (const { name: receipt } of declared)
        assert.ok(checked.has(receipt), `${name}: receipt ${receipt} is never checked`);
      const lastRun = Math.max(...declared.map(({ step }) => stepsOf(job).indexOf(step)));
      // a check in the step of the last run (desktop-package.yml) follows its command
      assert.ok(
        stepsOf(job).indexOf(checks.at(-1)) >= lastRun,
        `${name}: the receipts are checked before the last test ran`
      );
    }
  });
}

test('workflows: the retired MIXDOG_SKIP_REPORT file, which a missing file read as zero skips, is gone', () => {
  for (const file of ['release-gate.yml', 'desktop-package.yml'])
    assert.doesNotMatch(read(`.github/workflows/${file}`), /MIXDOG_SKIP_REPORT|test ! -s/, file);
});

test('desktop-package.yml: the Windows runtime step takes a receipt and no skip at all', () => {
  const steps = Object.values(parse(read('.github/workflows/desktop-package.yml')).jobs).flatMap(stepsOf);
  const step = steps.find((entry) => /computer-native-package/.test(entry.run ?? ''));
  assert.match(step.env.MIXDOG_RECEIPT, /receipts\/windows-runtime\.json$/);
  assert.match(step.run, /check-skips\.mjs receipts --strict "\$MIXDOG_RECEIPT"/);
});

test('release-gate.yml: every system lists its archive unfiltered for the reconciliation, the reader scan is advisory, and every standalone Rust lane has a check', () => {
  const rust = stepsOf(gate.jobs['core-tests-linux']).find(
    (step) => step.name === 'List the archive (unfiltered, and per profile that runs ignored tests)'
  );
  // every system's archive is listed whatever the scope of the run: a macOS-only ignored test is seen by no other leg
  assert.equal(rust.if, 'matrix.part == 1');
  assert.equal(rust.env.OS, '${{ matrix.os }}');
  for (const profile of ['pg', 'services-pg'])
    assert.ok(read('scripts/ci/core-select.mjs').includes(`name: '${profile}'`), profile);
  assert.match(rust.run, /for profile in pg services-pg/);
  assert.match(rust.run, /--profile "\$profile" --run-ignored only --message-format json/);
  assert.match(rust.run, /\[\[ "\$OS" != windows \]\]/);
  assert.doesNotMatch(
    JSON.stringify(gate.jobs['core-tests-linux']),
    /check-skips\.mjs rust/,
    'a listing that matches a profile credits nothing'
  );
  const upload = stepsOf(gate.jobs['core-tests-linux']).find(
    (step) => step.uses?.startsWith('actions/upload-artifact@') && /rust-lists/.test(step.with.name)
  );
  assert.equal(upload.with.name, 'rust-lists-${{ env.GATE_KEY }}-${{ matrix.os }}');
  // the entry scenarios the audit lists are run by core-entry, from the Linux archive, against the daemon the same run built,
  // with the audit's filter
  const entry = stepsOf(gate.jobs['core-entry']);
  const run = entry.find(
    (step) => step.name === 'Run the interactive entry scenarios (the terminal interface and --plain, without Node)'
  );
  const fetched = entry.filter((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.deepEqual(
    fetched.map((step) => step.with.name),
    ['core-tests-${{ env.GATE_KEY }}-linux', 'mixdogd-dev-${{ env.GATE_KEY }}']
  );
  assert.ok(fetched.every((step) => entry.indexOf(step) < entry.indexOf(run)));
  assert.equal(gate.jobs['core-entry'].env.MIXDOG_LEG, 'linux/core-entry/1of1');
  assert.equal(run.env.MIXDOG_SLOT, 'entry');
  assert.equal(gate.jobs['core-entry'].if, "needs.changes.outputs.core_entry == 'true'");
  for (const text of [rust.run, run.run]) assert.match(text, /package\(mixdog-entry\) & binary\(node_free\)/);
  const readers = stepsOf(gate.jobs.changes).find((step) => /check-clean-checkout\.mjs --readers/.test(step.run ?? ''));
  assert.equal(readers['continue-on-error'], true, 'the reader scan is advice, like the silent-return scan');
  const silent = stepsOf(gate.jobs.changes).find((step) => /scan-silent-returns/.test(step.run ?? ''));
  assert.equal(silent['continue-on-error'], true);
  // every standalone Rust and script lane checks its receipts
  for (const job of [
    'computer-backend',
    'spawn',
    'patch',
    'graph',
    'secure-desktop',
    'window',
    'mobile-scripts',
    'core-real',
  ])
    assert.ok(
      invocationsOf(gate.jobs[job]).length > 0 &&
        stepsOf(gate.jobs[job]).some((step) => /check-skips\.mjs receipts/.test(step.run ?? '')),
      `${job} has a receipt check`
    );
});

test('Linux root delegates protocol-client fast tests only when the packages job is required', () => {
  const planner = stepsOf(gate.jobs.changes).find((step) => step.id === 'shards');
  const selection = planner.env.PROTOCOL_IN_PACKAGES.slice(4, -3).replaceAll(
    'steps.paths.outputs.',
    'needs.changes.outputs.'
  );
  assert.equal(selection, gate.jobs.packages.if);
  const root = stepsOf(gate.jobs.runtime).find((step) => step.env?.EXCLUDED_PATH);
  const client = stepsOf(gate.jobs.packages).find((step) => step.name === "Run the client's suite");
  assert.equal(root.env.EXCLUDED_PATH, '${{ needs.changes.outputs.runtime_excluded_path }}');
  assert.match(root.run, /--exclude-path "\$EXCLUDED_PATH"/);
  assert.equal(client.run, `npm test -- ${PROTOCOL_CLIENT_TEST_PATH}/`);
});

test('the core inputs cover every path outside native/core that a tracked core source reads', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n')
    .filter(Boolean);
  const readTracked = (path) => (existsSync(new URL(path, ROOT)) ? read(path) : '');
  assert.deepEqual(inputProblems(tracked, readTracked), []);
  // a crate that starts reading a file outside the declared set fails here, by each way the scan resolves a path
  const crate = 'native/core/crates/mixdog-new';
  const sources = {
    [`${crate}/Cargo.toml`]: '',
    [`${crate}/src/lib.rs`]: 'const A: &str = include_str!("../../../../../apps/web/a.txt");',
    [`${crate}/tests/b.rs`]:
      'fn b() { std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../docs/b.md"); }\n' +
      'fn c() { std::path::Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4).unwrap().join("design"); }\n' +
      '#[path = "../../../../../vendor/d.rs"] mod d;\nconst E: &[u8] = mixdog_testkit::fixture_bytes!("../../../../LICENSE");\n' +
      'fn f() { let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4).unwrap(); }',
    // every form an include path takes: concat! of the manifest directory, across lines, cfg_attr(path), a run-time concat!
    [`${crate}/src/catalog.rs`]:
      'const C: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../apps/web/catalog.json"));\n' +
      'const D: &str = include_str!(\n    concat!(\n        env!("CARGO_MANIFEST_DIR"),\n        "/../../../../apps/web/split.json",\n    )\n);\n' +
      '#[cfg_attr(windows, path = "../../../../../apps/web/win.rs")]\nmod w;\n' +
      'fn r() { std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../apps/web/run.bin")).unwrap(); }\n' +
      // an include the scan cannot name is a reach all the same, never none
      'const P: &str = "x";\nconst U: &str = include_str!(P);\n' +
      // a comment and a string name nothing
      '// include_str!("../../../../../apps/web/comment.txt")\nconst S: &str = "include_str!(\\"../../../../../apps/web/string.txt\\")";\n' +
      // every delimiter a macro call takes, and an attribute spread over lines
      'const B: &str = include_str!["../../../../../apps/web/bracket.txt"];\n' +
      'const R: &str = include_str!{ concat![env!("CARGO_MANIFEST_DIR"), "/../../../../apps/web/brace.txt"] };\n' +
      '#[cfg_attr(\n    windows,\n    path = "../../../../../apps/web/spread.rs"\n)]\nmod spread;\n' +
      'const Q: &str = include_bytes![P];\n',
  };
  const problems = inputProblems(Object.keys(sources), (path) => sources[path]);
  for (const wanted of [/reads apps\/web\/a\.txt/, /reads docs\/b\.md/, /tests\/b\.rs:2 reads design,/, /reads vendor\/d\.rs/, /reads LICENSE/, /tests\/b\.rs:5 reaches the repository root/,
    /catalog\.rs:1 reads apps\/web\/catalog\.json/, /catalog\.rs:2 reads apps\/web\/split\.json/, /catalog\.rs:8 reads apps\/web\/win\.rs/,
    /catalog\.rs:10 reads apps\/web\/run\.bin/, /catalog\.rs:12 reaches an include path the scan cannot resolve/,
    /catalog\.rs:15 reads apps\/web\/bracket\.txt/, /catalog\.rs:16 reads apps\/web\/brace\.txt/, /catalog\.rs:17 reads apps\/web\/spread\.rs/,
    /catalog\.rs:22 reaches an include path the scan cannot resolve/])
    assert.ok(problems.some((problem) => wanted.test(problem)), `${wanted} in ${problems.join('; ')}`);
  assert.ok(!problems.some((problem) => /comment\.txt|string\.txt/.test(problem)), problems.join('; '));
  // the daemon's embedded catalogs are a core input
  assert.ok(isCoreInput('apps/desktop/src/shared/native-ui-catalogs.json'));
  // and a reach to the repository root is accepted only with what it reads reviewed, inside the declared set
  assert.ok(isCoreInput('src/runtime/agent/x.json') && isCoreInput('native/core/Cargo.lock') && !isCoreInput('apps/desktop/src/x.ts'));
});

test('release-gate.yml: the core runs on Linux for a push and a pull request, on three systems in the full gate, which every call is', () => {
  assert.equal(gate.on.schedule.length, 1);
  assert.equal(gate.on.workflow_dispatch.inputs.full_gate.type, 'boolean');
  const paths = stepsOf(gate.jobs.changes).find((step) => step.id === 'paths');
  assert.equal(
    paths.env.FULL_GATE,
    "${{ github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.full_gate) }}"
  );
  assert.equal(gate.jobs.changes.outputs.full, "${{ inputs.ref != '' && 'true' || steps.paths.outputs.full }}");
  const core = stepsOf(gate.jobs.changes).find((step) => step.id === 'core');
  assert.equal(core.env.FULL, "${{ inputs.ref != '' || steps.paths.outputs.full == 'true' }}");
  // a push selects the crates as a pull request does; only the full gate builds every crate whatever changed
  assert.match(core.run, /if \[\[ "\$FULL" == true \]\]; then args\+=\(--all\); fi\n/);
  assert.doesNotMatch(core.run, /--push/);
  // a full run requires every job: a skipped macOS or Windows job fails `complete`, so no release passes a Linux-only gate
  assert.equal(runGate('false', 'skipped'), true);
  const script = stepsOf(gate.jobs.complete)[0].run;
  assert.match(script, /if \[\[ "\$FULL" == true \|\| "\$2" == true \]\]; then\s+\[\[ "\$3" == success \]\]/);
  for (const job of ['core-build-macos', 'core-build-windows', 'core-tests-macos', 'core-tests-windows', 'core-real', 'core-lint'])
    assert.match(script, new RegExp(`gate ${job} `), job);
});

test('release-gate.yml: a program of unchanged inputs is taken from a store keyed by them and built only on a miss', () => {
  const outputs = gate.jobs.changes.outputs;
  for (const [job, store, keyed, builds] of [
    ['mixdogd-linux', 'store_key_mixdogd_dev', /^mixdogd-dev-\$\{\{ matrix\.os \}\}-/, /Build the mixdogd the desktop replays drive/],
    ['mixdogd-windows', 'store_key_mixdogd_dev', /^mixdogd-dev-\$\{\{ matrix\.os \}\}-/, /Build the mixdogd the desktop replays drive/],
    ['core-real', 'store_key_mixdogd', /^mixdogd-release-\$\{\{ matrix\.os \}\}-.*'shipping' \|\| 'nolto'/, /Build mixdogd as it ships/],
    ['relay-rust', 'store_key_relay', /^relay-release-linux-/, /Build the relay/],
  ]) {
    assert.equal(outputs[store], `\${{ steps.core.outputs.${store} }}`, store);
    const steps = stepsOf(gate.jobs[job]);
    const restore = steps.findIndex((step) => step.id === 'store');
    assert.ok(steps[restore].uses.startsWith('actions/cache/restore@'), job);
    assert.match(steps[restore].with.key, keyed, job);
    assert.ok(steps[restore].with.key.endsWith(`\${{ needs.changes.outputs.${store} }}`), job);
    // the store is read before any compile, and every compile of the program waits for a miss
    const compiles = steps.filter((step) => builds.test(step.name ?? ''));
    assert.ok(compiles.length > 0, job);
    for (const step of compiles) {
      assert.ok(steps.indexOf(step) > restore, `${job}: ${step.name}`);
      assert.match(step.if, /steps\.store\.outputs\.cache-hit != 'true'/, `${job}: ${step.name}`);
    }
    const save = steps.find((step) => step.uses?.startsWith('actions/cache/save@') && step.with.key === '${{ steps.store.outputs.cache-primary-key }}');
    assert.match(save.if, /steps\.store\.outputs\.cache-hit != 'true'/, job);
    assert.equal(save.with.path, steps[restore].with.path, job);
  }
  // the dependency entry is written by a build of every crate only, never by a push's selection
  for (const step of stepsOf(gate.jobs['core-build-linux']).filter((s) => /in the cache|Save the compiled dependencies/.test(s.name ?? '')))
    assert.match(step.if, /needs\.changes\.outputs\.core_scope == 'all'/, step.name);
});

test('release-gate.yml: the core builds compile the workspace crates with the parallel front end, through a wrapper of their own', () => {
  const steps = stepsOf(gate.jobs['core-build-linux']);
  const wrapper = steps.findIndex((step) => step.uses === './.github/actions/rustc-threads');
  const toolchain = steps.findIndex((step) => step.uses?.startsWith('dtolnay/rust-toolchain@'));
  const compile = steps.findIndex((step) => /cargo nextest archive/.test(step.run ?? ''));
  assert.ok(toolchain < wrapper && wrapper < compile && steps[wrapper].if === undefined);
  // the test archive alone: no program a job boots or a release ships goes through it, in this gate or any other workflow
  for (const [name, job] of Object.entries(gate.jobs))
    if (!/^core-build-/.test(name)) assert.doesNotMatch(JSON.stringify(job), /rustc-threads|RUSTC_WORKSPACE_WRAPPER|RUSTC_BOOTSTRAP/, name);
  for (const file of readdirSync(new URL('.github/workflows/', ROOT)).filter((name) => name !== 'release-gate.yml'))
    assert.doesNotMatch(read(`.github/workflows/${file}`), /rustc-threads|RUSTC_BOOTSTRAP/, file);
  // every run that builds an archive compiles the same selection on plain stable, on each system the archive is for
  const lint = gate.jobs['core-lint'];
  assert.equal(lint.if, gate.jobs['core-build-linux'].if.replace('core_build', 'core'));
  assert.equal(lint.strategy.matrix, '${{ fromJSON(needs.changes.outputs.lint_matrix) }}');
  const plain = stepsOf(lint).find((step) => step.name === "Compile the archive's crates on plain stable");
  assert.match(plain.run, /cargo check --manifest-path Cargo\.toml --locked --all-targets \$ARCHIVE_ARGS "\$\{features\[@\]\}"/);
  // the one selection `changes` resolved, which the archive builds too
  const archive = steps[compile];
  for (const env of [plain.env, archive.env])
    assert.deepEqual(env, {
      ARCHIVE_ARGS: '${{ needs.changes.outputs.core_build_args }}',
      FEATURES: '${{ needs.changes.outputs.core_build_features }}',
    });
  assert.equal(plain.if, undefined);
  // clippy lints the daemon only when the selection holds it
  const clippy = stepsOf(lint).find((step) => step.name === 'Clippy');
  assert.equal(clippy.if, "needs.changes.outputs.core_daemon == 'true'");
  assert.equal(gate.jobs.changes.outputs.core_daemon, "${{ steps.core.outputs.core_daemon || 'false' }}");
  const action = parse(read('.github/actions/rustc-threads/action.yml'));
  assert.match(action.runs.steps[0].run, /RUSTC_WORKSPACE_WRAPPER=/);
  assert.doesNotMatch(JSON.stringify(action), /RUSTC_BOOTSTRAP|RUSTFLAGS/, 'no flag or bootstrap for the whole build');
  // the unstable flag and RUSTC_BOOTSTRAP go to the one compiler process, never to a build script's probe
  const source = read('scripts/ci/rustc-threads.rs');
  assert.match(source, /\.arg\(format!\("-Zthreads=\{threads\}"\)\)\.env\("RUSTC_BOOTSTRAP", "1"\)/);
  assert.match(source, /env::var_os\("CARGO_CFG_TARGET_OS"\)\.is_some\(\)/);
  assert.match(source, /if code == 101 \{/);
});

test('release-gate.yml: a push selects against the last commit the gate passed on, and a rename by both of its paths', () => {
  const paths = stepsOf(gate.jobs.changes).find((step) => step.id === 'paths');
  assert.deepEqual(gate.jobs.changes.permissions, { contents: 'read', actions: 'read' });
  assert.equal(paths.env.GH_TOKEN, '${{ github.token }}');
  assert.match(
    paths.run,
    /if \[\[ "\$EVENT_NAME" == push \]\]; then\s+BASE=\$\(gh api "repos\/\$GITHUB_REPOSITORY\/actions\/workflows\/release-gate\.yml\/runs\?branch=\$BRANCH&status=success/
  );
  // no answer is no base, which selects every file
  assert.match(paths.run, /\|\| BASE=""/);
  const changed = [];
  selected([], { renames: [['native/core/crates/a/tests/moved.rs', 'native/core/crates/b/tests/moved.rs']], changedOut: changed });
  assert.deepEqual(changed.sort(), ['native/core/crates/a/tests/moved.rs', 'native/core/crates/b/tests/moved.rs']);
});

test('release-gate.yml: the format check is selected by the files it formats, the standalone tools included', () => {
  for (const path of ['native/mixdog-browser-import/src/main.rs', 'native/mixdog-window/src/lib.rs', 'native/rustfmt.toml'])
    assert.ok(selected([path]).includes('rustfmt'), path);
  assert.ok(!selected(['docs/notes.md']).includes('rustfmt'));
  assert.equal(gate.jobs.rustfmt.if, "needs.changes.outputs.rustfmt == 'true'");
  // on a push too it follows its files (not `flag`, which turns on every other lane for a push); a full run runs it
  const paths = stepsOf(gate.jobs.changes).find((step) => step.id === 'paths');
  assert.doesNotMatch(paths.run, /flag rustfmt /);
  assert.match(paths.run, /if grep -Eq "\$RUSTFMT_RE" \/tmp\/changed; then echo "rustfmt=true"/);
  assert.equal(
    gate.jobs.changes.outputs.rustfmt,
    "${{ (inputs.ref != '' || steps.paths.outputs.full == 'true') && 'true' || steps.paths.outputs.rustfmt }}"
  );
  assert.match(runOf(gate.jobs.rustfmt), /rustfmt --check --edition 2021 native\/mixdog-browser-import\/src\/main\.rs/);
  assert.doesNotMatch(runOf(gate.jobs['core-lint']), /cargo fmt|rustfmt --check/);
});

test('release-gate.yml: every full run boots the shipping profile, and the source inventory runs on every run', () => {
  assert.equal(gate.jobs['core-real'].env.SHIPPING, "${{ inputs.ref != '' || needs.changes.outputs.full == 'true' }}");
  assert.equal(gate.jobs.inventory.if, "needs.changes.outputs.source_inventory == 'true'");
  assert.equal(gate.jobs.changes.outputs.source_inventory, "${{ steps.paths.outputs.release_commit != 'true' }}");
});

test('release-gate.yml: the doctests are a leg of their own beside the build, not a step of a test partition', () => {
  const doc = gate.jobs['core-doctests'];
  assert.deepEqual(needsOf(doc), ['changes']);
  assert.equal(doc.if, "needs.changes.outputs.core_doctests != '[]'");
  for (const pkg of ['mixdog-core-api', 'mixdog-image-egress'])
    assert.ok(
      stepsOf(doc).some((step) => step.if === `contains(fromJSON(needs.changes.outputs.core_doctests), '${pkg}')`),
      `${pkg} runs when the selection holds it`
    );
  assert.equal(doc.env.MIXDOG_LEG, 'linux/core-doctests/1of1');
  const runs = stepsOf(doc).map((step) => step.run ?? '').join('\n');
  for (const pkg of ['mixdog-core-api', 'mixdog-image-egress']) assert.match(runs, new RegExp(`run-doctest\\.mjs -p ${pkg} `));
  assert.doesNotMatch(JSON.stringify(gate.jobs['core-tests-linux']), /run-doctest/);
  assert.match(stepsOf(gate.jobs.complete)[0].run, /gate core-doctests "\$SEL_CORE_DOCTESTS" "\$CORE_DOCTESTS"/);
});

test('release-gate.yml: `changes` resolves a partial selection against the whole build once, with core-align.mjs', () => {
  const steps = stepsOf(gate.jobs.changes);
  const align = steps.find((step) => step.id === 'align');
  assert.ok(steps.indexOf(align) > steps.findIndex((step) => step.id === 'core'));
  // a whole selection passes; a partial one is widened
  assert.match(align.run, /if \[\[ "\$SCOPE" != packages \]\]; then\s+printf 'packages=%s\\nfeatures=%s\\n' "\$SELECTION" "\$FEATURES"/);
  // the indented tree, which tells host builds from target builds, and rounds to a fixed point rather than a count
  assert.match(align.run, /cargo tree --locked --charset utf8 -f '\{p\} \{f\}' --workspace/);
  assert.doesNotMatch(align.run, /--prefix none|\$round/);
  assert.match(align.run, /while true; do/);
  assert.match(align.run, /if \[\[ "\$packages\|\$selection_features" == "\$last" \]\]; then[\s\S]*?exit 1/);
  assert.match(align.run, /if node \.\.\/\.\.\/scripts\/ci\/core-align\.mjs check --whole "\$RUNNER_TEMP\/tree-whole\.txt" --tree "\$RUNNER_TEMP\/tree-selection\.txt"; then break; fi/);
  assert.equal(gate.jobs.changes.outputs.core_build_args, '${{ steps.align.outputs.packages }}');
  assert.equal(gate.jobs.changes.outputs.core_build_features, '${{ steps.align.outputs.features }}');
  // no job builds part of an archive or merges one
  for (const name of Object.keys(gate.jobs)) assert.doesNotMatch(name, /merge|half/, name);
});
