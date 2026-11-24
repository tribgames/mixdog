import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { parse } from 'yaml';

import { coreBase, coreProven, OTHER_LANES, stemOf } from './core-base.mjs';

const REPO = 'tribgames/mixdog';
const run = (id, conclusion, extra = {}) => ({
  id,
  head_sha: `sha-${id}`,
  status: 'completed',
  conclusion,
  event: 'push',
  head_repository: { full_name: REPO },
  ...extra,
});
const job = (name, conclusion = 'success') => ({ name, conclusion });
// the core's jobs of a push as the API names them: matrix entries expanded, an empty matrix under its template name
const CORE = [
  job('changes'),
  job('core-build (linux) (linux, ubuntu-22.04)'),
  job('core-build (${{ matrix.os }})', 'skipped'),
  job('mixdogd (linux)'),
  job('core-tests (linux 1/4)'),
  job('core-tests (linux 2/4)'),
  job('core-list (linux)'),
  job('core-pg (linux pg)'),
  job('core-entry'),
  job('core-lint (linux)'),
  job('core-doctests'),
];

test('a run that failed in another lane proved the core at its head; one whose core failed did not', () => {
  // run 45064159113: relay-rust failed, and complete with it; every core job passed
  const relay = [...CORE, job('relay-rust', 'failure'), job('complete', 'failure'), job('core-real')];
  assert.equal(coreProven(relay), true);
  for (const failed of [
    'core-tests (linux 2/4)',
    'core-build (linux) (linux, ubuntu-22.04)',
    'mixdogd (linux)',
    'changes',
  ])
    for (const conclusion of ['failure', 'cancelled'])
      assert.equal(
        coreProven(relay.map((entry) => (entry.name === failed ? job(failed, conclusion) : entry))),
        false,
        `${failed} ${conclusion}`
      );
  // a job the list does not name counts as the core's, so a new or renamed one that fails is never passed over
  assert.equal(coreProven([...relay, job('rust-tests (linux 1/2)', 'failure')]), false);
  assert.equal(coreProven(relay.filter((entry) => entry.name !== 'changes')), false);
});

test('the base is the newest completed push run that proved the core, never a pull request, a fork or a cancelled run', () => {
  const jobs = {
    2: [...CORE, job('relay-rust', 'failure')],
    3: CORE.map((entry) => (entry.name === 'core-lint (linux)' ? job(entry.name, 'failure') : entry)),
  };
  const read = [];
  const jobsOf = (id) => {
    read.push(id);
    return jobs[id] ?? null;
  };
  const runs = [
    run(7, 'cancelled'),
    run(6, 'failure', { event: 'pull_request' }),
    run(5, 'failure', { head_repository: { full_name: 'someone/fork' } }),
    run(4, 'failure'),
    run(3, 'failure'),
    run(2, 'failure'),
    run(1, 'success'),
  ];
  assert.equal(coreBase({ runs, repository: REPO, jobsOf }), 'sha-2');
  // jobs not all known (null) and a core failure are passed over; only failed runs are read
  assert.deepEqual(read, [4, 3, 2]);
  assert.equal(coreBase({ runs: runs.filter((entry) => entry.id !== 2), repository: REPO, jobsOf }), 'sha-1');
  assert.equal(coreBase({ runs: [run(9, 'success', { status: 'in_progress' })], repository: REPO, jobsOf }), '');
  // a bounded number of failed runs is read before giving up
  assert.equal(
    coreBase({ runs: [run(4, 'failure'), run(3, 'failure'), run(2, 'failure')], repository: REPO, jobsOf, limit: 2 }),
    ''
  );
});

const gate = parse(readFileSync(new URL('../../.github/workflows/release-gate.yml', import.meta.url), 'utf8'));
const bash =
  process.platform === 'win32' ? `${process.env.ProgramFiles || 'C:/Program Files'}/Git/bin/bash.exe` : 'bash';

test("release-gate.yml: a push selects the core's crates against the core's base and every other lane against the gate's", () => {
  const script = gate.jobs.changes.steps.find((step) => step.id === 'paths').run;
  const dir = mkdtempSync(join(tmpdir(), 'core-base-'));
  const slash = (path) => path.replaceAll('\\', '/');
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args],
      {
        cwd: dir,
        encoding: 'utf8',
      }
    );
  const commit = (path) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), path);
    git('add', '.');
    git('commit', '-q', '-m', path);
    return git('rev-parse', 'HEAD').trim();
  };
  try {
    git('init', '-q');
    // the step fetches its bases by SHA from origin, here the repository itself
    git('config', 'uploadpack.allowAnySHA1InWant', 'true');
    git('remote', 'add', 'origin', slash(dir));
    const passed = commit('base.txt');
    // the run of this commit failed in another lane, with every core job green
    const coreBase = commit('native/core/crates/a/src/lib.rs');
    const head = commit('apps/desktop/src/renderer/a.tsx');
    // the step's two queries: the last run the gate passed (gh) and the core's base (core-base.mjs)
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho ${passed}\n`, { mode: 0o755 });
    mkdirSync(join(dir, 'scripts/ci'), { recursive: true });
    writeFileSync(join(dir, 'scripts/ci/core-base.mjs'), `console.log(${JSON.stringify(coreBase)});\n`);
    writeFileSync(join(dir, 'paths.sh'), script.replaceAll('/tmp/', `${slash(dir)}/`));
    writeFileSync(join(dir, 'github-output'), '');
    const runPaths = () =>
      execFileSync(bash, [slash(join(dir, 'paths.sh'))], {
        cwd: dir,
        stdio: 'pipe',
        env: {
          ...process.env,
          PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
          EVENT_NAME: 'push',
          FULL_GATE: 'false',
          PR_BASE: '',
          PUSH_BASE: '',
          HEAD_MESSAGE: '',
          ACTOR: 'someone',
          BRANCH: 'main',
          GITHUB_REPOSITORY: 'o/r',
          GITHUB_SHA: head,
          GITHUB_OUTPUT: slash(join(dir, 'github-output')),
        },
      });
    runPaths();
    const lines = (name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).sort();
    assert.deepEqual(lines('changed'), ['apps/desktop/src/renderer/a.tsx', 'native/core/crates/a/src/lib.rs']);
    assert.deepEqual(lines('changed-core'), ['apps/desktop/src/renderer/a.tsx']);
    // no core base (no answer, or a failed query) leaves the core the gate's list
    writeFileSync(join(dir, 'scripts/ci/core-base.mjs'), 'process.exit(1);\n');
    runPaths();
    assert.deepEqual(lines('changed-core'), lines('changed'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release-gate.yml: every job core-select.mjs selects is checked, and so is every job it needs', () => {
  const stem = (key) => stemOf(gate.jobs[key].name ?? key);
  const stems = new Set(Object.keys(gate.jobs).map(stem));
  for (const name of OTHER_LANES) assert.ok(stems.has(name), `${name} is no job of the gate`);
  // the outputs of the core's selection (steps `core` and `align` of changes)
  const coreOutputs = Object.entries(gate.jobs.changes.outputs)
    .filter(([, expression]) => /steps\.(core|align)\.outputs\./.test(expression))
    .map(([name]) => name);
  for (const [key, job] of Object.entries(gate.jobs)) {
    if (!OTHER_LANES.has(stem(key))) {
      for (const need of [job.needs ?? []].flat())
        assert.ok(!OTHER_LANES.has(stem(need)), `${key} needs ${need}, whose result the base does not check`);
      continue;
    }
    const reads = coreOutputs.filter((name) =>
      new RegExp(`needs\\.changes\\.outputs\\.${name}(?!\\w)`).test(String(job.if ?? ''))
    );
    if (key === 'core-real') continue;
    assert.deepEqual(reads, [], `${key} is selected by the core's selection, so its result must be checked`);
  }
  // core-real reads `core`, and on a push runs whatever it says: `core_scripts` is on for every push (`flag`)
  assert.match(
    gate.jobs['core-real'].if,
    /github\.event_name != 'pull_request' && \(needs\.changes\.outputs\.core == 'true' \|\| needs\.changes\.outputs\.core_scripts == 'true'\)/
  );
  const paths = gate.jobs.changes.steps.find((step) => step.id === 'paths').run;
  assert.match(paths, /flag core_scripts "\$CORE_SCRIPTS_RE"/);
  assert.match(paths, /if \[\[ "\$EVENT_NAME" != pull_request \]\]; then echo "\$1=true"/);
  // the core's selection reads the list selected against that base, and a push alone asks for it
  const core = gate.jobs.changes.steps.find((step) => step.id === 'core').run;
  assert.match(core, /--changed \/tmp\/changed-core /);
  assert.match(
    paths,
    /cp \/tmp\/changed \/tmp\/changed-core\nif \[\[ "\$EVENT_NAME" == push \]\]; then\n\s+CORE_BASE=\$\(node scripts\/ci\/core-base\.mjs --repository "\$GITHUB_REPOSITORY" --branch "\$BRANCH"\) \|\| CORE_BASE=""/
  );
});
