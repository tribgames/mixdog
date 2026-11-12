#!/usr/bin/env node
// The slug of a managed worktree (src/runtime/shared/worktrees/slug.mjs): the folder name and branch component derived from the
// task's first message, and the unique variant when a name is taken. The REAL `slugFromHint` / `uniqueSlug` /
// `worktreeNameError` of the tree. Recorded per hint: the slug and whether `worktreeNameError` accepts it; per unique case: the
// base, the names taken and the answer. The random-suffix answer (after fifty numeric candidates) is recorded by its shape
// (it must be `<base>-<8 lowercase hex digits>`), the exact digits being random.
// Rust `mixdog_scm::worktree::names::{slug_from_hint, unique_slug, name_error}` must answer the same.
//   node benchmarks/rust-core/recorders/record-worktree-slug.mjs [--tree <dir>]
// Output: native/core/fixtures/worktree-slug/golden.json.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const finalDir = join(FIXTURES_ROOT, 'worktree-slug');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-worktree-slug.mjs';
const at = (path) => import(pathToFileURL(join(tree, ...path.split('/'))).href);

const { SLUG_MAX_LENGTH, slugFromHint, uniqueSlug } = await at('src/runtime/shared/worktrees/slug.mjs');
const { worktreeNameError } = await at('src/runtime/shared/worktrees/contract.mjs');

const hints = [
  'Fix the login page!',
  '  Café crème: déjà vu  ',
  '../../etc/passwd',
  '로그인 버그 고치기',
  '',
  'NUL',
  'com1',
  'branch.lock',
  'implement the new billing export pipeline with retries and audit logging',
  'x'.repeat(100),
  'a',
  '___',
  'CON',
  'prn',
  'LPT9 printer',
  'ÀÉÎÕÜ ñ naïve Ångström',
  'ｆｕｌｌｗｉｄｔｈ ＡＢＣ ①②',
  'Ⅻ ﬁnal ﬂow',
  'İstanbul Ünïcode ǅ',
  'e\u0301cole a\u0300 la carte',
  `${'a'.repeat(39)} bb`,
  `${'a'.repeat(38)} b`,
  `${'ab-'.repeat(20)}`,
  'tab\tand\nnewline  words',
  '😀 emoji only 😀',
];
const slugs = hints.map((hint) => {
  const slug = slugFromHint(hint);
  return { hint, slug, valid: worktreeNameError(slug) === null };
});

const takenCases = [
  { base: 'fix', taken: ['fix', 'fix-2'] },
  { base: 'y'.repeat(SLUG_MAX_LENGTH), taken: ['y'.repeat(SLUG_MAX_LENGTH)] },
  { base: 'fix', taken: [] },
  { base: 'bad..name', taken: [] },
  { base: 'bad..name', taken: ['task', 'task-2', 'task-3'] },
  { base: '-lead', taken: [] },
  { base: 'x'.repeat(65), taken: [] },
  { base: 'z'.repeat(39), taken: ['z'.repeat(39), `${'z'.repeat(38)}-2`] },
  { base: 'a-', taken: ['a-'] },
];
const unique = takenCases.map(({ base, taken }) => {
  const slug = uniqueSlug(base, (candidate) => taken.includes(candidate));
  return { base, taken, slug, valid: worktreeNameError(slug) === null };
});

const randomBase = 'busy';
const random = uniqueSlug(randomBase, (candidate) => !/^busy-[0-9a-f]{8}$/.test(candidate));
if (!/^busy-[0-9a-f]{8}$/.test(random)) throw new Error(`random suffix ${random}`);
const randomBy = { base: randomBase, takes: 'only <base>-<8 lowercase hex digits>', length: random.length, valid: worktreeNameError(random) === null };
const longBase = 'q'.repeat(SLUG_MAX_LENGTH);
const longRandom = uniqueSlug(longBase, (candidate) => !/^q{31}-[0-9a-f]{8}$/.test(candidate));
if (!/^q{31}-[0-9a-f]{8}$/.test(longRandom)) throw new Error(`long random suffix ${longRandom}`);
const randomLong = { base: longBase, takes: 'only <31 q>-<8 lowercase hex digits>', length: longRandom.length, valid: worktreeNameError(longRandom) === null };

writeJson(join(stage, 'golden.json'), { slugMax: SLUG_MAX_LENGTH, slugs, unique, random: [randomBy, randomLong] });
writeSetManifest(stage, {
  set: 'worktree-slug',
  recorder,
  command: `node ${recorder} --tree <tree>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    exclusions: 'The random suffix digits are not recorded (random); the recording states the shape the answer must have.',
  },
});
commitStage(stage, finalDir);
