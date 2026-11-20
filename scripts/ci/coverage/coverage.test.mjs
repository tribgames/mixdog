import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { contentHash, makeRecord, integrityProblems, EVIDENCE_VERSION } from './evidence.mjs';
import { artifactName, artifactTemplate, loadRustLists } from './artifacts.mjs';
import { releaseState, stageDraft } from '../release-state.mjs';
import { exceptionProblems } from './exceptions.mjs';
import { idKey } from './ids.mjs';
import { buildInventory } from './inventory.mjs';
import { loadPlan, planProblems } from './plan.mjs';
import { reconcile, reconcileJoin } from './reconcile.mjs';
import { loadWorkflows, matrixSize, wiringProblems } from './wiring.mjs';
import { parseJunit, targetOfBinaryId, junitRecords } from './adapters.mjs';
import { invocationRecords, runIgnoredMode } from '../run-nextest.mjs';
import { shellRecords } from '../run-shell-suite.mjs';
import { doctestRecords } from '../run-doctest.mjs';
import { parseToml } from './toml-lite.mjs';
import { receiptsProblems } from '../check-skips.mjs';

const SHA = 'f'.repeat(40);
const RUN = {
  sha: SHA,
  runId: '7',
  attempt: '1',
  repository: 'o/r',
  workflow: 'o/r/.github/workflows/deploy.yml@refs/heads/main',
};
// a spawned runner reads the commit from the git repository it starts in, never from the environment it inherits
const CLEAN_ENV = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(?:GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|NODE_TEST_CONTEXT)$/.test(key)
    )
  );
function gitRepo(dir) {
  const git = (...args) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: CLEAN_ENV(),
    });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'x');
  return { git, head: git('rev-parse', 'HEAD').stdout.trim() };
}
const OWNER = 'team';
const PY_RUNNER = fileURLToPath(new URL('./py-runner.py', import.meta.url));
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

// ---- a small reviewed plan, written the way the real one is: legs, slots, routes, one Rust workspace, one Python route
const clause = (...legs) => ({ anyOf: legs });
const slot = (id, producer = 'node', parent) => (parent === undefined ? { id, producer } : { id, producer, parent });
function makePlan(extra = {}) {
  return {
    v: 1,
    owners: { classifier: OWNER, routing: OWNER, exceptions: OWNER },
    legs: [
      { id: 'linux/node/1of1', os: 'linux', workflow: 'release-gate.yml', job: 'node', slots: [slot('root')] },
      { id: 'windows/node/1of1', os: 'windows', workflow: 'release-gate.yml', job: 'node', slots: [slot('root')] },
      {
        id: 'linux/parent/1of1',
        os: 'linux',
        workflow: 'release-gate.yml',
        job: 'parent',
        slots: [slot('root'), slot('child:src/child.test.mjs', 'node', 'root'), slot('other')],
      },
      { id: 'linux/py/1of1', os: 'linux', workflow: 'release-gate.yml', job: 'py', slots: [slot('root', 'unittest')] },
      {
        id: 'linux/core/1of2',
        os: 'linux',
        workflow: 'release-gate.yml',
        job: 'core',
        slots: [slot('root', 'nextest')],
      },
      {
        id: 'linux/core/2of2',
        os: 'linux',
        workflow: 'release-gate.yml',
        job: 'core',
        slots: [slot('root', 'nextest')],
      },
      {
        id: 'linux/core-pg/pg',
        os: 'linux',
        workflow: 'release-gate.yml',
        job: 'core-pg',
        slots: [slot('root', 'nextest')],
      },
      {
        id: 'windows/core/1of1',
        os: 'windows',
        workflow: 'release-gate.yml',
        job: 'core-win',
        slots: [slot('root', 'nextest')],
      },
    ],
    joinLegs: [
      {
        id: 'windows/package/1of1',
        os: 'windows',
        workflow: 'package.yml',
        job: 'package',
        caller: 'release.yml#package-windows',
        slots: [slot('prepared')],
      },
    ],
    routes: [
      {
        name: 'node',
        family: 'node',
        owner: OWNER,
        include: ['src/**/*.test.mjs'],
        exclude: ['src/child.test.mjs', 'src/parent.test.mjs'],
        requires: [clause('linux/node/1of1'), clause('windows/node/1of1')],
      },
      {
        name: 'parent',
        family: 'node',
        owner: OWNER,
        include: ['src/parent.test.mjs'],
        requires: [clause('linux/parent/1of1#root')],
      },
      {
        name: 'child',
        family: 'node',
        owner: OWNER,
        include: ['src/child.test.mjs'],
        requires: [clause('linux/parent/1of1#child:src/child.test.mjs')],
      },
      { name: 'py', family: 'python', owner: OWNER, include: ['py/test_*.py'], requires: [clause('linux/py/1of1')] },
    ],
    classes: [{ glob: 'src/fixtures/**', class: 'fixture', reason: 'data the tests read', owner: OWNER }],
    rust: {
      workspace: '',
      variants: [
        {
          name: 'linux',
          os: 'linux',
          listLeg: 'linux/core/1of2',
          testLegs: ['linux/core/1of2', 'linux/core/2of2'],
          profileLegs: { pg: ['linux/core-pg/pg'] },
        },
        {
          name: 'windows',
          os: 'windows',
          listLeg: 'windows/core/1of1',
          testLegs: ['windows/core/1of1'],
          profileLegs: {},
        },
      ],
      standalone: [],
    },
    ...extra,
  };
}

// a workspace of one crate with a lib and no test, so that every world has a Rust target to list
const BASE_RUST = {
  'Cargo.toml': '[workspace]\nmembers = ["crates/p"]\n',
  'crates/p/Cargo.toml': '[package]\nname = "p"\nversion = "0.1.0"\n',
  'crates/p/src/lib.rs': '',
};
function world(given, plan = makePlan()) {
  const files = given['Cargo.toml'] ? given : { ...BASE_RUST, ...given };
  const tracked = Object.keys(files).sort();
  const { manifest, errors } = buildInventory({ root: '.', tracked, plan, sha: SHA, read: (path) => files[path] });
  return { manifest, errors, plan, files, tracked };
}

const NODE_FILE = `import test, { describe, it } from 'node:test';
describe('outer', () => { it('a', () => {}); it('b', () => {}); });
test('top', () => {});
`;

/** A receipt as a runner leaves it; `parent` is the receipt (as returned here) whose children folder holds it. */
function receiptOf(
  plan,
  leg,
  slotId,
  records,
  { platform, exit = 0, run = RUN, complete = true, parent = null, producer } = {}
) {
  const entry = [...plan.legs, ...(plan.joinLegs ?? [])].find((candidate) => candidate.id === leg);
  const kind = producer ?? entry.slots.find((candidate) => candidate.id === slotId)?.producer ?? 'node';
  const made = records.map((record, seq) => makeRecord(seq, record));
  const id = `${leg}#${slotId}#${Math.random()}`;
  return {
    path: parent ? `${parent.path}.children/${slotId}.json` : `${leg}#${slotId}`,
    parent: parent?.path ?? null,
    receipt: {
      v: EVIDENCE_VERSION,
      id,
      kind,
      platform: platform ?? { linux: 'linux', macos: 'darwin', windows: 'win32' }[entry.os],
      complete,
      exitCode: exit,
      envelope: {
        repository: run.repository,
        sha: run.sha,
        workflow: run.workflow,
        runId: run.runId,
        attempt: run.attempt,
        leg,
        os: entry.os,
        slot: slotId,
        parentSlot: parent ? parent.receipt.envelope.slot : null,
        parentInvocation: parent ? parent.receipt.id : null,
        producer: kind,
      },
      records: made,
      trailer: { recordCount: made.length, contentHash: contentHash(made) },
    },
  };
}

const pass = (id) => ({ kind: 'case', id, status: 'pass' });
const node = (file, ...path) => ['node', file, ...path];
const NODE_PASSES = (file = 'src/a.test.mjs') => [
  pass(node(file, 'outer', 'a')),
  pass(node(file, 'outer', 'b')),
  pass(node(file, 'top')),
];
const NODE_LEGS = (plan, records = NODE_PASSES()) => [
  receiptOf(plan, 'linux/node/1of1', 'root', records),
  receiptOf(plan, 'windows/node/1of1', 'root', records),
];
const PARENT = (plan, records = []) => {
  const parent = receiptOf(plan, 'linux/parent/1of1', 'root', records);
  return [
    parent,
    receiptOf(plan, 'linux/parent/1of1', 'child:src/child.test.mjs', [], { parent }),
    receiptOf(plan, 'linux/parent/1of1', 'other', []),
  ];
};
const REST = (plan) => [
  ...PARENT(plan),
  receiptOf(plan, 'linux/py/1of1', 'root', []),
  receiptOf(plan, 'linux/core/1of2', 'root', []),
  receiptOf(plan, 'linux/core/2of2', 'root', []),
  receiptOf(plan, 'linux/core-pg/pg', 'root', []),
  receiptOf(plan, 'windows/core/1of1', 'root', []),
];
const noExceptions = { v: 1, exceptions: [] };
// the build variants list the crate every world has and none of its tests unless a test says otherwise
const noTests = () => ({ all: listOf({ p: [] }), profiles: {} });
const run = (input) =>
  reconcile({
    context: RUN,
    exceptions: noExceptions,
    rustLists: { linux: noTests(), windows: noTests() },
    byName: PACKAGES,
    ...input,
  });
const baseline = () => {
  const w = world({ 'src/a.test.mjs': NODE_FILE });
  assert.deepEqual(w.errors, []);
  return { ...w, receipts: [...NODE_LEGS(w.plan), ...REST(w.plan)] };
};

test('baseline: a complete, intact run of every declared leg covers the inventory', () => {
  const { manifest, plan, receipts } = baseline();
  assert.deepEqual(
    manifest.units.map((unit) => unit.id),
    [
      ['node', 'src/a.test.mjs'],
      ['rust', 'crates/p/Cargo.toml', 'lib', 'p'],
    ]
  );
  assert.deepEqual(run({ manifest, plan, receipts }), []);
});

test('a partial rerun reuses successful legs from the same run, without mixing attempts inside a leg', () => {
  const { manifest, plan, receipts } = baseline();
  const context = { ...RUN, attempt: '2', allowReused: true };
  const mixed = receipts.map((entry) =>
    entry.receipt.envelope.leg === 'linux/node/1of1'
      ? { ...entry, receipt: { ...entry.receipt, envelope: { ...entry.receipt.envelope, attempt: '2' } } }
      : entry
  );
  assert.deepEqual(run({ manifest, plan, receipts: mixed, context }), []);
  const split = mixed.map((entry) =>
    entry.receipt.envelope.parentSlot
      ? { ...entry, receipt: { ...entry.receipt, envelope: { ...entry.receipt.envelope, attempt: '2' } } }
      : entry
  );
  assert.match(run({ manifest, plan, receipts: split, context }).join('\n'), /mixes producer attempts/);
});

// ---- the adversarial cases (docs/testing.md, "Release coverage": each changes one fact of the baseline and fails closed)

test('1. a skipped suite has no exception form, and a skipped case needs its exact tuple', () => {
  const { manifest, plan } = baseline();
  const suite = {
    kind: 'suite',
    id: ['node-suite', 'src/a.test.mjs', 'outer'],
    status: 'skip',
    reasonCode: 'uncoded',
    reasonText: 'no display',
  };
  const receipts = [...NODE_LEGS(plan, [suite, pass(node('src/a.test.mjs', 'top'))]), ...REST(plan)];
  const problems = run({ manifest, plan, receipts });
  assert.equal(
    problems.filter((text) => text.startsWith('unexcepted skip') && text.includes('node-suite')).length,
    2,
    problems.join('\n')
  );
  // a suite is not excepted, whatever its tuple says
  assert.match(
    exceptionProblems({
      v: 1,
      exceptions: [
        {
          id: ['node-suite', 'src/a.test.mjs', 'outer'],
          platform: 'linux',
          kind: 'skip',
          reasonCode: 'uncoded',
          reasonText: 'x',
          owner: OWNER,
          reason: 'r',
          replacement: { kind: 'none', reason: 'x' },
        },
      ],
    }).join('\n'),
    /suites are not excepted/
  );
});

test('3. a parent that passes while its declared child slot never launched is a missing slot, even if the names pass elsewhere', () => {
  const { manifest, plan, receipts } = baseline();
  const without = receipts.filter((entry) => entry.receipt.envelope.slot !== 'child:src/child.test.mjs');
  const problems = run({ manifest, plan, receipts: without });
  assert.deepEqual(
    problems.filter((text) => text.startsWith('missing')),
    ['missing: no receipt for leg linux/parent/1of1 slot child:src/child.test.mjs (release-gate.yml job parent)']
  );
});

test('a child slot is credited only from the invocation of its declared parent slot, never from itself, a sibling or a top-level run', () => {
  const { manifest, plan, receipts } = baseline();
  const [root, , other] = PARENT(plan);
  const withChild = (child) =>
    receipts.filter((entry) => entry.receipt.envelope.slot !== 'child:src/child.test.mjs').concat([child]);
  const wrongParent = /must be launched by its parent slot root|was not left in a children folder|top-level slot/;
  // launched by the sibling slot `other`, not by `root`
  assert.match(
    run({
      manifest,
      plan,
      receipts: withChild(receiptOf(plan, 'linux/parent/1of1', 'child:src/child.test.mjs', [], { parent: other })),
    }).join('\n'),
    wrongParent
  );
  // a top-level receipt that claims the child slot
  assert.match(
    run({
      manifest,
      plan,
      receipts: withChild(receiptOf(plan, 'linux/parent/1of1', 'child:src/child.test.mjs', [])),
    }).join('\n'),
    wrongParent
  );
  // found under root's folder but naming another invocation as its parent
  const forged = receiptOf(plan, 'linux/parent/1of1', 'child:src/child.test.mjs', [], { parent: root });
  forged.receipt.envelope.parentInvocation = 'someone-else';
  assert.match(run({ manifest, plan, receipts: withChild(forged) }).join('\n'), wrongParent);
  // a top-level slot left by a child invocation
  const nested = receiptOf(plan, 'linux/parent/1of1', 'other', [], { parent: root });
  assert.match(
    run({
      manifest,
      plan,
      receipts: receipts.filter((entry) => entry.receipt.envelope.slot !== 'other').concat([nested]),
    }).join('\n'),
    /top-level slot/
  );
  // and the plan cannot declare a slot its own parent, or a parent it does not have
  const selfParent = makePlan();
  selfParent.legs[2].slots[1].parent = 'child:src/child.test.mjs';
  assert.match(planProblems(selfParent).join('\n'), /names itself as its parent/);
  const ghostParent = makePlan();
  ghostParent.legs[2].slots[1].parent = 'nowhere';
  assert.match(planProblems(ghostParent).join('\n'), /names the parent nowhere/);
});

test('routing credits the slot a clause names: the same case passing in another slot of the same leg is wrong-slot and the clause is missing', () => {
  const w = world({ 'src/parent.test.mjs': NODE_FILE, 'src/child.test.mjs': NODE_FILE });
  assert.deepEqual(w.errors, []);
  const childCases = NODE_PASSES('src/child.test.mjs');
  const right = (() => {
    const root = receiptOf(w.plan, 'linux/parent/1of1', 'root', NODE_PASSES('src/parent.test.mjs'));
    return [
      root,
      receiptOf(w.plan, 'linux/parent/1of1', 'child:src/child.test.mjs', childCases, { parent: root }),
      receiptOf(w.plan, 'linux/parent/1of1', 'other', []),
    ];
  })();
  const rest = (receipts) => [
    ...NODE_LEGS(w.plan, []),
    ...receipts,
    ...REST(w.plan).filter((entry) => entry.receipt.envelope.leg !== 'linux/parent/1of1'),
  ];
  assert.deepEqual(run({ manifest: w.manifest, plan: w.plan, receipts: rest(right) }), []);
  // the child's cases reported by the parent's own invocation (the child never launched as its slot)
  const root = receiptOf(w.plan, 'linux/parent/1of1', 'root', [...NODE_PASSES('src/parent.test.mjs'), ...childCases]);
  const wrong = [
    root,
    receiptOf(w.plan, 'linux/parent/1of1', 'child:src/child.test.mjs', [], { parent: root }),
    receiptOf(w.plan, 'linux/parent/1of1', 'other', []),
  ];
  const problems = run({ manifest: w.manifest, plan: w.plan, receipts: rest(wrong) });
  assert.ok(
    problems.some(
      (text) => text.startsWith('wrong leg:') && text.includes('src/child.test.mjs') && text.includes('slot root')
    ),
    problems.join('\n')
  );
  assert.ok(
    problems.some(
      (text) =>
        text.startsWith('no-cases:') &&
        text.includes('src/child.test.mjs') &&
        text.includes('#child:src/child.test.mjs')
    ),
    problems.join('\n')
  );
  // a leg with several slots cannot be named without one
  assert.match(
    planProblems(
      makePlan({
        routes: [{ name: 'r', family: 'node', owner: OWNER, include: ['x'], requires: [clause('linux/parent/1of1')] }],
      })
    ).join('\n'),
    /name one/
  );
});

test("provenance: repository, workflow and producer are required, must be the trusted ones, and the commit is the checkout's own", () => {
  const { manifest, plan, receipts } = baseline();
  const swap = (mutate) =>
    receipts.map((entry) => {
      if (entry.receipt.envelope.leg !== 'linux/node/1of1') return entry;
      const copy = structuredClone(entry);
      mutate(copy.receipt);
      return copy;
    });
  for (const field of ['repository', 'workflow', 'producer'])
    assert.match(
      run({ manifest, plan, receipts: swap((receipt) => delete receipt.envelope[field]) }).join('\n'),
      new RegExp(`envelope has no ${field}`),
      field
    );
  assert.match(
    run({
      manifest,
      plan,
      receipts: swap((receipt) => {
        receipt.envelope.repository = 'fork/r';
      }),
    }).join('\n'),
    /repository fork\/r, not o\/r/
  );
  assert.match(
    run({
      manifest,
      plan,
      receipts: swap((receipt) => {
        receipt.envelope.workflow = 'o/r/.github/workflows/other.yml@refs/heads/x';
      }),
    }).join('\n'),
    /produced by the workflow/
  );
  assert.match(
    run({
      manifest,
      plan,
      receipts: swap((receipt) => {
        receipt.kind = 'nextest';
        receipt.envelope.producer = 'nextest';
      }),
    }).join('\n'),
    /is not a rust identity/
  );
  assert.match(
    run({
      manifest,
      plan,
      receipts: swap((receipt) => {
        receipt.envelope.producer = 'nextest';
      }),
    }).join('\n'),
    /written by a node runner but its envelope names the producer nextest/
  );
  // a runner records the commit of the repository it runs in; a variable that claims another commit is not read
  const dir = mkdtempSync(join(tmpdir(), 'sha-'));
  try {
    const { head } = gitRepo(dir);
    const out = join(dir, 'r.json');
    const script = `import { beginReceipt } from ${JSON.stringify(new URL('../receipt.mjs', import.meta.url).href)};\nbeginReceipt(${JSON.stringify(out)}, 'node');\n`;
    writeFileSync(join(dir, 'begin.mjs'), script);
    const result = spawnSync(process.execPath, [join(dir, 'begin.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...CLEAN_ENV(), MIXDOG_EVIDENCE_SHA: SHA },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).envelope.sha, head);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('4. a file whose leg ran no case fails, and a tracked test file no route assigns is an inventory error', () => {
  const { manifest, plan } = baseline();
  const nothing = run({ manifest, plan, receipts: [...NODE_LEGS(plan, []), ...REST(plan)] });
  assert.equal(nothing.filter((text) => text.startsWith('no-cases')).length, 2, nothing.join('\n'));
  // every report of the file on its legs is a skip with no exception
  const skip = {
    kind: 'case',
    id: node('src/a.test.mjs', 'top'),
    status: 'skip',
    reasonCode: 'uncoded',
    reasonText: 'x',
  };
  const onlySkips = run({ manifest, plan, receipts: [...NODE_LEGS(plan, [skip]), ...REST(plan)] });
  assert.equal(onlySkips.filter((text) => text.startsWith('no-cases')).length, 2, onlySkips.join('\n'));
  assert.equal(onlySkips.filter((text) => text.startsWith('unexcepted skip')).length, 2);
  const dropped = world({ 'src/a.test.mjs': NODE_FILE, 'other/b.test.mjs': NODE_FILE });
  assert.deepEqual(
    dropped.errors.filter((error) => error.code === 'unrouted').map((error) => error.path),
    ['other/b.test.mjs']
  );
});

test('case names come from the runner: computed, generated and repeated names need nothing declared', () => {
  const { manifest, plan } = baseline();
  const names = ['case 1', 'case 2', 'same', 'same'].map((name) => pass(node('src/a.test.mjs', name)));
  assert.deepEqual(run({ manifest, plan, receipts: [...NODE_LEGS(plan, names), ...REST(plan)] }), []);
  // a case of a file the inventory does not assign is unknown, and so is one reported by a leg its file is not routed to
  const stranger = run({
    manifest,
    plan,
    receipts: [...NODE_LEGS(plan, [...NODE_PASSES(), pass(node('src/ghost.test.mjs', 'x'))]), ...REST(plan)],
  });
  assert.ok(
    stranger.some((text) => text.startsWith('unknown:') && text.includes('ghost')),
    stranger.join('\n')
  );
  const elsewhere = run({
    manifest,
    plan,
    receipts: [
      ...NODE_LEGS(plan),
      ...REST(plan).map((entry) =>
        entry.receipt.envelope.leg === 'linux/py/1of1' ? receiptOf(plan, 'linux/py/1of1', 'root', NODE_PASSES()) : entry
      ),
    ],
  });
  assert.ok(
    elsewhere.some((text) => /is not a python identity/.test(text)),
    elsewhere.join('\n')
  );
});

const RUST_FILES = {
  'Cargo.toml': '[workspace]\nmembers = ["crates/p", "crates/live"]\n',
  'crates/p/Cargo.toml': '[package]\nname = "p"\nversion = "0.1.0"\n',
  'crates/p/src/lib.rs': '#[cfg(test)]\nmod tests {\n  #[test] fn one() {}\n}\n',
  'crates/live/Cargo.toml':
    '[package]\nname = "live"\nversion = "0.1.0"\n[[test]]\nname = "office_live"\npath = "tests/office_live.rs"\n',
  'crates/live/tests/office_live.rs': '#[test] #[ignore = "needs Office"] fn live() {}\n',
};
const listOf = (binaries) => ({
  'rust-suites': Object.fromEntries(
    Object.entries(binaries).map(([binary, tests]) => [
      binary,
      {
        'binary-id': binary,
        testcases: Object.fromEntries(
          tests.map(([name, ignored, matches]) => [
            name,
            {
              ignored: !!ignored,
              'filter-match': { status: matches === undefined || matches ? 'matches' : 'mismatch' },
            },
          ])
        ),
      },
    ])
  ),
});
const PACKAGES = new Map([
  ['p', { manifest: 'crates/p/Cargo.toml', targets: [{ kind: 'lib', name: 'p', root: 'crates/p/src/lib.rs' }] }],
  [
    'live',
    {
      manifest: 'crates/live/Cargo.toml',
      targets: [{ kind: 'test', name: 'office_live', root: 'crates/live/tests/office_live.rs' }],
    },
  ],
]);
const rustId = (name) => ['rust', 'crates/p/Cargo.toml', 'lib', 'p', `tests::${name}`];
const LIVE = ['rust', 'crates/live/Cargo.toml', 'test', 'office_live', 'tests::live'];
// the tests of the build: five that run, one the pg profile runs, one nobody runs; a target of live tests only
const ALL_TESTS = {
  p: [
    ['tests::four'],
    ['tests::manual', true],
    ['tests::one'],
    ['tests::pg_only', true],
    ['tests::three'],
    ['tests::two'],
  ],
  'live::office_live': [['tests::live', true]],
};
const LIVE_CLASS = {
  glob: 'crates/live/tests/*_live.rs',
  class: 'not-run-in-ci',
  reason: 'drives real Office',
  owner: OWNER,
};
function rustWorld(classes = [LIVE_CLASS]) {
  const w = world(RUST_FILES, makePlan({ classes }));
  const lists = {
    linux: { all: listOf(ALL_TESTS), profiles: { pg: listOf({ p: [['tests::pg_only', true]] }) } },
    windows: { all: listOf(ALL_TESTS), profiles: {} },
  };
  const ack = (id) => ({ kind: 'case', id, status: 'ignored', reasonCode: 'nextest-ignored', reasonText: '' });
  const receipts = [
    ...NODE_LEGS(w.plan, []),
    ...PARENT(w.plan),
    receiptOf(w.plan, 'linux/py/1of1', 'root', []),
    receiptOf(w.plan, 'linux/core/1of2', 'root', [
      pass(rustId('four')),
      pass(rustId('three')),
      ack(rustId('manual')),
      ack(rustId('pg_only')),
      ack(LIVE),
    ]),
    receiptOf(w.plan, 'linux/core/2of2', 'root', [pass(rustId('one')), pass(rustId('two'))]),
    receiptOf(w.plan, 'linux/core-pg/pg', 'root', [pass(rustId('pg_only'))]),
    receiptOf(w.plan, 'windows/core/1of1', 'root', [
      pass(rustId('four')),
      pass(rustId('one')),
      ack(rustId('manual')),
      ack(rustId('pg_only')),
      ack(LIVE),
    ]),
  ];
  return { ...w, lists, receipts };
}
const ignoredTuple = (id, platform) => ({
  id,
  platform,
  kind: 'ignored',
  reasonCode: 'nextest-ignored',
  owner: OWNER,
  reason: 'needs a machine',
  replacement: { kind: 'none', reason: 'manual' },
});
const rustExceptions = {
  v: 1,
  exceptions: [
    ignoredTuple(rustId('manual'), 'linux'),
    ignoredTuple(rustId('manual'), 'windows'),
    ignoredTuple(rustId('pg_only'), 'windows'),
    ignoredTuple(LIVE, 'linux'),
    ignoredTuple(LIVE, 'windows'),
  ],
};
const rustRun = (w, extra = {}) =>
  run({
    manifest: w.manifest,
    plan: w.plan,
    receipts: w.receipts,
    rustLists: w.lists,
    byName: PACKAGES,
    exceptions: rustExceptions,
    ...extra,
  });

test("rust baseline: a target runs on its variant's legs, a profile leg may run its ignored tests, a classified target needs no pass", () => {
  const w = rustWorld();
  assert.deepEqual(w.errors, []);
  assert.deepEqual(
    w.manifest.units.filter((unit) => unit.id[0] === 'rust'),
    [{ id: ['rust', 'crates/p/Cargo.toml', 'lib', 'p'], source: 'crates/p/src/lib.rs', workspace: true }]
  );
  assert.deepEqual(w.manifest.classified, [
    { path: 'crates/live/tests/office_live.rs', class: 'not-run-in-ci', reason: 'drives real Office' },
  ]);
  assert.deepEqual(rustRun(w), []);
  // without the class the live target ran no case on either variant
  const unclassified = rustWorld([]);
  assert.equal(
    rustRun(unclassified).filter((text) => text.startsWith('no-cases') && text.includes('office_live')).length,
    2
  );
});

test('5. a target that reported no pass on a variant fails there; a profile listing alone is not execution', () => {
  const w = rustWorld();
  const only = (legs, records) => ({
    ...w,
    receipts: w.receipts.map((entry) =>
      legs.includes(entry.receipt.envelope.leg)
        ? receiptOf(w.plan, entry.receipt.envelope.leg, 'root', records(entry))
        : entry
    ),
  });
  const ignoredOnly = (entry) => entry.receipt.records.filter((record) => record.status === 'ignored');
  const windowsNone = rustRun(only(['windows/core/1of1'], ignoredOnly));
  assert.ok(
    windowsNone.some(
      (text) =>
        text.startsWith('no-cases') && text.includes('windows/core/1of1#root') && text.includes('crates/p/Cargo.toml')
    ),
    windowsNone.join('\n')
  );
  // Linux: the partitions and the pg leg all reported nothing that ran
  const linuxNone = rustRun(only(['linux/core/1of2', 'linux/core/2of2', 'linux/core-pg/pg'], ignoredOnly));
  assert.ok(
    linuxNone.some(
      (text) =>
        text.startsWith('no-cases') && text.includes('linux/core-pg/pg#root') && text.includes('crates/p/Cargo.toml')
    ),
    linuxNone.join('\n')
  );
  // one passing test anywhere in the variant's legs is the whole contract of the target, however many the others hold
  assert.deepEqual(rustRun(only(['linux/core/1of2'], (entry) => [pass(rustId('four')), ...ignoredOnly(entry)])), []);
});

test('a variant without a listing is missing; a target the assignment does not know is unknown; a listing that names no package is unreadable', () => {
  const w = rustWorld();
  const noLinux = rustRun(w, { rustLists: { windows: w.lists.windows } });
  assert.ok(
    noLinux.some((text) => text.startsWith('missing: no unfiltered nextest listing for build variant linux')),
    noLinux.join('\n')
  );
  const stranger = rustRun({
    ...w,
    receipts: w.receipts.map((entry) =>
      entry.receipt.envelope.leg === 'linux/core/2of2'
        ? receiptOf(w.plan, 'linux/core/2of2', 'root', [
            ...entry.receipt.records,
            pass(['rust', 'crates/p/Cargo.toml', 'bin', 'tool', 'x']),
          ])
        : entry
    ),
  });
  assert.ok(
    stranger.some((text) => text.startsWith('unknown:') && text.includes('"tool"')),
    stranger.join('\n')
  );
  assert.ok(rustRun(w, { byName: new Map() }).some((text) => text.includes('listing of linux is unreadable')));
  // an empty listing, a suite with no testcases, and a listing that no longer shows a target the manifests declare are errors, not zero observations
  const bad = (all) => rustRun(w, { rustLists: { linux: { all, profiles: {} }, windows: w.lists.windows } });
  assert.ok(
    bad({ 'rust-suites': {} }).some((text) =>
      text.includes('listing of linux is unreadable: the listing shows no test binary')
    )
  );
  assert.ok(bad({ 'rust-suites': { p: { 'binary-id': 'p' } } }).some((text) => text.includes('has no "testcases"')));
  const without = listOf({ 'live::office_live': [['tests::live', true]] });
  const gone = rustRun(w, {
    rustLists: { linux: { all: without, profiles: {} }, windows: { all: without, profiles: {} } },
  });
  assert.ok(
    gone.some((text) => text.startsWith('vanished') && text.includes('"lib","p"')),
    gone.join('\n')
  );
});

test('obligations are per build variant: a target lost on one variant is not satisfied by another, unless the plan declares it absent there', () => {
  const w = rustWorld();
  const without = (name) => listOf(Object.fromEntries(Object.entries(ALL_TESTS).filter(([binary]) => binary !== name)));
  const windowsLost = rustRun(w, { rustLists: { linux: w.lists.linux, windows: { all: without('p'), profiles: {} } } });
  assert.ok(
    windowsLost.some((text) => text.startsWith('vanished') && text.includes('"lib","p"') && text.includes('windows')),
    windowsLost.join('\n')
  );
  assert.ok(!windowsLost.some((text) => text.includes('linux') && text.startsWith('vanished')));
  // declared absent on Windows by a platform rule: not expected there, and unexplained if a listing shows it anyway
  const absent = {
    ...w.plan,
    rust: {
      ...w.plan.rust,
      absent: [{ glob: 'crates/p/src/lib.rs', variants: ['windows'], reason: 'cfg(unix)', owner: OWNER }],
    },
  };
  const declared = (lists) =>
    run({
      manifest: w.manifest,
      plan: absent,
      receipts: w.receipts,
      rustLists: lists,
      byName: PACKAGES,
      exceptions: rustExceptions,
    });
  assert.deepEqual(
    declared({ linux: w.lists.linux, windows: { all: without('p'), profiles: {} } }).filter((text) =>
      text.startsWith('vanished')
    ),
    []
  );
  assert.ok(declared(w.lists).some((text) => text.startsWith('unexplained') && text.includes('windows build')));
  assert.match(
    planProblems({
      ...w.plan,
      rust: { ...w.plan.rust, absent: [{ glob: 'x', variants: [], reason: '', owner: OWNER }] },
    }).join('\n'),
    /absent rule/
  );
});

test('a missing ignore report leaves its exception stale, and an ignored test a profile leg runs needs no tuple', () => {
  const w = rustWorld();
  const noAck = {
    ...w,
    receipts: w.receipts.map((entry) =>
      entry.receipt.envelope.leg === 'windows/core/1of1'
        ? receiptOf(
            w.plan,
            'windows/core/1of1',
            'root',
            entry.receipt.records.filter((record) => record.status === 'pass')
          )
        : entry
    ),
  };
  const problems = rustRun(noAck);
  assert.ok(
    problems.some(
      (text) => text.startsWith('stale exception') && text.includes('windows') && text.includes('tests::manual')
    ),
    problems.join('\n')
  );
  // pg_only is ignored in a Linux partition and passes in the pg leg: the partition's ignore is a scheduler exclusion, never a skip
  assert.deepEqual(
    rustRun(w).filter((text) => text.includes('tests::pg_only') && text.includes('linux')),
    []
  );
  // a profile listing is an intention: when the profile leg does not pass that same case, the dropped ignore is not evidence
  const noPg = {
    ...w,
    receipts: w.receipts.map((entry) =>
      entry.receipt.envelope.leg === 'linux/core-pg/pg'
        ? receiptOf(w.plan, 'linux/core-pg/pg', 'root', [pass(rustId('four'))])
        : entry
    ),
  };
  assert.ok(
    rustRun(noPg).some((text) => text.includes('tests::pg_only') && text.includes('a profile leg is to run it')),
    rustRun(noPg).join('\n')
  );
});

test('6. a matrix leg removed while the others finish is a declared-versus-observed mismatch, in both directions', () => {
  const { manifest, plan, receipts } = baseline();
  const gone = receipts.filter((entry) => entry.receipt.envelope.leg !== 'windows/node/1of1');
  assert.ok(
    run({ manifest, plan, receipts: gone }).some((text) =>
      text.startsWith('missing: no receipt for leg windows/node/1of1')
    )
  );
  // an extra partition nobody declared
  const extra = [...receipts, receiptOf(plan, 'linux/core/1of2', 'root', [], { run: RUN })];
  extra.push({
    path: 'extra',
    receipt: {
      ...receiptOf(plan, 'linux/core/2of2', 'root', []).receipt,
      envelope: { ...receiptOf(plan, 'linux/core/2of2', 'root', []).receipt.envelope, leg: 'linux/core/3of3' },
    },
  });
  const problems = run({ manifest, plan, receipts: extra });
  assert.ok(
    problems.some((text) => text.includes('linux/core/3of3') && text.includes('does not declare')),
    problems.join('\n')
  );
});

test('7. a disabled job, a removed needs edge or a tolerated failure fails the parsed wiring', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const plan = loadPlan();
  const clean = () => structuredClone(loadWorkflows(root));
  assert.deepEqual(wiringProblems(clean(), plan), []);
  const publishWithoutGate = clean();
  publishWithoutGate['release.yml'].jobs.publish.needs = publishWithoutGate['release.yml'].jobs.publish.needs.filter(
    (name) => name !== 'coverage-gate'
  );
  assert.match(wiringProblems(publishWithoutGate, plan).join('\n'), /publish does not list coverage-gate/);
  const alwaysPublish = clean();
  alwaysPublish['release.yml'].jobs.publish.if = '${{ always() }}';
  assert.match(wiringProblems(alwaysPublish, plan).join('\n'), /publish has an `if`/);
  const tolerated = clean();
  tolerated['release-gate.yml'].jobs.runtime['continue-on-error'] = true;
  assert.match(wiringProblems(tolerated, plan).join('\n'), /job runtime tolerates its own failure/);
  const noUpload = clean();
  noUpload['release-gate.yml'].jobs.relay.steps = noUpload['release-gate.yml'].jobs.relay.steps.filter(
    (step) => step.uses !== './.github/actions/upload-evidence'
  );
  assert.match(wiringProblems(noUpload, plan).join('\n'), /job relay has declared legs and no upload-evidence step/);
  const skippedGate = clean();
  skippedGate['release.yml'].jobs['coverage-gate'].if = '${{ inputs.run_critical }}';
  assert.match(wiringProblems(skippedGate, plan).join('\n'), /the gate call has an `if`/);
  const dispatchable = clean();
  dispatchable['mobile-android.yml'].on.workflow_dispatch = {};
  assert.match(
    wiringProblems(dispatchable, plan).join('\n'),
    /mobile-android\.yml must be reachable only through workflow_call/
  );
  const newSink = clean();
  newSink['release.yml'].jobs.sneaky = { 'runs-on': 'x', steps: [{ run: 'npm publish' }] };
  assert.match(
    wiringProblems(newSink, plan).join('\n'),
    /release\.yml sneaky is neither a reviewed sink nor a reviewed non-sink/
  );
  const missingJob = clean();
  delete missingJob['release-gate.yml'].jobs.window;
  assert.match(wiringProblems(missingJob, plan).join('\n'), /window/);
});

test('the verdict cannot be switched off: any condition, tolerated failure, edited command, inserted or reordered step fails the wiring', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const plan = loadPlan();
  const clean = () => structuredClone(loadWorkflows(root));
  const gateOf = (workflows) => workflows['release-gate.yml'].jobs;
  const reconcileStep = (workflows) =>
    gateOf(workflows).complete.steps.find((step) => /cli\.mjs reconcile/.test(step.run ?? ''));
  const inventoryStep = (workflows) =>
    gateOf(workflows).inventory.steps.find((step) => /cli\.mjs inventory/.test(step.run ?? ''));
  const mutations = [
    [
      "the reconciliation step gets `if: 'false'`",
      (w) => {
        reconcileStep(w).if = 'false';
      },
      /complete step \d+ "Reconcile[^"]*" has the condition "false"/,
    ],
    [
      'the reconciliation step gets `if: always()`',
      (w) => {
        reconcileStep(w).if = 'always()';
      },
      /has the condition "always\(\)"/,
    ],
    [
      'the reconciliation step tolerates its failure',
      (w) => {
        reconcileStep(w)['continue-on-error'] = true;
      },
      /has continue-on-error/,
    ],
    [
      'the reconciliation command is made to succeed',
      (w) => {
        reconcileStep(w).run = `${reconcileStep(w).run.trimEnd()} || true\n`;
      },
      /does not run the reviewed command exactly/,
    ],
    [
      'the reconciliation runs under a shell that ignores its status',
      (w) => {
        reconcileStep(w).shell = 'bash {0}';
      },
      /runs with the shell bash \{0\}/,
    ],
    [
      'a step replaces the reconciler before it runs',
      (w) => {
        const steps = gateOf(w).complete.steps;
        steps.splice(steps.indexOf(reconcileStep(w)), 0, {
          run: "echo 'process.exit(0)' > scripts/ci/coverage/cli.mjs",
        });
      },
      /complete differs from the reviewed verdict job/,
    ],
    [
      'the reconciliation is moved before the evidence download',
      (w) => {
        const steps = gateOf(w).complete.steps;
        const step = steps.splice(steps.indexOf(reconcileStep(w)), 1)[0];
        steps.splice(3, 0, step);
      },
      /complete differs from the reviewed verdict job/,
    ],
    [
      'the required-gates check is skipped',
      (w) => {
        gateOf(w).complete.steps[0].if = "github.event_name == 'never'";
      },
      /complete step 1 "Require every selected gate" has the condition/,
    ],
    [
      'the aggregator stops running always',
      (w) => {
        gateOf(w).complete.if = 'success()';
      },
      /complete: its `if` is "success\(\)"/,
    ],
    [
      'the inventory job is turned off',
      (w) => {
        gateOf(w).inventory.if = 'false';
      },
      /inventory: its `if` is "false"/,
    ],
    [
      'the inventory step is turned off',
      (w) => {
        inventoryStep(w).if = 'false';
      },
      /inventory step \d+ "Build the inventory of the commit" has the condition "false"/,
    ],
    [
      'a call of the gate is made a partial run',
      (w) => {
        gateOf(w).changes.outputs.full = '${{ steps.paths.outputs.full }}';
      },
      /changes\.outputs\.full is/,
    ],
    [
      'a leg uploads its evidence before it runs its tests',
      (w) => {
        const steps = gateOf(w).relay.steps;
        const upload = steps.splice(
          steps.findIndex((step) => step.uses === './.github/actions/upload-evidence'),
          1
        )[0];
        steps.splice(2, 0, upload);
      },
      /job relay: a step that writes a receipt runs after the evidence upload/,
    ],
    [
      'a leg uploads its evidence only sometimes',
      (w) => {
        gateOf(w).relay.steps.find((step) => step.uses === './.github/actions/upload-evidence').if = 'success()';
      },
      /job relay: its evidence upload has the condition/,
    ],
    [
      'the join of the prepared runtime is tolerated',
      (w) => {
        w['release.yml'].jobs['prepared-runtime-join']['continue-on-error'] = true;
      },
      /prepared-runtime-join: a verdict job has continue-on-error/,
    ],
  ];
  for (const [label, mutate, pattern] of mutations) {
    const workflows = clean();
    mutate(workflows);
    assert.match(wiringProblems(workflows, plan).join('\n'), pattern, label);
  }
  // two dispositions for one job, and a workflow spelled .yaml, are not silently accepted
  const twice = structuredClone(plan);
  twice.nonSinks.push({ workflow: 'release.yml', job: 'publish', reason: 'x', owner: OWNER });
  assert.match(wiringProblems(clean(), twice).join('\n'), /release\.yml publish has two dispositions/);
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  try {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'x.yaml'), 'on: push\njobs: {}\n');
    assert.deepEqual(Object.keys(loadWorkflows(dir)), ['x.yaml']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release refs: no force, candidates only before the gate, and every sink checks out, tags and releases the commit its gate verified', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const plan = loadPlan();
  const clean = () => structuredClone(loadWorkflows(root));
  const stepOf = (job, pattern) => job.steps.find((step) => pattern.test(step.run ?? ''));
  const mutations = [
    [
      'a tag is force-pushed by a pinned candidate job',
      (w) => {
        stepOf(w['deploy.yml'].jobs['native-commit'], /git push/).run +=
          '\ngit push --force origin "refs/tags/${TAG}"\n';
      },
      /deploy\.yml#native-commit differs from the reviewed job/,
    ],
    [
      'a candidate writer pushes the branch before the gate',
      (w) => {
        stepOf(w['deploy.yml'].jobs['prepare-app'], /git push/).run += '\ngit push origin "HEAD:refs/heads/main"\n';
      },
      /deploy\.yml#prepare-app differs from the reviewed job/,
    ],
    [
      'the voice runtime checks out the default branch',
      (w) => {
        w['build-voice-runtime.yml'].jobs.plan.steps[0].with.ref = '${{ github.event.repository.default_branch }}';
      },
      /build-voice-runtime\.yml plan: a checkout of "\$\{\{ github\.event\.repository\.default_branch \}\}"/,
    ],
    [
      'the voice draft is made at the default branch',
      (w) => {
        w['build-voice-runtime.yml'].jobs['prepare-release'].steps.find((step) =>
          /action-gh-release/.test(step.uses ?? '')
        ).with.target_commitish = '${{ github.event.repository.default_branch }}';
      },
      /build-voice-runtime\.yml prepare-release: a release at/,
    ],
    [
      'the graph release checks out its tag again',
      (w) => {
        w['graph-release.yml'].jobs.build.steps[0].with.ref = 'refs/tags/${{ needs.gate.outputs.tag }}';
      },
      /graph-release\.yml build: a checkout of "refs\/tags/,
    ],
    [
      'the runtime checks out whatever the default ref is',
      (w) => {
        delete w['build-runtime.yml'].jobs.build.steps[0].with.ref;
      },
      /build-runtime\.yml build: a checkout of "the default ref"/,
    ],
    [
      'the runtime is given another commit than the gate verified',
      (w) => {
        w['deploy.yml'].jobs.runtime.with.sha = '${{ needs.plan.outputs.sha }}';
      },
      /sink deploy\.yml runtime publishes "\$\{\{ needs\.plan\.outputs\.sha \}\}", but coverage-gate verified/,
    ],
    [
      'the voice runtime is given no commit',
      (w) => {
        delete w['deploy.yml'].jobs.voice.with;
      },
      /sink deploy\.yml voice publishes undefined/,
    ],
    [
      'a deploy job checks out the default branch',
      (w) => {
        w['deploy.yml'].jobs['prepare-app'].steps[0].with.ref = '${{ github.event.repository.default_branch }}';
      },
      /deploy\.yml prepare-app: a checkout of/,
    ],
    [
      'publish no longer waits for the verified refs',
      (w) => {
        w['release.yml'].jobs.publish.needs = w['release.yml'].jobs.publish.needs.filter(
          (name) => name !== 'push-release-refs'
        );
      },
      /sink release\.yml publish must list push-release-refs/,
    ],
    [
      'publish no longer waits for the prepared runtime',
      (w) => {
        w['release.yml'].jobs.publish.needs = w['release.yml'].jobs.publish.needs.filter(
          (name) => name !== 'prepared-runtime-join'
        );
      },
      /sink release\.yml publish must list prepared-runtime-join/,
    ],
    [
      'the Android release no longer waits for the verified refs',
      (w) => {
        w['release.yml'].jobs['mobile-android'].needs = ['coverage-gate'];
      },
      /mobile-android must list push-release-refs/,
    ],
    [
      'the refs are pushed without the gate',
      (w) => {
        w['release.yml'].jobs['push-release-refs'].needs = ['identity'];
      },
      /push-release-refs .*does not need a job that calls the full-release gate|must list coverage-gate/,
    ],
    [
      'the refs are pushed before the prepared-runtime evidence is joined',
      (w) => {
        w['release.yml'].jobs['push-release-refs'].needs = ['identity', 'coverage-gate'];
      },
      /sink release\.yml push-release-refs .* does not need prepared-runtime-join/,
    ],
    [
      'a gate call that joins in a workflow with no join job',
      (w) => {
        w['deploy.yml'].jobs['coverage-gate'].with.joins = true;
      },
      /calls the gate with joins but has no join verdict job/,
    ],
    [
      'a gated sink of a joining workflow does not wait for the join',
      (w) => {
        w['release.yml'].jobs['deploy-relay'].needs = ['coverage-gate'];
      },
      /sink release\.yml deploy-relay .* does not need prepared-runtime-join/,
    ],
    [
      'a gate scope names a gate no caller joins with',
      (w) => {
        w['release.yml'].jobs['coverage-gate'].with.joins = false;
      },
      /names the gate release, which no caller runs with joins/,
    ],
    [
      'a job nobody listed uploads with a secret and has no needs',
      (w) => {
        w['release.yml'].jobs.uploader = {
          'runs-on': 'x',
          steps: [{ run: 'curl -T build.zip https://example.invalid', env: { TOKEN: '${{ secrets.TOKEN }}' } }],
        };
      },
      /release\.yml uploader is neither a reviewed sink/,
    ],
    [
      'the Android release runs when the join failed and the ref push was skipped',
      (w) => {
        w['release.yml'].jobs['mobile-android'].if =
          "${{ always() && (needs.coverage-gate.result == 'success' || needs.push-release-refs.result == 'skipped') }}";
      },
      /sink release\.yml mobile-android: its `if` is/,
    ],
    [
      'joins is an expression',
      (w) => {
        w['release.yml'].jobs['coverage-gate'].with.joins = '${{ true }}';
      },
      /must pass joins as the literal true/,
    ],
    [
      'the gate name is an expression, spelled differently from the one it equals',
      (w) => {
        w['release.yml'].jobs['coverage-gate'].with.gate = "${{ 'release' }}";
      },
      /must pass a literal gate name/,
    ],
    [
      'two gate calls share one name, so their artifacts would collide',
      (w) => {
        w['release.yml'].jobs['coverage-gate'].with.gate = w['deploy.yml'].jobs['coverage-gate'].with.gate;
      },
      /under the same name native-assets/,
    ],
    [
      'a gate call names no invocation',
      (w) => {
        delete w['deploy.yml'].jobs['coverage-gate'].with.gate;
      },
      /must pass a literal gate name/,
    ],
    [
      'an unreviewed job moves a branch under a lease',
      (w) => {
        w['release.yml'].jobs.sneaky = {
          needs: ['coverage-gate'],
          'runs-on': 'x',
          steps: [{ run: 'git push --force-with-lease=refs/heads/main:abc origin HEAD:refs/heads/main' }],
        };
      },
      /release\.yml sneaky is neither a reviewed sink/,
    ],
    [
      'a gate artifact is unqualified by gate and SHA',
      (w) => {
        w['release-gate.yml'].jobs['core-build'].steps.find(
          (step) => /upload-artifact/.test(step.uses ?? '') && /mixdogd-dev/.test(step.with?.name ?? '')
        ).with.name = 'mixdogd-dev';
      },
      /the artifact "mixdogd-dev" is not named by kind, gate and SHA/,
    ],
    [
      'a gate download merges evidence',
      (w) => {
        w['release-gate.yml'].jobs.complete.steps.find((step) => step.with?.pattern?.startsWith('evidence-')).with[
          'merge-multiple'
        ] = true;
      },
      /downloads never merge/,
    ],
    [
      'standalone runtime refresh no longer waits for the gate',
      (w) => {
        w['refresh-runtime-manifest.yml'].jobs.refresh.needs = ['authorize'];
      },
      /refresh must list coverage-gate/,
    ],
    [
      'the join evidence is selected by a wider name than its one',
      (w) => {
        w['release.yml'].jobs['prepared-runtime-join'].steps.find((step) =>
          /download-artifact/.test(step.uses ?? '')
        ).with.name = 'join-evidence-${{ github.run_attempt }}-*';
      },
      /the join evidence .* is not named/,
    ],
    [
      'a new entry point calls a publishing workflow',
      (w) => {
        w['dispatch.yml'] = {
          on: { workflow_dispatch: null },
          jobs: { go: { uses: './.github/workflows/release.yml' } },
        };
      },
      /dispatch\.yml go is neither a reviewed sink/,
    ],
    [
      'a sink is verified against the job that is its named gate, not any ancestor',
      (w) => {
        w['release.yml'].jobs['coverage-gate'].uses = './.github/workflows/release.yml';
      },
      /its gate coverage-gate is not a job that calls the full-release gate/,
    ],
    [
      'the leased ref push is edited',
      (w) => {
        stepOf(w['release.yml'].jobs['push-release-refs'], /git push/).run +=
          '\ngit push origin HEAD:refs/heads/other\n';
      },
      /release\.yml#push-release-refs differs from the reviewed job/,
    ],
  ];
  for (const [label, mutate, pattern] of mutations) {
    const workflows = clean();
    mutate(workflows);
    assert.match(wiringProblems(workflows, plan).join('\n'), pattern, label);
  }
});

test('8. a Python skip whose reason holds both quote styles keeps it as data: unlisted fails, an exact tuple passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'py-'));
  try {
    writeFileSync(
      join(dir, 'test_q.py'),
      `import unittest\n\nclass Q(unittest.TestCase):\n    @unittest.skip("it's \\"quoted\\" both ways")\n    def test_skipped(self):\n        pass\n\n    def test_ok(self):\n        self.assertTrue(True)\n`
    );
    const receipt = join(dir, 'receipt.json');
    gitRepo(dir);
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../run-receipt.mjs', import.meta.url)), 'unittest', dir, 'test_*.py'],
      {
        encoding: 'utf8',
        cwd: dir,
        env: {
          ...CLEAN_ENV(),
          MIXDOG_RECEIPT: receipt,
          MIXDOG_LEG: 'linux/py/1of1',
          GITHUB_REPOSITORY: RUN.repository,
          GITHUB_WORKFLOW_REF: RUN.workflow,
          GITHUB_RUN_ID: '7',
          GITHUB_RUN_ATTEMPT: '1',
        },
      }
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const { records } = JSON.parse(readFileSync(receipt, 'utf8'));
    const skipped = records.find((record) => record.status === 'skip');
    assert.equal(skipped.reasonText, 'it\'s "quoted" both ways');
    assert.deepEqual(skipped.id, ['python', 'test_q.py', 'Q', 'test_skipped']);
    assert.equal(records.find((record) => record.status === 'pass').id.at(-1), 'test_ok');
    const exact = {
      v: 1,
      exceptions: [
        {
          id: skipped.id,
          platform: { linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform],
          kind: 'skip',
          reasonCode: 'uncoded',
          reasonText: 'it\'s "quoted" both ways',
          owner: OWNER,
          reason: 'r',
          replacement: { kind: 'none', reason: 'x' },
        },
      ],
    };
    assert.deepEqual(receiptsProblems([receipt], exact, process.platform), []);
    assert.equal(receiptsProblems([receipt], noExceptions, process.platform).length, 1);
    assert.equal(
      receiptsProblems(
        [receipt],
        { v: 1, exceptions: [{ ...exact.exceptions[0], reasonText: "it's quoted both ways" }] },
        process.platform
      ).length,
      1
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('9. a deleted file, crate or method, or a skip that became a pass, leaves a stale exact exception with no producer observation', () => {
  const { manifest, plan, receipts } = baseline();
  const ghost = (id) => ({
    id,
    platform: 'linux',
    kind: id[0] === 'rust' ? 'ignored' : 'skip',
    reasonCode: id[0] === 'rust' ? 'nextest-ignored' : 'needs-display',
    owner: OWNER,
    reason: 'r',
    replacement: { kind: 'none', reason: 'x' },
  });
  for (const id of [
    node('src/deleted.test.mjs', 'x'),
    ['rust', 'gone/Cargo.toml', 'lib', 'gone', 'tests::x'],
    ['python', 'py/test_a.py', 'T', 'test_gone'],
    node('src/a.test.mjs', 'outer', 'a'),
  ]) {
    const problems = run({ manifest, plan, receipts, exceptions: { v: 1, exceptions: [ghost(id)] } });
    assert.ok(
      problems.some(
        (text) => text.startsWith('stale exception') && text.includes('was not reported') && text.includes(id[1])
      ),
      problems.join('\n')
    );
  }
});

test('10. the old whole-file schema and an optional field are rejected: an exception names one reported case exactly', () => {
  assert.match(
    exceptionProblems({
      v: 1,
      exceptions: [
        {
          file: 'src/a.test.mjs',
          wholeFile: "process.platform !== 'win32'",
          platforms: ['linux'],
          reasons: [''],
          reason: 'r',
          runsIn: 'x',
        },
      ],
    }).join('\n'),
    /unknown field/
  );
  assert.match(
    exceptionProblems({
      v: 1,
      exceptions: [
        {
          id: ['node', 'src/a.test.mjs'],
          platform: 'linux',
          kind: 'skip',
          reasonCode: 'x',
          owner: 'o',
          reason: 'r',
          optional: true,
          replacement: { kind: 'none', reason: 'x' },
        },
      ],
    }).join('\n'),
    /unknown field optional/
  );
  // a case added to a file after its tuples were written is not covered by them
  const { manifest, plan } = baseline();
  const tuple = (name) =>
    ['linux', 'windows'].map((platform) => ({
      id: node('src/a.test.mjs', name),
      platform,
      kind: 'skip',
      reasonCode: 'platform',
      owner: OWNER,
      reason: 'r',
      replacement: { kind: 'none', reason: 'x' },
    }));
  const skip = (name) => ({
    kind: 'case',
    id: node('src/a.test.mjs', name),
    status: 'skip',
    reasonCode: 'platform',
    reasonText: 'no',
  });
  const receipts = [
    ...NODE_LEGS(plan, [pass(node('src/a.test.mjs', 'top')), skip('old'), skip('added')]),
    ...REST(plan),
  ];
  assert.deepEqual(
    run({ manifest, plan, receipts, exceptions: { v: 1, exceptions: [...tuple('old'), ...tuple('added')] } }),
    []
  );
  const problems = run({ manifest, plan, receipts, exceptions: { v: 1, exceptions: tuple('old') } });
  assert.equal(
    problems.filter((text) => text.startsWith('unexcepted skip') && text.includes('added')).length,
    2,
    problems.join('\n')
  );
});

test('an artifact is trusted only for this commit, run and attempt, from an intact file, on the leg it names', () => {
  const { manifest, plan, receipts } = baseline();
  const swap = (leg, replacement) =>
    receipts.map((entry) =>
      entry.receipt.envelope.leg === leg && entry.receipt.envelope.slot === 'root' ? replacement : entry
    );
  const records = NODE_PASSES();
  const cases = [
    [
      'wrong sha',
      receiptOf(plan, 'linux/node/1of1', 'root', records, { run: { ...RUN, sha: 'e'.repeat(40) } }),
      /not the release commit/,
    ],
    [
      'future attempt',
      receiptOf(plan, 'linux/node/1of1', 'root', records, { run: { ...RUN, attempt: '2' } }),
      /not permitted in attempt/,
    ],
    ['wrong run', receiptOf(plan, 'linux/node/1of1', 'root', records, { run: { ...RUN, runId: '8' } }), /from run 8/],
    [
      'wrong platform',
      receiptOf(plan, 'linux/node/1of1', 'root', records, { platform: 'win32' }),
      /the leg linux\/node\/1of1 is linux/,
    ],
    ['incomplete', receiptOf(plan, 'linux/node/1of1', 'root', records, { complete: false }), /not complete/],
    ['nonzero exit', receiptOf(plan, 'linux/node/1of1', 'root', records, { exit: 1 }), /exit status 1/],
  ];
  for (const [label, replacement, pattern] of cases)
    assert.match(run({ manifest, plan, receipts: swap('linux/node/1of1', replacement) }).join('\n'), pattern, label);
  const truncated = receiptOf(plan, 'linux/node/1of1', 'root', records);
  truncated.receipt.records.pop();
  assert.match(
    run({ manifest, plan, receipts: swap('linux/node/1of1', truncated) }).join('\n'),
    /trailer counts 3 records, the file holds 2/
  );
  const tampered = receiptOf(plan, 'linux/node/1of1', 'root', records);
  tampered.receipt.records[0].status = 'skip';
  assert.match(run({ manifest, plan, receipts: swap('linux/node/1of1', tampered) }).join('\n'), /content hash/);
  const unknownSlot = receiptOf(plan, 'linux/node/1of1', 'root', records);
  unknownSlot.receipt.envelope.slot = 'surprise';
  assert.match(
    run({ manifest, plan, receipts: swap('linux/node/1of1', unknownSlot) }).join('\n'),
    /not a slot of linux\/node\/1of1/
  );
  assert.match(
    run({ manifest: { ...manifest, sha: 'd'.repeat(40) }, plan, receipts }).join('\n'),
    /the manifest is for/
  );
  assert.match(
    run({ manifest, plan: { ...plan, owners: { ...plan.owners, routing: 'someone-else' } }, receipts }).join('\n'),
    /another plan/
  );
});

test('a failure fails whatever else passed, and one invocation id is never two receipts', () => {
  const { manifest, plan, receipts } = baseline();
  const withExtra = (records) =>
    receipts.map((entry) =>
      entry.receipt.envelope.leg === 'linux/node/1of1' && entry.receipt.envelope.slot === 'root'
        ? receiptOf(plan, 'linux/node/1of1', 'root', records)
        : entry
    );
  const failed = run({
    manifest,
    plan,
    receipts: withExtra([
      ...NODE_PASSES().slice(0, 2),
      { kind: 'case', id: node('src/a.test.mjs', 'top'), status: 'fail', reasonText: 'boom' },
    ]),
  });
  assert.ok(failed.some((text) => text.startsWith('failed:') && text.includes('boom')));
  const twin = receipts.map((entry) =>
    entry.receipt.envelope.leg === 'windows/node/1of1'
      ? { ...entry, receipt: { ...entry.receipt, id: receipts[0].receipt.id } }
      : entry
  );
  assert.ok(run({ manifest, plan, receipts: twin }).some((text) => text.includes('is also the id of')));
});

test('a skip on Linux discharges only Linux: Windows still needs its own pass or its own exact exception', () => {
  const { manifest, plan } = baseline();
  const top = NODE_PASSES()[2];
  const skipTop = (records) =>
    records.map((record) =>
      record.id.at(-1) === 'top' ? { ...record, status: 'skip', reasonCode: 'linux-only', reasonText: 'x' } : record
    );
  const received = (linux, windows) => [
    receiptOf(plan, 'linux/node/1of1', 'root', linux),
    receiptOf(plan, 'windows/node/1of1', 'root', windows),
    ...REST(plan),
  ];
  const linuxOnly = {
    v: 1,
    exceptions: [
      {
        id: top.id,
        platform: 'linux',
        kind: 'skip',
        reasonCode: 'linux-only',
        owner: OWNER,
        reason: 'r',
        replacement: { kind: 'none', reason: 'x' },
      },
    ],
  };
  assert.deepEqual(
    run({ manifest, plan, receipts: received(skipTop(NODE_PASSES()), NODE_PASSES()), exceptions: linuxOnly }),
    []
  );
  // the same exception does not excuse a Windows skip
  assert.equal(
    run({ manifest, plan, receipts: received(NODE_PASSES(), skipTop(NODE_PASSES())), exceptions: linuxOnly }).filter(
      (text) => text.startsWith('unexcepted skip') && text.includes('windows')
    ).length,
    1
  );
});

test('a classified file is not required to run, but what it reports is still checked', () => {
  const w = world(
    { 'src/a.test.mjs': NODE_FILE, 'src/live.test.mjs': NODE_FILE },
    makePlan({ classes: [{ glob: 'src/live.test.mjs', class: 'not-run-in-ci', reason: 'live', owner: OWNER }] })
  );
  assert.deepEqual(w.errors, []);
  assert.deepEqual(run({ manifest: w.manifest, plan: w.plan, receipts: [...NODE_LEGS(w.plan), ...REST(w.plan)] }), []);
  const reported = [
    ...NODE_PASSES(),
    {
      kind: 'case',
      id: node('src/live.test.mjs', 'live'),
      status: 'skip',
      reasonCode: 'uncoded',
      reasonText: 'no desktop',
    },
  ];
  const problems = run({
    manifest: w.manifest,
    plan: w.plan,
    receipts: [...NODE_LEGS(w.plan, reported), ...REST(w.plan)],
  });
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.ok(problems.every((text) => text.startsWith('unexcepted skip')));
});

test('inventory: test-looking files nothing accounts for are errors; reviewed narrow classes are the only way out', () => {
  const w = world({
    'src/a.test.mjs': NODE_FILE,
    'src/fixtures/data.test.mjs': 'not a test',
    'tools/odd_test.go': 'package x',
    'tests/helper.mjs': "import { mock } from 'node:test';\nexport const m = mock;\n",
    'src/check.cjs': "const { test } = require('node:test');\n",
    'test/example.js': 'export {};\n',
    'py/helper.py': 'import unittest\n',
    'src/no-cases.test.mjs': 'export {};',
    'py/test_a.py': 'import unittest\n',
    'py/conftest.py': '',
  });
  const codes = w.errors.map((error) => `${error.code} ${error.path}`);
  // one convention: a test file is named the way its runner discovers tests; any other file that loads a runner is an error
  assert.deepEqual(
    codes.filter((code) => code.startsWith('unassigned')),
    [
      'unassigned-test-file py/helper.py',
      'unassigned-test-file src/check.cjs',
      'unassigned-test-file tests/helper.mjs',
      'unassigned-test-file tools/odd_test.go',
    ]
  );
  assert.deepEqual(
    codes.filter((code) => code.startsWith('unrouted')),
    []
  );
  assert.ok(!codes.some((code) => code.includes('fixtures')), 'a reviewed fixture class');
  // a file that registers nothing is still assigned: whether it ran a case is the runner's report
  assert.deepEqual(
    w.manifest.units.map((unit) => unit.id.join(' ')),
    ['node src/a.test.mjs', 'node src/no-cases.test.mjs', 'python py/test_a.py', 'rust crates/p/Cargo.toml lib p']
  );
  assert.deepEqual(
    w.manifest.classified.map((entry) => [entry.path, entry.class]),
    [['src/fixtures/data.test.mjs', 'fixture']]
  );
});

test('inventory: Rust packages, the files a target reaches, and doctests are assigned or classified', () => {
  const lib = (extra) => ({ ...RUST_FILES, 'crates/p/src/lib.rs': extra });
  const codes = (files, classes = [LIVE_CLASS]) =>
    world(files, makePlan({ classes })).errors.map((error) => `${error.code} ${error.path}`);
  assert.deepEqual(codes(RUST_FILES), []);
  // a computed test name, a macro and a generated test are not the inventory's business
  assert.deepEqual(codes(lib('macro_rules! t { ($n:ident) => { #[test] fn $n() {} } }\nt!(one);\n')), []);
  // `mod` through a #[path] below an inline module, and a module under cfg(node_twin) that is not tracked
  assert.deepEqual(
    codes({
      ...lib('mod outer {\n  #[path = "../shared.rs"]\n  mod shared;\n}\n#[cfg(node_twin)]\nmod replay;\n'),
      'crates/p/src/shared.rs': '',
    }),
    []
  );
  assert.deepEqual(codes(lib('mod missing;\n')), ['unresolved-mod crates/p/src/lib.rs']);
  const stray = { ...RUST_FILES, 'crates/p/src/stray.rs': '#[test] fn x() {}\n' };
  assert.deepEqual(codes(stray), ['orphan-rust-source crates/p/src/stray.rs']);
  assert.deepEqual(
    codes(stray, [LIVE_CLASS, { glob: 'crates/p/src/stray.rs', class: 'twin-only', reason: 'replay', owner: OWNER }]),
    []
  );
  assert.deepEqual(codes(lib('/// ```\n/// assert!(true);\n/// ```\npub fn f() {}\n')), [
    'unassigned-test-file crates/p/src/lib.rs',
  ]);
  // a plan that names a doctest leg for the package makes its rustdoc blocks a target of that leg
  const documented = world(
    lib('/// ```\n/// assert!(true);\n/// ```\npub fn f() {}\n'),
    makePlan({
      classes: [LIVE_CLASS],
      rust: { ...makePlan().rust, doctests: [{ manifestDir: 'crates/p', requires: [clause('linux/node/1of1')] }] },
    })
  );
  assert.deepEqual(documented.errors, []);
  assert.deepEqual(
    documented.manifest.units.filter((unit) => unit.id[2] === 'doctest'),
    [
      {
        id: ['rust', 'crates/p/Cargo.toml', 'doctest', 'p'],
        source: 'crates/p/Cargo.toml',
        requires: [clause('linux/node/1of1#root')],
      },
    ]
  );
  // classes never shadow each other
  assert.deepEqual(
    codes(stray, [
      LIVE_CLASS,
      { glob: 'crates/p/src/*.rs', class: 'twin-only', reason: 'a', owner: OWNER },
      { glob: 'crates/p/src/stray.rs', class: 'helper', reason: 'b', owner: OWNER },
    ]),
    ['ambiguous-class crates/p/src/stray.rs']
  );
  const tool = {
    ...RUST_FILES,
    'tool/Cargo.toml': '[package]\nname = "tool"\nversion = "0.1.0"\n',
    'tool/src/lib.rs': '',
  };
  assert.deepEqual(codes(tool), ['package-unplanned tool/Cargo.toml']);
  const standalone = world(
    tool,
    makePlan({
      classes: [LIVE_CLASS],
      rust: { ...makePlan().rust, standalone: [{ manifestDir: 'tool', requires: [clause('linux/node/1of1')] }] },
    })
  );
  assert.deepEqual(standalone.errors, []);
  assert.deepEqual(
    standalone.manifest.units.filter((unit) => unit.listed),
    [
      {
        id: ['rust', 'tool/Cargo.toml', 'lib', 'tool'],
        source: 'tool/src/lib.rs',
        listed: true,
        requires: [clause('linux/node/1of1#root')],
      },
    ]
  );
});

test('inventory requires image-egress compile-fail doctests to produce their own evidence', () => {
  const pkg = 'native/core/crates/mixdog-image-egress';
  const files = {
    'native/core/Cargo.toml': '[workspace]\nmembers = ["crates/mixdog-image-egress"]',
    [`${pkg}/Cargo.toml`]: '[package]\nname = "mixdog-image-egress"',
    [`${pkg}/src/lib.rs`]: '/// ```compile_fail,E0277\n/// let _: i32 = "text".into();\n/// ```\npub fn example() {}\n',
  };
  const { manifest, errors } = buildInventory({
    tracked: Object.keys(files),
    plan: loadPlan(),
    sha: SHA,
    read: (path) => files[path],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    manifest.units.filter((unit) => unit.id[2] === 'doctest'),
    [
      {
        id: ['rust', `${pkg}/Cargo.toml`, 'doctest', 'mixdog_image_egress'],
        source: `${pkg}/Cargo.toml`,
        requires: [clause('linux/core-tests/1of4#doc-image-egress')],
      },
    ]
  );
});

test("a standalone crate's targets are expected by name: each needs its own pass, and one that vanished or never ran is an error", () => {
  const tool = {
    ...RUST_FILES,
    'tool/Cargo.toml': '[package]\nname = "tool"\nversion = "0.1.0"\n',
    'tool/src/lib.rs': '',
    'tool/tests/t.rs': '',
  };
  const toolPlan = makePlan({
    classes: [LIVE_CLASS],
    rust: { ...makePlan().rust, standalone: [{ manifestDir: 'tool', requires: [clause('linux/node/1of1')] }] },
  });
  toolPlan.legs.find((leg) => leg.id === 'linux/node/1of1').slots[0].producer = 'nextest';
  const w = world(tool, toolPlan);
  assert.deepEqual(w.errors, []);
  const lib = ['rust', 'tool/Cargo.toml', 'lib', 'tool', 'unit'];
  const t = ['rust', 'tool/Cargo.toml', 'test', 't', 'works'];
  const byName = new Map([
    ...PACKAGES,
    [
      'tool',
      {
        manifest: 'tool/Cargo.toml',
        targets: [
          { kind: 'lib', name: 'tool', root: 'tool/src/lib.rs' },
          { kind: 'test', name: 't', root: 'tool/tests/t.rs' },
        ],
      },
    ],
  ]);
  const lists = {
    linux: { all: listOf(ALL_TESTS), profiles: { pg: listOf({ p: [['tests::pg_only', true]] }) } },
    windows: { all: listOf(ALL_TESTS), profiles: {} },
  };
  const received = (records, listing) => {
    const linux = receiptOf(w.plan, 'linux/node/1of1', 'root', records, { producer: 'nextest' });
    if (listing) linux.receipt.listing = listing;
    return [
      linux,
      receiptOf(w.plan, 'windows/node/1of1', 'root', []),
      ...REST(w.plan).filter(
        (entry) =>
          entry.receipt.envelope.leg !== 'linux/core/1of2' &&
          entry.receipt.envelope.leg !== 'linux/core/2of2' &&
          entry.receipt.envelope.leg !== 'linux/core-pg/pg' &&
          entry.receipt.envelope.leg !== 'windows/core/1of1'
      ),
      ...rustWorld().receipts.filter((entry) => /core/.test(entry.receipt.envelope.leg)),
    ];
  };
  const check = (records, listing) =>
    run({ manifest: w.manifest, plan: w.plan, receipts: received(records, listing), rustLists: lists, byName }).filter(
      (text) => !/crates\/p|crates\/live|rust\/live/.test(text)
    );
  const both = listOf({ tool: [['unit']], 'tool::t': [['works']] });
  assert.deepEqual(check([pass(lib), pass(t)], both), []);
  // one target's pass does not satisfy the other target of the same crate
  assert.ok(check([pass(lib)], both).some((text) => text.startsWith('no-cases') && text.includes('"test","t"')));
  // a target the manifest declares that the run's listing does not show has vanished
  assert.ok(
    check([pass(lib)], listOf({ tool: [['unit']] })).some(
      (text) => text.startsWith('vanished') && text.includes('"test","t"')
    )
  );
  // a target that holds no test is not asked to run one, and a listing that shows nothing is an error
  assert.deepEqual(check([pass(t)], listOf({ tool: [], 'tool::t': [['works']] })), []);
  assert.ok(
    check([pass(t)], listOf({})).some((text) => text.includes('listing in linux/node/1of1#root is unreadable'))
  );
});

test('a standalone crate assigned to two platforms is checked on each: a target lost on one is not satisfied by the other, nor by another binary of its crate', () => {
  const tool = {
    ...RUST_FILES,
    'tool/Cargo.toml': '[package]\nname = "tool"\nversion = "0.1.0"\n',
    'tool/src/lib.rs': '',
    'tool/tests/t.rs': '',
  };
  const both = {
    ...makePlan().rust,
    standalone: [{ manifestDir: 'tool', requires: [clause('linux/node/1of1'), clause('windows/node/1of1')] }],
  };
  const planWith = (rust) => {
    const plan = makePlan({ classes: [LIVE_CLASS], rust });
    for (const leg of plan.legs.filter((entry) => entry.job === 'node')) leg.slots[0].producer = 'nextest';
    return plan;
  };
  const w = world(tool, planWith(both));
  assert.deepEqual(w.errors, []);
  const byName = new Map([
    ...PACKAGES,
    [
      'tool',
      {
        manifest: 'tool/Cargo.toml',
        targets: [
          { kind: 'lib', name: 'tool', root: 'tool/src/lib.rs' },
          { kind: 'test', name: 't', root: 'tool/tests/t.rs' },
        ],
      },
    ],
  ]);
  const lib = pass(['rust', 'tool/Cargo.toml', 'lib', 'tool', 'unit']);
  const t = pass(['rust', 'tool/Cargo.toml', 'test', 't', 'works']);
  const lists = {
    linux: { all: listOf(ALL_TESTS), profiles: { pg: listOf({ p: [['tests::pg_only', true]] }) } },
    windows: { all: listOf(ALL_TESTS), profiles: {} },
  };
  const check = (w, windowsListing, windowsRecords) => {
    const linux = receiptOf(w.plan, 'linux/node/1of1', 'root', [lib, t], { producer: 'nextest' });
    linux.receipt.listing = listOf({ tool: [['unit']], 'tool::t': [['works']] });
    const windows = receiptOf(w.plan, 'windows/node/1of1', 'root', windowsRecords, { producer: 'nextest' });
    windows.receipt.listing = windowsListing;
    const rest = REST(w.plan).filter((entry) => !/core/.test(entry.receipt.envelope.leg));
    return run({
      manifest: w.manifest,
      plan: w.plan,
      receipts: [
        linux,
        windows,
        ...rest,
        ...rustWorld().receipts.filter((entry) => /core/.test(entry.receipt.envelope.leg)),
      ],
      rustLists: lists,
      byName,
    }).filter((text) => !/crates\/p|crates\/live|rust\/live/.test(text));
  };
  assert.deepEqual(check(w, listOf({ tool: [['unit']], 'tool::t': [['works']] }), [lib, t]), []);
  const lost = check(w, listOf({ tool: [['unit']] }), [lib]);
  assert.ok(
    lost.some(
      (text) => text.startsWith('vanished') && text.includes('"test","t"') && text.includes('windows/node/1of1')
    ),
    lost.join('\n')
  );
  // declared absent from Windows by a rule of the plan (a platform cfg), the same listing is correct
  const rule = { glob: 'tool/tests/t.rs', variants: ['windows'], reason: 'cfg(unix)', owner: OWNER };
  assert.match(
    planProblems(planWith({ ...both, absent: [{ ...rule, variants: ['nope'] }] })).join('\n'),
    /names the variant nope, which the plan does not declare/
  );
  const absent = world(tool, planWith({ ...both, absent: [rule] }));
  assert.deepEqual(absent.errors, []);
  assert.deepEqual(check(absent, listOf({ tool: [['unit']] }), [lib]), []);
});

test('discovery diagnostic: comments are ignored and `import os, unittest` is seen; the naming convention is what assigns', () => {
  const w = world({
    'py/helper.py': '# import unittest\nimport os\n',
    'py/loader.py': 'import os, unittest\n',
    'src/loader.mjs': "// import test from 'node:test'\nexport {};\n",
    'src/real.mjs': "import test from 'node:test';\n",
  });
  assert.deepEqual(
    w.errors.map((error) => `${error.code} ${error.path}`),
    ['unassigned-test-file py/loader.py', 'unassigned-test-file src/real.mjs']
  );
  assert.deepEqual(
    world({ 'src/side.mjs': "import 'node:test';\n" }).errors.map((error) => error.path),
    ['src/side.mjs']
  );
});

test('matrix sizes: axes alone or an include list alone are counted, every other form is refused, not miscounted', () => {
  const job = (matrix) => ({ strategy: { matrix } });
  assert.equal(matrixSize({}), 1);
  assert.equal(matrixSize(job('${{ fromJSON(x) }}')), null);
  assert.equal(matrixSize(job({ runner: ['a', 'b'], shard: [1, 2, 3] })), 6);
  assert.equal(matrixSize(job({ include: [{ a: 1 }, { a: 2 }] })), 2);
  assert.throws(() => matrixSize(job({ runner: ['a', 'b'], exclude: [{ runner: 'a' }] })), /does not count/);
  assert.throws(() => matrixSize(job({ runner: ['a', 'b'], include: [{ extra: 1 }] })), /does not count/);
  assert.throws(() => matrixSize(job({ include: '${{ x }}' })), /does not count/);
});

test('one naming for the artifacts of a gate call: the listings are read from the layout the download leaves, and every upload and download of the gate is named by it', () => {
  const plan = loadPlan();
  const call = { gate: 'release', sha: 'a'.repeat(40) };
  const dir = mkdtempSync(join(tmpdir(), 'lists-'));
  try {
    const put = (variant, name, content) => {
      mkdirSync(join(dir, artifactName('rust-lists', { ...call, detail: variant.name })), { recursive: true });
      writeFileSync(
        join(dir, artifactName('rust-lists', { ...call, detail: variant.name }), name),
        JSON.stringify(content)
      );
    };
    for (const variant of plan.rust.variants) {
      put(variant, 'all.json', listOf({ p: [['t']] }));
      put(variant, 'binding.json', { leg: variant.listLeg.split('#')[0], sha: call.sha });
      for (const profile of Object.keys(variant.profileLegs))
        put(variant, `${profile}.json`, listOf({ p: [['t', true]] }));
    }
    const real = loadRustLists(dir, plan, call);
    assert.deepEqual(real.problems, []);
    assert.deepEqual(Object.keys(real.lists).sort(), plan.rust.variants.map((variant) => variant.name).sort());
    assert.deepEqual(Object.keys(real.lists.linux.profiles).sort(), ['entry', 'pg', 'services-pg']);
    // Stable across attempts, but never shared with another gate in the run.
    const other = loadRustLists(dir, plan, { ...call, gate: 'runtime-refresh' });
    assert.equal(other.problems.length, plan.rust.variants.length);
    assert.deepEqual(other.lists, {});
    // an extra or missing profile file, and a listing made by another invocation or commit, are errors
    const linux = join(dir, artifactName('rust-lists', { ...call, detail: 'linux' }));
    rmSync(join(linux, 'entry.json'));
    assert.match(
      loadRustLists(dir, plan, call).problems.join('\n'),
      /variant linux .* holds .*the plan names .*entry\.json/
    );
    writeFileSync(join(linux, 'entry.json'), JSON.stringify(listOf({ p: [['t', true]] })));
    writeFileSync(join(linux, 'binding.json'), JSON.stringify({ leg: 'linux/core-tests/2of4', sha: call.sha }));
    assert.match(loadRustLists(dir, plan, call).problems.join('\n'), /was made by linux\/core-tests\/2of4/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // the workflows spell the same names: the gate's rust-lists upload, and the evidence action
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const gate = loadWorkflows(root)['release-gate.yml'];
  const upload = gate.jobs['core-tests'].steps.find(
    (step) => /upload-artifact/.test(step.uses ?? '') && /rust-lists/.test(step.with.name)
  );
  assert.equal(upload.with.name, artifactTemplate('rust-lists', '${{ matrix.os }}'));
  assert.match(
    readFileSync(join(root, '.github/actions/upload-evidence/action.yml'), 'utf8'),
    new RegExp(`name: ${artifactTemplate('evidence', '${{ inputs.name }}').replace(/[$.{}()|*+?[\]\\]/g, '\\$&')}`)
  );
});

test('a draft release is staged by its listing: a public release is refused, a draft of another commit is not resumed, a listing that lacks the tag creates one', () => {
  const draft = { id: 7, tag_name: 'v1.2.3', draft: true, target_commitish: 'a'.repeat(40) };
  assert.deepEqual(releaseState([], 'v1.2.3'), { state: 'none' });
  assert.equal(releaseState([draft], 'v1.2.3').state, 'draft');
  assert.equal(releaseState([{ ...draft, draft: false }], 'v1.2.3').state, 'public');
  assert.throws(() => releaseState([draft, { ...draft, id: 8 }], 'v1.2.3'), /refusing to pick one/);
  assert.deepEqual(stageDraft([{ ...draft, tag_name: 'v1.2.2' }], 'v1.2.3', draft.target_commitish), {
    action: 'create',
  });
  assert.deepEqual(stageDraft([draft], 'v1.2.3', draft.target_commitish), { action: 'resume', id: 7 });
  assert.throws(() => stageDraft([draft], 'v1.2.3', 'b'.repeat(40)), /not resumed/);
  assert.throws(() => stageDraft([{ ...draft, draft: false }], 'v1.2.3', draft.target_commitish), /public release/);
});

test("receipt identities are validated by producer, family and kind: a case must carry the runner's case component", () => {
  const make = (producer, records) => {
    const made = records.map((record, seq) => makeRecord(seq, record));
    return {
      v: EVIDENCE_VERSION,
      id: 'x',
      kind: producer,
      platform: 'linux',
      complete: true,
      exitCode: 0,
      envelope: {
        repository: 'o/r',
        sha: 'a'.repeat(40),
        workflow: 'w',
        runId: '1',
        attempt: '1',
        leg: 'linux/node/1of1',
        os: 'linux',
        slot: 'root',
        parentSlot: null,
        parentInvocation: null,
        producer,
      },
      records: made,
      trailer: { recordCount: made.length, contentHash: contentHash(made) },
    };
  };
  assert.deepEqual(integrityProblems(make('node', [pass(node('src/a.test.mjs', 'case'))])), []);
  assert.match(
    integrityProblems(make('node', [pass(['node', 'src/a.test.mjs'])])).join('\n'),
    /does not carry the runner's case component/
  );
  assert.match(
    integrityProblems(make('node', [pass(['rust', 'c/Cargo.toml', 'lib', 'c', 'x'])])).join('\n'),
    /is not a node identity/
  );
  assert.match(
    integrityProblems(make('nextest', [pass(['rust', 'c/Cargo.toml', 'lib', 'c'])])).join('\n'),
    /does not carry the runner's case component/
  );
  assert.match(integrityProblems(make('shell', [pass(['shell', 'd/x.test.sh'])])).join('\n'), /does not carry/);
  assert.match(
    integrityProblems(make('unittest', [pass(['python', 'p/test_a.py', 'C'])])).join('\n'),
    /does not carry/
  );
  // a file-only record cannot discharge a file's `no-cases` in a reconcile either
  const { manifest, plan } = baseline();
  const problems = run({
    manifest,
    plan,
    receipts: [...NODE_LEGS(plan, [pass(['node', 'src/a.test.mjs'])]), ...REST(plan)],
  }).join('\n');
  assert.match(problems, /does not carry the runner's case component/);
});

test('a join checks the file that runs after packaging in its own slot: no pass there is an error, a pass satisfies it', () => {
  const file = 'apps/p/artifact.live.test.mjs';
  const base = makePlan();
  const plan = makePlan({
    joinLegs: [
      {
        id: 'windows/package/1of1',
        os: 'windows',
        workflow: 'p.yml',
        job: 'package',
        caller: 'release.yml#p',
        slots: [slot('packaged')],
      },
    ],
    classes: [
      {
        glob: file,
        class: 'runs-after-packaging',
        joinSlot: 'windows/package/1of1#packaged',
        reason: 'checks the package',
        owner: OWNER,
      },
    ],
  });
  assert.deepEqual(planProblems(plan), []);
  assert.match(
    planProblems(
      makePlan({ classes: [{ glob: file, class: 'runs-after-packaging', reason: 'x', owner: OWNER }] })
    ).join('\n'),
    /needs a joinSlot/
  );
  const w = world({ 'src/a.test.mjs': NODE_FILE, [file]: NODE_FILE }, plan);
  assert.deepEqual(w.errors, []);
  const joined = (records) =>
    reconcileJoin({
      manifest: w.manifest,
      plan: w.plan,
      exceptions: noExceptions,
      receipts: [receiptOf(w.plan, 'windows/package/1of1', 'packaged', records)],
      context: RUN,
    });
  assert.ok(joined([]).some((text) => text.startsWith('no replacement') && text.includes(file)));
  assert.deepEqual(joined([pass(node(file, 'layout'))]), []);
  assert.ok(base);
});

test('the plan: a clause with no leg, an empty clause and an unowned class are rejected', () => {
  assert.deepEqual(planProblems(makePlan()), []);
  assert.match(
    planProblems(
      makePlan({ routes: [{ name: 'r', family: 'node', owner: OWNER, include: ['x'], requires: [] }] })
    ).join('\n'),
    /no requirement/
  );
  assert.match(
    planProblems(
      makePlan({ routes: [{ name: 'r', family: 'node', owner: OWNER, include: ['x'], requires: [{ anyOf: [] }] }] })
    ).join('\n'),
    /empty clause/
  );
  assert.match(
    planProblems(
      makePlan({
        routes: [{ name: 'r', family: 'node', owner: OWNER, include: ['x'], requires: [clause('nowhere/1of1')] }],
      })
    ).join('\n'),
    /undeclared leg/
  );
  assert.match(
    planProblems(makePlan({ classes: [{ glob: '**', class: 'fixture', reason: 'all', owner: OWNER }] })).join('\n'),
    /not narrow/
  );
});

test('the real plan and the real exception list are valid: every replacement names a declared obligation, every Node tuple a tracked file', () => {
  const plan = loadPlan();
  assert.deepEqual(planProblems(plan), []);
  const list = JSON.parse(readFileSync(new URL('./exceptions.json', import.meta.url), 'utf8'));
  assert.deepEqual(exceptionProblems(list, plan), []);
  const oses = new Set(plan.legs.map((leg) => leg.os));
  for (const entry of list.exceptions)
    assert.ok(oses.has(entry.platform), `${idKey(entry.id)} names ${entry.platform}`);
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  for (const entry of list.exceptions.filter((tuple) => tuple.id[0] === 'node'))
    assert.ok(existsSync(join(root, entry.id[1])), `${idKey(entry.id)} names a file that is not there`);
});

test('replacements are enforced: a runs-in obligation needs a pass of the case there, a parent test needs a pass, a join leg is checked at the join', () => {
  const { manifest, plan } = baseline();
  const skipLinux = (records) =>
    records.map((record) => ({ ...record, status: 'skip', reasonCode: 'windows-only', reasonText: 'x' }));
  const tuple = (record, replacement) => ({
    id: record.id,
    platform: 'linux',
    kind: 'skip',
    reasonCode: 'windows-only',
    owner: OWNER,
    reason: 'r',
    replacement,
  });
  const linuxSkips = (windows) => [
    receiptOf(plan, 'linux/node/1of1', 'root', skipLinux(NODE_PASSES())),
    receiptOf(plan, 'windows/node/1of1', 'root', windows),
    ...REST(plan),
  ];
  const runsOnWindows = {
    v: 1,
    exceptions: NODE_PASSES().map((record) => tuple(record, { kind: 'runs', in: ['windows/node/1of1'] })),
  };
  assert.deepEqual(run({ manifest, plan, receipts: linuxSkips(NODE_PASSES()), exceptions: runsOnWindows }), []);
  // the Windows leg skipped one of them too (with its own exact tuple): the Linux exception's replacement never ran
  const top = NODE_PASSES()[2];
  const windowsSkipTop = {
    v: 1,
    exceptions: [
      ...runsOnWindows.exceptions,
      { ...tuple(top, { kind: 'none', reason: 'manual' }), platform: 'windows' },
    ],
  };
  const problems = run({
    manifest,
    plan,
    receipts: linuxSkips([
      ...NODE_PASSES().slice(0, 2),
      { ...top, status: 'skip', reasonCode: 'windows-only', reasonText: 'x' },
    ]),
    exceptions: windowsSkipTop,
  });
  assert.deepEqual(
    problems.filter((text) => text.startsWith('no replacement')),
    [
      `no replacement: ${idKey(top.id)} is excepted on linux because it runs in windows/node/1of1#root, which reported no pass of it`,
    ]
  );
  // a replacement that names a slot the plan does not declare is refused by the schema
  assert.match(
    exceptionProblems(
      { v: 1, exceptions: [tuple(top, { kind: 'runs', in: ['windows/node/1of1#nowhere'] })] },
      plan
    ).join('\n'),
    /does not declare/
  );
  // a child-process case: the test that starts it must have passed in the invocation that reported the child
  const [a, b] = NODE_PASSES();
  const child = { ...top, status: 'skip', reasonCode: 'windows-only', reasonText: 'x' };
  const asChild = { v: 1, exceptions: [tuple(top, { kind: 'parent', parents: [a.id] })] };
  const received = (linux) => [
    receiptOf(plan, 'linux/node/1of1', 'root', linux),
    receiptOf(plan, 'windows/node/1of1', 'root', NODE_PASSES()),
    ...REST(plan),
  ];
  assert.deepEqual(run({ manifest, plan, receipts: received([a, b, child]), exceptions: asChild }), []);
  const parentElsewhere = run({ manifest, plan, receipts: received([b, child]), exceptions: asChild });
  assert.ok(
    parentElsewhere.some(
      (text) =>
        text.startsWith('no replacement') &&
        text.includes(`because ${idKey(a.id)} starts it, which did not pass in linux/node/1of1#root`)
    ),
    parentElsewhere.join('\n')
  );
  // a case scoped to the release gate is not asked of another gate; the gate it is scoped to still needs its join, and a scope is never a way out everywhere
  const scoped = {
    ...plan,
    gateScopes: [{ id: NODE_PASSES()[0].id, gates: ['release'], reason: 'tests the release package', owner: OWNER }],
  };
  const toJoin = {
    v: 1,
    exceptions: NODE_PASSES().map((record) => tuple(record, { kind: 'runs', in: ['windows/package/1of1#prepared'] })),
  };
  const gateRun = (gate, joins) =>
    run({
      manifest,
      plan: scoped,
      receipts: linuxSkips(NODE_PASSES()),
      exceptions: toJoin,
      context: { ...RUN, gate, joins },
    }).filter((text) => text.startsWith(`no replacement: ${idKey(NODE_PASSES()[0].id)}`));
  assert.deepEqual(gateRun('mirror', false), []);
  assert.equal(gateRun('release', false).length, 1);
  assert.deepEqual(gateRun('release', true), []);
  assert.ok(
    run({
      manifest,
      plan: { ...scoped, gateScopes: [{ ...scoped.gateScopes[0], id: node('src/a.test.mjs', 'nothing') }] },
      receipts: linuxSkips(NODE_PASSES()),
      exceptions: toJoin,
      context: { ...RUN, gate: 'release', joins: true },
    }).some((text) => text.startsWith('stale scope'))
  );
  assert.match(
    planProblems({ ...scoped, gateScopes: [{ id: ['node', 'x'], gates: [], reason: '', owner: OWNER }] }).join('\n'),
    /needs the gates that must run it/
  );
  // a join obligation is not decided by the gate, and the join requires the pass in its own leg's receipt
  const join1 = {
    v: 1,
    exceptions: NODE_PASSES().map((record) => tuple(record, { kind: 'runs', in: ['windows/package/1of1#prepared'] })),
  };
  assert.deepEqual(
    run({ manifest, plan, receipts: linuxSkips(NODE_PASSES()), exceptions: join1, context: { ...RUN, joins: true } }),
    []
  );
  // a gate call with no join cannot accept the promise: nothing would check it before an outward effect
  assert.ok(
    run({ manifest, plan, receipts: linuxSkips(NODE_PASSES()), exceptions: join1 }).some(
      (text) => text.startsWith('no replacement') && text.includes('has no join for')
    )
  );
  const joined = (records) =>
    reconcileJoin({
      manifest,
      plan,
      exceptions: join1,
      receipts: [receiptOf(plan, 'windows/package/1of1', 'prepared', records)],
      context: RUN,
    });
  assert.deepEqual(joined(NODE_PASSES()), []);
  assert.ok(
    joined(NODE_PASSES().slice(0, 2)).some((text) => text.startsWith('no replacement') && text.includes('top'))
  );
  assert.ok(
    joined([...NODE_PASSES().slice(0, 2), { ...top, status: 'skip', reasonCode: 'x', reasonText: 'no runtime' }]).some(
      (text) => text.startsWith('skip:') && text.includes('prepared environment')
    )
  );
  assert.ok(
    reconcileJoin({ manifest, plan, exceptions: join1, receipts: [], context: RUN }).some((text) =>
      text.startsWith('missing: no receipt for leg windows/package/1of1 slot prepared')
    )
  );
  // a join leg is never where a test is routed
  assert.match(
    planProblems(
      makePlan({
        routes: [
          { name: 'r', family: 'node', owner: OWNER, include: ['x'], requires: [clause('windows/package/1of1')] },
        ],
      })
    ).join('\n'),
    /routes to the join leg/
  );
});

test('every declared leg has a producer: the plan has no pending form and a leg without evidence is missing', () => {
  const pending = makePlan();
  pending.legs[0].pending = 'not wired yet';
  assert.match(planProblems(pending).join('\n'), /unknown field pending/);
  assert.match(planProblems(makePlan({ pendingProducers: [] })).join('\n'), /no pending form/);
  const unproduced = makePlan();
  delete unproduced.legs[0].slots[0].producer;
  assert.match(planProblems(unproduced).join('\n'), /needs its producer/);
  const real = loadPlan();
  assert.ok(
    real.legs.every((leg) => leg.slots.every((entry) => entry.producer)),
    'every real slot names its producer'
  );
});

test('Rust ignore dispositions come from the invocation itself, and a deselection under --run-ignored is refused', () => {
  // nextest's own JUnit: a <skipped> testcase of a default run is an ignore disposition; under --run-ignored only it is a deselection
  const xml =
    '<testsuites><testsuite name="p"><testcase name="tests::manual" classname="p"><skipped/></testcase><testcase name="tests::one" classname="p"/></testsuite></testsuites>';
  const byName = new Map([['p', { manifest: 'crates/p/Cargo.toml', targets: [{ kind: 'lib', name: 'p' }] }]]);
  const ok = invocationRecords(xml, byName, ['--profile', 'ci', '--partition', 'count:1/2']);
  assert.deepEqual([ok.problems, ok.records.map((record) => record.status)], [[], ['ignored', 'pass']]);
  assert.equal(invocationRecords(xml, byName, ['--profile', 'pg', '--run-ignored', 'only']).problems.length, 1);
  assert.equal(invocationRecords(xml, byName, ['--run-ignored=all']).problems.length, 1);
  assert.equal(runIgnoredMode(['--no-tests=fail']), 'default');
});

test('the inventory is of a commit: a checkout that differs is refused by name, a clean one completes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inventory-'));
  try {
    const { git } = gitRepo(dir);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.test.mjs'), NODE_FILE);
    writeFileSync(join(dir, 'src', 'b.test.mjs'), NODE_FILE.replace("'top'", "'other'"));
    git('add', '-A');
    git('commit', '-q', '-m', 'tests');
    const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
    const inventory = () =>
      spawnSync(
        process.execPath,
        [cli, 'inventory', '--root', dir, '--out', join(dir, '..', `${dir.split(/[\\/]/).at(-1)}-manifest.json`)],
        { encoding: 'utf8', env: CLEAN_ENV() }
      );
    rmSync(join(dir, 'src', 'b.test.mjs'));
    const dirty = inventory();
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /differs from the commit [0-9a-f]{40} in 1 path\(s\)[\s\S]*src\/b\.test\.mjs/);
    assert.doesNotMatch(dirty.stderr, /ENOENT/);
    writeFileSync(join(dir, 'src', 'new.test.mjs'), NODE_FILE);
    git('checkout', '--', 'src/b.test.mjs');
    assert.match(inventory().stderr, /src\/new\.test\.mjs/, 'an untracked file is not part of the commit either');
    rmSync(join(dir, 'src', 'new.test.mjs'));
    // the clean checkout runs to the end
    const clean = inventory();
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /^inventory: \d+ test files and targets, digest [0-9a-f]{64}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a shell suite reports a case per `ok:` line; a failed check fails its scenario whatever the stream order; a silent file ran no case', () => {
  const records = shellRecords('d/x.test.sh', ['ok: one', 'ok: two', 'FAIL: one: the release is not restored']);
  assert.deepEqual(
    records.map((record) => [record.id, record.status]),
    [
      [['shell', 'd/x.test.sh', 'one'], 'fail'],
      [['shell', 'd/x.test.sh', 'two'], 'pass'],
    ]
  );
  const base = makePlan();
  const shellLeg = {
    id: 'linux/sh/1of1',
    os: 'linux',
    workflow: 'release-gate.yml',
    job: 'sh',
    slots: [slot('root', 'shell')],
  };
  const w = world(
    { 'src/a.test.mjs': NODE_FILE, 'd/x.test.sh': '#!/bin/bash\n' },
    makePlan({
      legs: [...base.legs, shellLeg],
      routes: [
        ...base.routes,
        { name: 'sh', family: 'shell', owner: OWNER, include: ['d/*.test.sh'], requires: [clause('linux/sh/1of1')] },
      ],
    })
  );
  assert.deepEqual(w.errors, []);
  const received = (shell) => [
    receiptOf(w.plan, 'linux/node/1of1', 'root', NODE_PASSES()),
    receiptOf(w.plan, 'linux/sh/1of1', 'root', shell),
    receiptOf(w.plan, 'windows/node/1of1', 'root', NODE_PASSES()),
    ...REST(w.plan),
  ];
  assert.deepEqual(
    run({ manifest: w.manifest, plan: w.plan, receipts: received(shellRecords('d/x.test.sh', ['ok: two'])) }),
    []
  );
  assert.ok(
    run({ manifest: w.manifest, plan: w.plan, receipts: received([]) }).some(
      (text) => text.startsWith('no-cases') && text.includes('d/x.test.sh')
    )
  );
});

test("doctests are the records of libtest's own lines for the package's lib target", () => {
  const records = doctestRecords(
    [
      'running 3 tests',
      'test src/a.rs - a (line 3) ... ok',
      'test src/a.rs - b (line 9) ... FAILED',
      'test src/a.rs - c (line 12) ... ignored',
      'test result: FAILED',
    ],
    'c/Cargo.toml',
    'c'
  );
  assert.deepEqual(
    records.map((record) => [record.id.slice(2), record.status]),
    [
      [['doctest', 'c', 'src/a.rs - a (line 3)'], 'pass'],
      [['doctest', 'c', 'src/a.rs - b (line 9)'], 'fail'],
      [['doctest', 'c', 'src/a.rs - c (line 12)'], 'ignored'],
    ]
  );
});

test('adapters: a nextest JUnit report becomes identified terminal records; a retry is a failure; binaries map to targets', () => {
  const xml = `<?xml version="1.0"?><testsuites><testsuite name="p"><testcase name="tests::one" classname="p"/>
    <testcase name="tests::bad" classname="p"><failure message="boom &amp; more"/></testcase>
    <testcase name="tests::flaky" classname="p::it"><flakyFailure message="x"/></testcase>
    <testcase name="tests::skipped" classname="p::bin/tool"><skipped message="ignored"/></testcase></testsuite></testsuites>`;
  assert.deepEqual(
    parseJunit(xml).map((found) => [found.name, found.status]),
    [
      ['tests::one', 'pass'],
      ['tests::bad', 'fail'],
      ['tests::flaky', 'retried'],
      ['tests::skipped', 'ignored'],
    ]
  );
  const byName = new Map([['p', { manifest: 'crates/p/Cargo.toml', targets: [{ kind: 'lib', name: 'p_lib' }] }]]);
  const records = junitRecords(xml, byName);
  assert.deepEqual(records[0].id, ['rust', 'crates/p/Cargo.toml', 'lib', 'p_lib', 'tests::one']);
  assert.deepEqual(records[2].id.slice(2, 4), ['test', 'it']);
  assert.equal(records[2].status, 'fail');
  assert.deepEqual(records[3].id.slice(2, 4), ['bin', 'tool']);
  assert.throws(() => targetOfBinaryId('p::example/demo', byName), /example or bench/);
  assert.throws(() => targetOfBinaryId('unknown', byName), /no tracked package/);
});

test('toml-lite reads the manifest subset and refuses the rest', () => {
  const toml = parseToml(
    '[package]\nname = "x"\nversion = "1.0.0" # comment\n[lib]\ntest = false\n[[bin]]\nname = "a"\n[[bin]]\nname = "b"\n[features]\ndefault = ["a", "b"]\n'
  );
  assert.equal(toml.package.name, 'x');
  assert.equal(toml.lib.test, false);
  assert.deepEqual(
    toml.bin.map((bin) => bin.name),
    ['a', 'b']
  );
  assert.deepEqual(toml.features.default, ['a', 'b']);
  assert.throws(() => parseToml('x = 2024-01-01T00:00:00Z'), /unsupported value/);
});

test('the node reporter records suites and cases with full ancestry, drops the synthetic file event, and expands to nothing without a trailer lie', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reporter-'));
  try {
    mkdirSync(join(dir, 'x'));
    writeFileSync(
      join(dir, 'x', 'a.test.mjs'),
      NODE_FILE + "describe.skip('gone', () => { it('hidden', () => {}); });\n"
    );
    writeFileSync(join(dir, 'x', 'empty.test.mjs'), 'export {};\n');
    const receipt = join(dir, 'r.json');
    const { head } = gitRepo(dir);
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../node-runner.mjs', import.meta.url)),
        join(dir, 'x', 'a.test.mjs'),
        join(dir, 'x', 'empty.test.mjs'),
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...CLEAN_ENV(),
          MIXDOG_RECEIPT: receipt,
          MIXDOG_LEG: 'linux/node/1of1',
          GITHUB_REPOSITORY: RUN.repository,
          GITHUB_WORKFLOW_REF: RUN.workflow,
          GITHUB_RUN_ID: '7',
          GITHUB_RUN_ATTEMPT: '1',
        },
      }
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const { records, envelope, trailer } = JSON.parse(readFileSync(receipt, 'utf8'));
    const summary = records.map((record) => `${record.kind}:${record.status}:${record.id.slice(2).join('/')}`).sort();
    assert.deepEqual(summary, [
      'case:pass:outer/a',
      'case:pass:outer/b',
      'case:pass:top',
      'suite:pass:outer',
      'suite:skip:gone',
    ]);
    assert.equal(
      records.every((record) => record.id[1].endsWith('a.test.mjs')),
      true,
      'the empty file leaves no record'
    );
    assert.deepEqual(
      [envelope.leg, envelope.sha, envelope.slot, trailer.recordCount],
      ['linux/node/1of1', head, 'root', records.length]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// keep the unused helper import honest
test('helpers are exercised', () => {
  assert.equal(typeof dirname, 'function');
});
