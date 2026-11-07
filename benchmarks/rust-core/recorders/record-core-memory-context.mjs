// Records the user-curated core-memory block a new session gets (`loadCoreMemoryContext` of
// `session-runtime/cwd-plugins/core-memory-context.mjs`) from today's Node product.
// Usage: node record-core-memory-context.mjs --tree <mixdog checkout> --out <golden.json>
// Every case runs in a child process whose data, home, app-data and backup directories are fresh
// temp directories (set before any Mixdog import) and whose MIXDOG_* variables are the case's own.
// The checkout is only imported from, never written.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];

if (process.argv.includes('--child')) {
  const tree = arg('--tree');
  const src = (p) => pathToFileURL(join(tree, 'src', p)).href;
  const { createCoreMemoryContext } = await import(src('session-runtime/cwd-plugins/core-memory-context.mjs'));
  const { clean } = await import(src('runtime/shared/clean.mjs'));
  const { featureEnvOverride } = await import(src('runtime/agent/orchestrator/runtime-core/config-helpers.mjs'));
  const job = JSON.parse(arg('--job'));
  const make = (cwd, agentId) =>
    createCoreMemoryContext({
      getCurrentCwd: () => cwd,
      getMemoryAgentId: () => agentId,
      bootProfile: () => {},
      clean,
      cfgMod: {},
    });
  let result;
  if (job.format) {
    result = { expected: make('', '').formatCoreMemoryLines({ userLines: job.format }) };
  } else {
    result = {
      expected: await make(job.cwd, job.agentId).loadCoreMemoryContext(),
      optsOut: featureEnvOverride('MIXDOG_BOOT_CORE_MEMORY') === false,
    };
  }
  console.log(JSON.stringify(result));
  process.exit(0);
}

const entry = (id, summary, extra = {}) => ({ id, indexRevision: null, summary, projectId: null, agentId: null, updatedAt: 0, ...extra });
const file = (curated, extra = {}) => JSON.stringify({ version: 1, revision: 3, updatedAt: 1700000000000, curated, ...extra });
const korean = (index) => `${index} ${'한글 지침 문장 '.repeat(120)}`;
const mixedWidth = (index) => `${index} ${'abc 한글 😀 words '.repeat(400)}`;
// One line whose block is exactly `bytes` long: "- " plus the text.
const exactly = (bytes) => [entry(1, 'x'.repeat(bytes - 2))];
const curated = [
  entry(1, 'Reviewer checks the changelog.', { agentId: 'reviewer' }),
  entry(1, 'Alpha uses tabs.', { projectId: 'agent-pool-alpha' }),
  entry(2, 'Answer in Korean.'),
  entry(1, 'Address the user politely.'),
  entry(1, 'Writer drafts releases.', { agentId: 'writer' }),
  entry(1, 'Beta uses spaces.', { projectId: 'beta' }),
  entry(7, 'Pinned to a project and an agent.', { projectId: 'agent-pool-alpha', agentId: 'writer' }),
  entry(2, 'Writer prefers bullet lists.', { agentId: 'writer' }),
];
const project = { marker: 'agent-pool-alpha', cwd: 'project/src/deep' };
const none = { marker: null, cwd: 'project/src/deep' };

const cases = [
  { name: 'no snapshot file', file: null, ...project, agentId: '' },
  { name: 'common, project and agent order for the reviewer', file: file(curated), ...project, agentId: 'reviewer' },
  { name: 'no agent gets common then project', file: file(curated), ...project, agentId: '' },
  { name: 'the writer', file: file(curated), ...project, agentId: 'writer' },
  { name: 'an agent with no entries', file: file(curated), ...project, agentId: 'nobody' },
  { name: 'agent id with surrounding spaces', file: file(curated), ...project, agentId: '  reviewer ' },
  { name: 'no marker: common only', file: file(curated), ...none, agentId: '' },
  { name: 'marker names another project', file: file(curated), marker: 'beta', cwd: 'project/src/deep', agentId: '' },
  { name: 'marker COMMON in capitals', file: file(curated), marker: 'COMMON', cwd: 'project/src/deep', agentId: '' },
  { name: 'marker with only spaces', file: file(curated), marker: '  \n', cwd: 'project/src/deep', agentId: '' },
  { name: 'marker with spaces around the id', file: file(curated), marker: '  agent-pool-alpha\n', cwd: 'project/src/deep', agentId: '' },
  { name: 'marker NUL-filled', file: file(curated), marker: '\u0000\u0000\u0000', cwd: 'project/src/deep', agentId: '' },
  { name: 'cwd is the marker folder itself', file: file(curated), marker: 'agent-pool-alpha', cwd: 'project', agentId: '' },
  { name: 'entries listed out of id order', file: file([entry(9, 'nine'), entry(2, 'two'), entry(5, 'five', { projectId: 'agent-pool-alpha' }), entry(1, 'one', { projectId: 'agent-pool-alpha' })]), ...project, agentId: '' },
  { name: 'equal ids keep the file order', file: file([entry(1, 'first'), entry(1, 'second'), entry(1, 'third')]), ...project, agentId: '' },
  { name: 'duplicates differ only by case', file: file([entry(1, 'Use Tabs.'), entry(2, 'use tabs.'), entry(3, 'USE TABS.'), entry(4, 'Use tabs')]), ...project, agentId: '' },
  { name: 'duplicates across scopes', file: file([entry(1, 'Same rule'), entry(1, 'same RULE', { projectId: 'agent-pool-alpha' }), entry(1, 'Same Rule', { agentId: 'reviewer' })]), ...project, agentId: 'reviewer' },
  { name: 'lower-casing of non-ASCII keys', file: file([entry(1, 'Ünï Straße ΣΑΣ İstanbul'), entry(2, 'ünï straße σας i̇stanbul'), entry(3, 'ÜNÏ STRASSE ΣΑΣ')]), ...project, agentId: '' },
  { name: 'whitespace inside a summary is one space', file: file([entry(1, 'tabs\tand\nnewlines\r\n and   spaces'), entry(2, '\u00a0nbsp\u2003em\ufeff')]), ...project, agentId: '' },
  { name: 'entries with no text are dropped', file: file([entry(1, '   '), entry(2, ''), entry(3, 'kept'), entry(4, '\n\t')]), ...project, agentId: '' },
  { name: 'empty snapshot', file: file([]), ...project, agentId: '' },
  { name: 'snapshot without a curated list', file: JSON.stringify({ version: 1, revision: 1 }), ...project, agentId: '' },
  { name: 'snapshot of another version', file: file(curated, { version: 2 }), ...project, agentId: '' },
  { name: 'snapshot that is not JSON', file: '{"version":1,', ...project, agentId: '' },
  { name: 'snapshot that is an empty file', file: '', ...project, agentId: '' },
  { name: 'snapshot with a byte-order mark', file: `\ufeff${file(curated)}`, ...project, agentId: '' },
  // Hand-edited and older files: every field optional, spelled either way, of any JSON type.
  ...[
    ['entries with only a summary', '{"version":1,"curated":[{"summary":"bare"},{"summary":"also bare"}]}'],
    ['no revision, time or version-adjacent fields', '{"version":1,"curated":[{"id":2,"summary":"two"},{"id":1,"summary":"one"}]}'],
    ['snake-case spellings', '{"version":1,"curated":[{"id":1,"summary":"scoped","project_id":"agent-pool-alpha","updated_at":5,"index_revision":"r"},{"id":1,"summary":"agent","agent_id":"reviewer"},{"id":2,"summary":"other","project_id":"beta"}]}'],
    ['camel case wins over snake case', '{"version":1,"curated":[{"id":1,"summary":"a","projectId":"beta","project_id":"agent-pool-alpha"},{"id":2,"summary":"b","projectId":"agent-pool-alpha","project_id":"beta"}]}'],
    ['null camel case falls through to snake case', '{"version":1,"curated":[{"id":1,"summary":"a","projectId":null,"project_id":"agent-pool-alpha"},{"id":2,"summary":"b","agentId":null,"agent_id":"reviewer"}]}'],
    ['empty camel case does not fall through', '{"version":1,"curated":[{"id":1,"summary":"a","projectId":"","project_id":"agent-pool-alpha"},{"id":2,"summary":"b","agentId":"  ","agent_id":"reviewer"}]}'],
    ['project and agent ids with spaces', '{"version":1,"curated":[{"id":1,"summary":"p","projectId":"  agent-pool-alpha\\n"},{"id":2,"summary":"a","agentId":" reviewer\\t"}]}'],
    ['numeric project and agent ids', '{"version":1,"curated":[{"id":1,"summary":"num","projectId":5},{"id":2,"summary":"agent","agentId":7}]}'],
    ['project and agent ids of other types', '{"version":1,"curated":[{"id":1,"summary":"t","projectId":true},{"id":2,"summary":"o","projectId":{}},{"id":3,"summary":"l","agentId":["reviewer"]},{"id":4,"summary":"z","projectId":0}]}'],
    ['ids as strings, null, booleans and arrays', '{"version":1,"curated":[{"id":"3","summary":"s3"},{"id":"abc","summary":"nan"},{"id":null,"summary":"null"},{"id":true,"summary":"true"},{"id":[2],"summary":"arr"},{"id":" 4 ","summary":"padded"},{"id":-1,"summary":"neg"},{"id":"0x10","summary":"hex"},{"id":1e1,"summary":"exp"}]}'],
    ['summaries of other types', '{"version":1,"curated":[{"id":1,"summary":42},{"id":2,"summary":true},{"id":3,"summary":false},{"id":4,"summary":0},{"id":5,"summary":{}},{"id":6,"summary":["a","b"]},{"id":7,"summary":null},{"id":8},{"id":9,"summary":[]},{"id":10,"summary":[null,"x"]},{"id":11,"summary":1.5},{"id":12,"summary":-0.0}]}'],
    ['rows that are not objects', '{"version":1,"curated":[null,"text",7,true,[],[{"summary":"nested"}],{"summary":"real"}]}'],
    ['curated is an object', '{"version":1,"curated":{"0":{"summary":"x"}}}'],
    ['curated is a string', '{"version":1,"curated":"x"}'],
    ['curated is null', '{"version":1,"curated":null}'],
    ['version 1.0 spelled as a float', '{"version":1.0,"curated":[{"summary":"float version"}]}'],
    ['version 1e0', '{"version":1e0,"curated":[{"summary":"exponent version"}]}'],
    ['version as a string', '{"version":"1","curated":[{"summary":"x"}]}'],
    ['version true', '{"version":true,"curated":[{"summary":"x"}]}'],
    ['version missing', '{"curated":[{"summary":"x"}]}'],
    ['version null', '{"version":null,"curated":[{"summary":"x"}]}'],
    ['top level is an array', '[{"version":1,"curated":[{"summary":"x"}]}]'],
    ['top level is null', 'null'],
    ['top level is a number', '1'],
    ['revision and time of odd types', '{"version":1,"revision":"x","updatedAt":[],"curated":[{"summary":"odd"}]}'],
    ['extra fields and duplicate keys', '{"version":1,"extra":{"a":1},"curated":[{"summary":"first","summary":"last","note":1}]}'],
    ['summaries with unicode whitespace', '{"version":1,"curated":[{"id":1,"summary":"\\ufeff a\\u00a0\\u2003b\\u2028c "},{"id":2,"summary":"\\u0085 kept"}]}'],
    ['entry text equal after collapsing', '{"version":1,"curated":[{"id":1,"summary":"a  b"},{"id":2,"summary":"A\\nB"}]}'],
  ].map(([name, text]) => ({ name: `tolerant read: ${name}`, file: text, ...project, agentId: 'reviewer' })),
  { name: 'exactly at the byte budget', file: file(exactly(32 * 1024)), ...project, agentId: '' },
  { name: 'one byte over the byte budget', file: file(exactly(32 * 1024 + 1)), ...project, agentId: '' },
  { name: 'a single unbroken line over the budget', file: file(exactly(40000)), ...project, agentId: '' },
  { name: 'many short lines over the budget', file: file(Array.from({ length: 4000 }, (_, i) => entry(i + 1, `rule number ${i} ends here`))), ...project, agentId: '' },
  { name: 'korean lines over the budget', file: file(Array.from({ length: 40 }, (_, i) => entry(i + 1, korean(i)))), ...project, agentId: '' },
  { name: 'mixed width text over the budget', file: file(Array.from({ length: 8 }, (_, i) => entry(i + 1, mixedWidth(i)))), ...project, agentId: '' },
  ...[0, 1, 2, 3].map((pad) => ({ name: `three-byte text cut at offset ${pad}`, file: file([entry(1, 'a'.repeat(pad)), entry(2, '가'.repeat(11000))]), ...project, agentId: '' })),
  ...[0, 1, 2, 3].map((pad) => ({ name: `four-byte text cut at offset ${pad}`, file: file([entry(1, 'a'.repeat(pad)), entry(2, '😀'.repeat(8300))]), ...project, agentId: '' })),
  { name: 'cut falls on a space', file: file([entry(1, `${'a'.repeat(32760)} bb cccccccccccc`)]), ...project, agentId: '' },
  { name: 'cut leaves a word fragment', file: file([entry(1, `${'a '.repeat(16380)}zzzzzzzzzzzzzzzzzzzz`)]), ...project, agentId: '' },
  { name: 'cut with a replacement character in the text', file: file([entry(1, `${'a '.repeat(8000)}\ufffd\ufffd ${'b '.repeat(9000)}`)]), ...project, agentId: '' },
  ...['0', 'false', 'no', 'off', 'No', 'OFF', ' off ', 'False'].map((value) => ({ name: `boot core memory switched off as ${JSON.stringify(value)}`, file: file(curated), ...project, agentId: '', env: { MIXDOG_BOOT_CORE_MEMORY: value } })),
  ...['1', 'true', 'yes', 'on', '', ' ', 'maybe', '2', 'nope'].map((value) => ({ name: `boot core memory kept for ${JSON.stringify(value)}`, file: file(curated), ...project, agentId: '', env: { MIXDOG_BOOT_CORE_MEMORY: value } })),
  { name: 'format: dedup, blank lines and spacing', format: ['  a  b ', 'A B', '', '   ', 'c\td', 'C\tD', 'e'] },
  { name: 'format: JavaScript whitespace', format: ['\u00a0\ufeffx\u2028y\u3000', '\u0085z', 'x y'] },
  { name: 'format: nothing', format: [] },
];

const work = mkdtempSync(join(tmpdir(), 'corectx-'));
const results = [];
for (const [index, c] of cases.entries()) {
  const dirs = Object.fromEntries(['data', 'home', 'appdata', 'localappdata', 'backups', 'tmp'].map((n) => [n, join(work, `${n}-${index}`)]));
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MIXDOG_')));
  Object.assign(env, {
    MIXDOG_DATA_DIR: dirs.data,
    MIXDOG_HOME: dirs.home,
    MIXDOG_USER_DATA_BACKUP_ROOT: dirs.backups,
    MIXDOG_SKIP_USER_DATA_BACKUP: '1',
    MIXDOG_QUIET_MEMORY_LOG: '1',
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    APPDATA: dirs.appdata,
    LOCALAPPDATA: dirs.localappdata,
    TEMP: dirs.tmp,
    TMP: dirs.tmp,
    TMPDIR: dirs.tmp,
  }, c.env ?? {});
  let job;
  if (c.format) {
    job = { format: c.format };
  } else {
    if (c.file !== null) writeFileSync(join(dirs.data, 'core-memory.json'), c.file);
    const cwd = join(dirs.data, '..', `cwd-${index}`, ...c.cwd.split('/'));
    mkdirSync(cwd, { recursive: true });
    if (c.marker !== null) {
      const markerDir = join(dirs.data, '..', `cwd-${index}`, 'project', '.mixdog');
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(join(markerDir, 'project.id'), c.marker);
    }
    job = { cwd, agentId: c.agentId };
  }
  const run = spawnSync(process.execPath, [process.argv[1], '--child', '--tree', arg('--tree'), '--job', JSON.stringify(job)], { env, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`${c.name}: ${run.stderr}`);
  const seen = JSON.parse(run.stdout.trim().split('\n').at(-1));
  const row = { name: c.name };
  if (c.format) row.format = c.format;
  else Object.assign(row, { file: c.file, marker: c.marker, cwd: c.cwd, agentId: c.agentId, env: c.env ?? {}, optsOut: seen.optsOut });
  row.expected = seen.expected;
  results.push(row);
}
writeFileSync(arg('--out'), `${JSON.stringify({ node: process.version, cases: results }, null, 2)}\n`);
rmSync(work, { recursive: true, force: true });
console.log(`recorded ${results.length} cases`);
