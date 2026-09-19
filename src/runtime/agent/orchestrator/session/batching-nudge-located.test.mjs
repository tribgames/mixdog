import test from 'node:test';
import assert from 'node:assert/strict';
import { observeToolBatchForNudge } from './batching-nudge.mjs';

const tools = [
  { name: 'read', annotations: { readOnlyHint: true } },
  { name: 'grep', annotations: { readOnlyHint: true } },
  { name: 'glob', annotations: { readOnlyHint: true } },
  { name: 'edit', annotations: { readOnlyHint: false } },
];
let nextId = 0;
const call = (name, args) => ({ id: `${name}-${++nextId}`, name, arguments: args });
const round = (sessionRef, calls, results) =>
  observeToolBatchForNudge({ sessionRef, calls, results: results ?? calls.map(() => 'ok'), tools });

const grepResult = [
  '# src/auth.mjs:2 [lines 1-4]',
  '1→export function login(user) {',
  "2→  console.log('login', user);",
  '# src/cart.mjs:4 [lines 2-6]',
  "4→  console.log('added', item.id);",
  '# Additional matches',
  "src/report.mjs:3:    console.log('row', row.id); [lines 1-5]",
].join('\n');

test('a single-file read right after grep located several files hands the located set back as one read', () => {
  const session = { provider: 'antigravity-oauth' };
  assert.equal(round(session, [call('grep', { pattern: 'console\\.log\\(', path: 'src' })], [grepResult]), null);
  const nudge = round(session, [call('read', { file_path: 'src/auth.mjs' })], ['1→export function login(user) {']);
  assert.equal(nudge.trigger, 'located_sites');
  assert.match(nudge.text, /3 sites in 3 files were located; this round read one file/);
  assert.match(nudge.text, /one read call: read \[/);
  const entries = JSON.parse(/read (\[.*\]) — then/.exec(nudge.text)[1]);
  assert.deepEqual(entries, [
    { file_path: 'src/auth.mjs', offset: 1, limit: 44 },
    { file_path: 'src/cart.mjs', offset: 1, limit: 46 },
    { file_path: 'src/report.mjs', offset: 1, limit: 45 },
  ]);
  assert.match(nudge.text, /then every edit in one response/);
  // The read after grep was an ordered step: the serial streak is untouched.
  assert.deepEqual(session.batchingNudge.serial, ['read']);
});

test('a provider whose read schema takes path strings only gets one read per file in the same response', () => {
  const session = { provider: 'grok-oauth' };
  round(session, [call('grep', { pattern: 'console\\.log\\(', path: 'src' })], [grepResult]);
  const nudge = round(session, [call('read', { file_path: ['src/cart.mjs'] })]);
  assert.equal(nudge.trigger, 'located_sites');
  assert.match(
    nudge.text,
    /one read per window, all in the same response: src\/auth\.mjs offset:1 limit:44, src\/cart\.mjs offset:1 limit:46, src\/report\.mjs offset:1 limit:45/
  );
  assert.doesNotMatch(nudge.text, /\[\{/);
});

test('sites far apart in one file become separate windows, never the whole file; >10 windows split into calls', () => {
  const session = { provider: 'antigravity-oauth' };
  const spread = [
    '# src/orders.mjs:100 [lines 98-102]',
    '# src/orders.mjs:480 [lines 478-482]',
    '# src/orders.mjs:820 [lines 818-822]',
    '# src/users.mjs:7 [lines 5-9]',
  ].join('\n');
  round(session, [call('grep', { pattern: 'legacyFetch', path: 'src' })], [spread]);
  const nudge = round(session, [call('read', { file_path: 'src/orders.mjs', offset: 90, limit: 30 })]);
  const entries = JSON.parse(/read (\[.*\]) — then/.exec(nudge.text)[1]);
  assert.deepEqual(entries, [
    { file_path: 'src/orders.mjs', offset: 78, limit: 65 },
    { file_path: 'src/orders.mjs', offset: 458, limit: 65 },
    { file_path: 'src/orders.mjs', offset: 798, limit: 65 },
    { file_path: 'src/users.mjs', offset: 1, limit: 49 },
  ]);

  const many = { provider: 'antigravity-oauth' };
  const anchors = Array.from(
    { length: 12 },
    (_, i) => `# src/f${i}.mjs:${300 + i * 100} [lines ${298 + i * 100}-${302 + i * 100}]`
  ).join('\n');
  round(many, [call('grep', { pattern: 'x', path: 'src' })], [anchors]);
  const split = round(many, [call('read', { file_path: 'src/f3.mjs' })]);
  assert.match(split.text, /2 read calls in the same response: read \[.*\]; read \[.*\]/);
});

test('code_graph symbol rows locate sites through their (Lstart-end) ranges', () => {
  const session = { provider: 'antigravity-oauth' };
  const outline = [
    '# symbols src/a.mjs',
    'export function alpha (L10-40)  function alpha()',
    'function beta (L50-60)  function beta()',
    '# symbols src/b.mjs',
    'export function gamma (L5-9)  function gamma()',
  ].join('\n');
  round(session, [call('code_graph', { mode: 'symbols', files: ['src/a.mjs', 'src/b.mjs'] })], [outline]);
  const nudge = round(session, [call('read', { file_path: 'src/a.mjs' })]);
  assert.equal(nudge.trigger, 'located_sites');
  const entries = JSON.parse(/read (\[.*\]) — then/.exec(nudge.text)[1]);
  assert.deepEqual(entries, [
    { file_path: 'src/a.mjs', offset: 1, limit: 100 },
    { file_path: 'src/b.mjs', offset: 1, limit: 49 },
  ]);
});

test('a search after a read that took nothing from it is reported as late locating; one fed by the read is not', () => {
  const late = { provider: 'antigravity-oauth' };
  round(late, [call('read', { file_path: 'src/auth.mjs' })], ['1→export function login(user) {\n2→  return user;']);
  const nudge = round(late, [call('glob', { pattern: 'src/*.mjs' })], ['src/auth.mjs\nsrc/cart.mjs']);
  assert.equal(nudge.trigger, 'late_locating');
  assert.deepEqual(nudge.tools, ['glob']);
  assert.match(nudge.text, /could have run before the last read/);

  const fed = { provider: 'antigravity-oauth' };
  round(fed, [call('read', { file_path: 'src/auth.mjs' })], ['1→import { verifyToken } from "./token.mjs";']);
  assert.equal(
    round(
      fed,
      [call('grep', { pattern: 'verifyToken', path: 'src' })],
      ['src/token.mjs:3: export function verifyToken']
    ),
    null
  );

  const afterEdit = { provider: 'antigravity-oauth' };
  round(
    afterEdit,
    [call('edit', { file_path: 'src/auth.mjs', old_string: 'a', new_string: 'b' })],
    ['Updated src/auth.mjs (1 replacement)']
  );
  assert.equal(round(afterEdit, [call('grep', { pattern: 'console\\.log', path: 'src' })], ['(no matches)']), null);
});

test('reading the located files together, or a file grep did not locate, is not nudged', () => {
  const batched = { provider: 'antigravity-oauth' };
  round(batched, [call('grep', { pattern: 'console\\.log\\(', path: 'src' })], [grepResult]);
  assert.equal(round(batched, [call('read', { file_path: ['src/auth.mjs', 'src/cart.mjs', 'src/report.mjs'] })]), null);

  const unrelated = { provider: 'antigravity-oauth' };
  round(unrelated, [call('grep', { pattern: 'console\\.log\\(', path: 'src' })], [grepResult]);
  assert.equal(round(unrelated, [call('read', { file_path: 'src/logger.mjs' })]), null);

  const single = { provider: 'antigravity-oauth' };
  round(single, [call('grep', { pattern: 'login', path: 'src' })], ['# src/auth.mjs:2 [lines 1-4]\n2→login']);
  assert.equal(round(single, [call('read', { file_path: 'src/auth.mjs' })]), null);
});

test('bare path lists from glob count as located files without windows', () => {
  const session = { provider: 'antigravity-oauth' };
  round(session, [call('glob', { pattern: 'src/*.mjs' })], ['src/auth.mjs\nsrc/cart.mjs\nsrc/util.mjs']);
  const nudge = round(session, [call('read', { file_path: 'src/util.mjs' })]);
  assert.equal(nudge.trigger, 'located_sites');
  const entries = JSON.parse(/read (\[.*\]) — then/.exec(nudge.text)[1]);
  assert.deepEqual(entries, [
    { file_path: 'src/auth.mjs' },
    { file_path: 'src/cart.mjs' },
    { file_path: 'src/util.mjs' },
  ]);
});
