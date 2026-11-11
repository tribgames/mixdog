#!/usr/bin/env node
// Records Node's worktree names and cache cleanups for the k1 UNTESTED slug.test.mjs and cache-cleanups.test.mjs
// (gaps-rest.md section 3, mixdog-scm `worktree/names.rs`, `worktree/manager.rs` with_root_cleanup). Every input of
// the slug test goes through Node's real `slugFromHint`, `uniqueSlug` and `worktreeNameError`; the cache cleanup test
// runs Node's real `registerWorktreeCacheCleanups` over `createRootCleanupRegistry`.
//
//   node benchmarks/rust-core/recorders/record-worktree-names-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/worktree-names-cases/{golden.json,MANIFEST.json}.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-worktree-names-cases.mjs';
const TESTS = ['src/runtime/shared/worktrees/slug.test.mjs', 'src/runtime/shared/worktrees/cache-cleanups.test.mjs'];

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-worktree-names-cases-'));

const { worktreeNameError, createRootCleanupRegistry } = await importFrom(tree, 'src/runtime/shared/worktrees/contract.mjs');
const { SLUG_MAX_LENGTH, slugFromHint, uniqueSlug } = await importFrom(tree, 'src/runtime/shared/worktrees/slug.mjs');
const { WORKTREE_CACHE_CLEANUPS, registerWorktreeCacheCleanups } = await importFrom(tree, 'src/runtime/shared/worktrees/cache-cleanups.mjs');

const SLUG_TEST = 'slugs are short, lowercase and Windows-safe';
const UNIQUE_TEST = 'unique slugs add a numeric suffix within the length bound';
const cases = [];

// `null` reaches the slug as `String(null ?? '')`, the empty text; the core takes text, so it replays as "".
const hints = [
  'Fix the login page!',
  '  Café crème: déjà vu  ',
  '../../etc/passwd',
  '로그인 버그 고치기',
  '',
  null,
  'NUL',
  'com1',
  'branch.lock',
  'implement the new billing export pipeline with retries and audit logging',
  'x'.repeat(100),
  'a',
  '___',
  'CON',
];
for (const hint of hints) {
  const slug = slugFromHint(hint);
  cases.push({ case: `${SLUG_TEST}: ${JSON.stringify(hint)}`, kind: 'slug', hint: hint ?? '', recorded: { slug, nameError: worktreeNameError(slug) } });
}
cases.push({ case: `${SLUG_TEST}: the length bound`, kind: 'bound', recorded: { max: SLUG_MAX_LENGTH } });

const taken = ['fix', 'fix-2'];
cases.push({ case: `${UNIQUE_TEST}: fix`, kind: 'unique', base: 'fix', taken, recorded: { slug: uniqueSlug('fix', (s) => taken.includes(s)) } });
const base = 'y'.repeat(SLUG_MAX_LENGTH);
cases.push({ case: `${UNIQUE_TEST}: a full-length base`, kind: 'unique', base, taken: [base], recorded: { slug: uniqueSlug(base, (s) => s === base) } });
// Every non-random candidate is taken: the slug ends in a random suffix, so what is recorded is its shape.
const random = uniqueSlug('busy', (slug) => !/^busy-[0-9a-f]{8}$/.test(slug));
cases.push({ case: `${UNIQUE_TEST}: random suffix`, kind: 'random', base: 'busy', pattern: '^busy-[0-9a-f]{8}$', recorded: { matches: /^busy-[0-9a-f]{8}$/.test(random) } });

{
  const registry = createRootCleanupRegistry();
  const register = (name, cleanup) => registry.register(name, cleanup);
  const names = registerWorktreeCacheCleanups(register);
  registerWorktreeCacheCleanups(register);
  cases.push({
    case: 'registerWorktreeCacheCleanups registers each cleanup exactly once',
    kind: 'cleanups',
    recorded: { names, registered: registry.names(), all: Object.keys(WORKTREE_CACHE_CLEANUPS) },
  });
}
{
  const registry = createRootCleanupRegistry();
  registerWorktreeCacheCleanups((name, cleanup) => registry.register(name, cleanup));
  const results = await registry.run(process.platform === 'win32' ? 'C:\\no\\such\\worktree' : '/no/such/worktree');
  cases.push({ case: 'registered cleanups report ok with { removed, kept } for an unknown root', kind: 'cleanupRun', recorded: { results } });
}

const excluded = {
  [`${SLUG_TEST}: ${JSON.stringify('  Café crème: déjà vu  ')}`]:
    'DIFFERENCE: Node folds accents (NFKD, combining marks dropped) and gives "cafe-creme-deja-vu"; the core treats ' +
    'every non-ASCII letter as a separator and gives "caf-cr-me-d-j-vu"',
  'registerWorktreeCacheCleanups registers each cleanup exactly once':
    'DIFFERENCE: Node registers the cache cleanups turn-worktree-snapshots, turn-snapshot-store and code-graph; the ' +
    "core composes its worktree store with one root cleanup, \"folder release\" (compose_flip.rs), and none of Node's three",
  'registered cleanups report ok with { removed, kept } for an unknown root':
    "DIFFERENCE: the core has none of Node's three cache cleanups to run (see the case above)",
};

const finalDir = join(FIXTURES_ROOT, 'worktree-names-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's worktree names at ${NODE_COMMIT}, per case of ${RECORDER}`, tests: TESTS, cases });
writeSetManifest(stage, {
  set: 'worktree-names-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared:
      "slug: the slug and its name error; bound: the length bound; unique: the unique slug; random: whether the slug matches the test's pattern (the suffix is random in Node)",
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`worktree-names-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);
