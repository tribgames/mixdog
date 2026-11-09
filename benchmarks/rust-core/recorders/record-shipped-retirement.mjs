#!/usr/bin/env node
// Golden twin of the boot retirement of a user's untouched copies of shipped definitions: Node's real
// `ensureStandaloneEnvironment` (session-runtime/services/seeds.mjs, with runtime/shared/shipped-definitions.mjs) over
// representative states, replayed by `mixdog-core-config` `workflow/retire.rs`.
//
// The package root of every state holds the REAL shipped files of the commit (blobs of `--commit`) and its real
// defaults/shipped-history.json; an "old copy" is a real earlier version of that item taken from git history whose hash the
// history lists. Each state records the data dir before, the data dir tree afterwards (every file's bytes, the marker
// included; backup folder names have their timestamp masked), what the function threw, and what it printed.
//
//   node benchmarks/rust-core/recorders/record-shipped-retirement.mjs --tree <git checkout at --commit, with node_modules> --commit <40-hex>
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { FIXTURES_ROOT, commitCheckoutIdentity, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const commit = cli.get('commit');
const identity = commitCheckoutIdentity(tree, commit);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'shipped-retirement');
const stage = stageSet(outDir);

const { ensureStandaloneEnvironment } = await importFrom(tree, 'src/session-runtime/services/seeds.mjs');
const shipped = await importFrom(tree, 'src/runtime/shared/shipped-definitions.mjs');
const { hashDefinition, hashText, hashTree, packDefinitionFrom, historyStamp, HISTORY_MARKER_FILE, isIgnorableStray } = shipped;

const gitBuf = (...a) => execFileSync('git', ['-C', tree, ...a], { maxBuffer: 1 << 28 });
const gitLines = (...a) => gitBuf(...a).toString('utf8').split('\n').filter(Boolean);
/** rel path -> Buffer of the file, or of every file below the folder, at `at`. */
function filesAt(at, path) {
  const out = new Map();
  for (const full of gitBuf('ls-tree', '-r', '--name-only', '-z', at, '--', path).toString('utf8').split('\0').filter(Boolean)) {
    out.set(full === path ? basename(path) : full.slice(path.length + 1), gitBuf('show', `${at}:${full}`));
  }
  return out;
}
const size = (files) => [...files.values()].reduce((sum, buf) => sum + buf.length, 0);
const history = JSON.parse(gitBuf('show', `${commit}:src/defaults/shipped-history.json`).toString('utf8'));

const KINDS = {
  skills: { prefix: 'src/defaults/skills', dest: 'skills', key: 'skills', hash: (files) => hashTree([...files]), max: 16000 },
  agents: { prefix: 'src/agents', dest: 'agents', key: 'agents', entry: 'AGENT.md', allowed: ['AGENT.md', 'agent.json'], max: 9000 },
  workflows: { prefix: 'src/workflows', dest: 'workflows', key: 'workflows', entry: 'WORKFLOW.md', allowed: ['WORKFLOW.md'], max: 9000 },
  outputStyles: { prefix: 'src/output-styles', dest: 'output-styles', key: 'outputStyles', file: true, max: 9000 },
  orchestration: { prefix: 'src/orchestration', dest: 'orchestration', key: 'orchestration', file: true, max: 9000 },
};
for (const kind of Object.values(KINDS)) {
  if (kind.entry) kind.hash = (files, name) => {
    const text = (n) => (files.has(n) ? files.get(n).toString('utf8') : null);
    const definition = packDefinitionFrom(text, kind.entry, name);
    return definition ? hashDefinition(definition) : null;
  };
  if (kind.file) kind.hash = (files) => hashText([...files.values()][0]);
}

/** Real items of a kind with an earlier version the history lists: [{ name, current, old }] (smallest first). */
function pick(kind, count) {
  const names = [...new Set(gitLines('ls-tree', '--name-only', commit, `${kind.prefix}/`).map((p) => basename(p)))].sort();
  const found = [];
  for (const name of names) {
    const path = `${kind.prefix}/${name}`;
    const current = filesAt(commit, path);
    if (!current.size || size(current) > kind.max) continue;
    const currentHash = kind.hash(current, name);
    const listed = history[kind.key][name] ?? [];
    for (const at of gitLines('log', '--format=%H', '--', path)) {
      const old = filesAt(at, path);
      if (!old.size || size(old) > kind.max) continue;
      const hash = kind.hash(old, name);
      if (!hash || hash === currentHash || !listed.includes(hash)) continue;
      if (kind.allowed && !(old.has(kind.entry) && [...old.keys()].every((n) => kind.allowed.includes(n) || isIgnorableStray(n)))) continue;
      found.push({ name, current, old, size: size(current) + size(old) });
      break;
    }
  }
  found.sort((a, b) => a.size - b.size || (a.name < b.name ? -1 : 1));
  if (found.length < count) throw new Error(`${kind.key}: only ${found.length} items with an earlier shipped version`);
  return found.slice(0, count);
}
const picks = Object.fromEntries(Object.entries(KINDS).map(([key, kind]) => [key, pick(kind, 2)]));

// ---- the package root: the real shipped files of the picked items, the real history and plugin manifest.
const world = new Map();
world.set('defaults/shipped-history.json', gitBuf('show', `${commit}:src/defaults/shipped-history.json`));
world.set('defaults/plugin.json', gitBuf('show', `${commit}:src/defaults/plugin.json`));
const rootDirOf = (kind) => (kind.dest === 'skills' ? 'defaults/skills' : kind.dest);
for (const [key, items] of Object.entries(picks)) {
  for (const item of items) for (const [rel, buf] of item.current) world.set(KINDS[key].file ? `${rootDirOf(KINDS[key])}/${rel}` : `${rootDirOf(KINDS[key])}/${item.name}/${rel}`, buf);
}

const put = (data, kind, item, which, edit = (rel, buf) => buf) => {
  for (const [rel, buf] of item[which]) data.set(KINDS[kind].file ? `${KINDS[kind].dest}/${rel}` : `${KINDS[kind].dest}/${item.name}/${rel}`, edit(rel, buf));
};
const entryOf = (kind, item, rel) => (KINDS[kind].file ? true : rel === (KINDS[kind].entry ?? 'SKILL.md'));
const crlf = (rel, buf) => (/\.(md|json)$/.test(rel) ? Buffer.from(buf.toString('utf8').replace(/\n/g, ' \r\n')) : buf);
const edited = (kind, item) => (rel, buf) => (entryOf(kind, item, rel) ? Buffer.concat([buf, Buffer.from('\nEdited by the user.\n')]) : buf);
const ALL = Object.keys(KINDS);
const everyKind = (data, which, index = 0, edit = () => (rel, buf) => buf) => {
  for (const kind of ALL) put(data, kind, picks[kind][index], which, edit(kind, picks[kind][index]));
};
const [stampOf] = [(overrides = new Map()) => {
  const base = mkdtempSync(join(work, 'stamp-'));
  materialize(join(base, 'package'), overrides);
  return historyStamp(join(base, 'package'));
}];

const work = mkdtempSync(join(tmpdir(), 'shipped-retirement-'));
function materialize(dir, overrides = new Map(), data = false) {
  const files = data ? overrides : new Map([...world, ...overrides]);
  mkdirSync(dir, { recursive: true });
  for (const [rel, buf] of files) {
    if (buf === null) continue;
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), buf);
  }
}

const enc = (buf) => (Buffer.from(buf.toString('utf8')).equals(buf) ? buf.toString('utf8') : { hex: buf.toString('hex') });
const mask = (path) => path.replace(/defaults-separation-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g, 'defaults-separation-<iso>');
function snapshot(dir) {
  if (!existsSync(dir)) return null;
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push({ path: `${mask(rel)}/` });
        walk(join(current, entry.name), rel);
      } else out.push({ path: mask(rel), content: enc(readFileSync(join(current, entry.name))) });
    }
  };
  walk(dir, '');
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
const backupFolders = (dir) => {
  try {
    return readdirSync(join(dir, 'backups'));
  } catch {
    return [];
  }
};

const states = [];
function state(name, { root = new Map(), data = new Map(), runs = 1, noDataDir = false }) {
  const base = mkdtempSync(join(work, 's-'));
  const rootDir = join(base, 'package');
  const dataDir = join(base, 'data');
  materialize(rootDir, root);
  if (!noDataDir) mkdirSync(dataDir, { recursive: true });
  materialize(dataDir, data, true);
  const logs = [];
  const patched = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level];
    console[level] = (...a) => logs.push(`${level}: ${a.join(' ')}`);
    patched.push(() => (console[level] = original));
  }
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = (chunk) => (logs.push(`stdout: ${chunk}`), true);
  process.stderr.write = (chunk) => (logs.push(`stderr: ${chunk}`), true);
  const after = [];
  let error = null;
  try {
    for (let run = 0; run < runs; run += 1) {
      try {
        ensureStandaloneEnvironment({ rootDir, dataDir });
      } catch (e) {
        error = `${e.constructor.name}: ${e.message}`;
      }
      after.push(snapshot(dataDir));
    }
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    for (const restore of patched) restore();
  }
  const backups = backupFolders(dataDir);
  for (const folder of backups) if (!/^defaults-separation-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?$/.test(folder)) throw new Error(`backup folder ${folder}`);
  const files = (map) => Object.fromEntries([...map].filter(([, v]) => v !== null).map(([k, v]) => [k, enc(v)]));
  states.push({ name, root: Object.fromEntries([...root].map(([k, v]) => [k, v === null ? null : enc(v)])), noDataDir, before: files(data), runs, after, error, logs });
  rmSync(base, { recursive: true, force: true });
}

const marker = (stamp) => new Map([[HISTORY_MARKER_FILE, Buffer.from(stamp)]]);
const real = stampOf();
const merge = (...maps) => new Map(maps.flatMap((m) => [...m]));
const old = (kind, index = 0, edit) => {
  const data = new Map();
  put(data, kind, picks[kind][index], 'old', edit);
  return data;
};
const current = (kind, index = 0) => {
  const data = new Map();
  put(data, kind, picks[kind][index], 'current');
  return data;
};
const oldEvery = () => {
  const data = new Map();
  everyKind(data, 'old');
  return data;
};
const currentEvery = (index = 0) => {
  const data = new Map();
  everyKind(data, 'current', index);
  return data;
};

state('old-copies-of-every-kind', { data: oldEvery(), runs: 2 });
for (const kind of ALL) state(`old-${kind}-alone`, { data: old(kind) });
for (const kind of ALL) state(`old-${kind}-crlf-trailing-space`, { data: old(kind, 0, crlf) });
state('old-pack-with-stray-backup', { data: merge(old('agents'), new Map([[`agents/${picks.agents[0].name}/AGENT.md.BAK`, Buffer.from('older backup\n')]])) });
state('old-skill-with-stray-backup', { data: merge(old('skills'), new Map([[`skills/${picks.skills[0].name}/SKILL.md.orig`, Buffer.from('x')]])) });
state('edited-copies-of-every-kind', { data: (() => { const d = new Map(); everyKind(d, 'old', 0, (kind, item) => edited(kind, item)); return d; })() });
state('edited-current-copies-of-every-kind', { data: (() => { const d = new Map(); everyKind(d, 'current', 0, (kind, item) => edited(kind, item)); return d; })() });
state('current-copies-of-every-kind', { data: currentEvery(0), runs: 2 });
state('current-copies-of-both-items', { data: merge(currentEvery(0), currentEvery(1)) });
state('marker-present-old-stay-current-go', { data: merge(oldEvery(), currentEvery(1), marker(`${real}\n`)) });
state('marker-present-padded', { data: merge(oldEvery(), marker(`  ${real}\r\n\n`)) });
state('marker-without-newline', { data: merge(oldEvery(), marker(real)) });
state('marker-stale', { data: merge(oldEvery(), marker('1:deadbeef\n')) });
state('marker-empty', { data: merge(oldEvery(), marker('')) });
const noHistory = new Map([['defaults/shipped-history.json', null]]);
state('history-missing', { root: noHistory, data: merge(oldEvery(), currentEvery(1)) });
for (const [name, text] of [['truncated', world.get('defaults/shipped-history.json').toString('utf8').slice(0, 5000)], ['empty-object', '{}'], ['empty-file', ''], ['array', '[1,2]'], ['string', '"ab"'], ['number', '5'], ['null', 'null'], ['extra-keys', JSON.stringify({ ...history, extra: { a: [1] }, 10: 1, 2: 2 })], ['bom', `\ufeff${JSON.stringify(history)}`]]) {
  state(`history-${name}`, { root: new Map([['defaults/shipped-history.json', Buffer.from(text)]]), data: merge(oldEvery(), currentEvery(1)) });
}
// A string-valued history spreads into one key per UTF-16 unit, lone surrogates included; the marker carries the digest of that text.
for (const [name, text] of [['string-supplementary', JSON.stringify('😀')], ['string-supplementary-raw', '"😀"'], ['string-lone-high', '"\\ud83d"'], ['string-lone-low', '"\\ude00x"'], ['string-mixed', JSON.stringify('a😀b\u00e9\u{f0000}"\\')], ['string-lone-high-then-low-escaped', '"\\ud83d\\u0041\\ude00"']]) {
  state(`history-${name}`, { root: new Map([['defaults/shipped-history.json', Buffer.from(text)]]), data: oldEvery() });
}
const sk = picks.skills[0].name, ag = picks.agents[0].name, wf = picks.workflows[0].name;
const shaped = (h) => new Map([['defaults/shipped-history.json', Buffer.from(JSON.stringify(h))]]);
const editedAll = () => { const d = new Map(); everyKind(d, 'current', 0, (kind, item) => edited(kind, item)); return d; };
for (const section of ALL) {
  state(`history-${section}-null`, { root: shaped({ [section]: null }), data: merge(editedAll(), oldEvery()) });
  const item = picks[section][0].name;
  for (const [label, value] of [['object', {}], ['number', 7], ['true', true], ['string', 'abc'], ['false', false]]) {
    state(`history-${section}-entry-${label}`, { root: shaped({ [section]: { [item]: value } }), data: editedAll() });
  }
}
state('history-only-for-one-kind', { root: shaped({ agents: { [ag]: history.agents[ag] } }), data: oldEvery() });
state('pack-with-user-file', { data: merge(old('agents'), new Map([[`agents/${ag}/notes.txt`, Buffer.from('mine\n')]])) });
state('pack-with-tombstone', { data: merge(old('agents'), new Map([[`agents/${ag}/.deleted`, Buffer.from('')]])) });
state('workflow-with-agent-json', { data: merge(old('workflows'), new Map([[`workflows/${wf}/agent.json`, Buffer.from('{}')]])) });
state('pack-with-subfolder', { data: merge(old('agents'), new Map([[`agents/${ag}/refs/a.md`, Buffer.from('ref\n')]])) });
state('pack-kelvin-stray', { data: merge(old('agents'), new Map([[`agents/${ag}/x.ba\u212A`, Buffer.from('x')]])) });
state('pack-entry-missing', { data: new Map([[`agents/${ag}/agent.json`, Buffer.from('{}')]]) });
state('skill-with-user-file', { data: merge(old('skills'), new Map([[`skills/${sk}/mine.txt`, Buffer.from('mine\n')]])) });
state('skill-with-binary-file', { data: merge(old('skills'), new Map([[`skills/${sk}/logo.bin`, Buffer.from([0, 13, 10, 1])]])) });
state('skill-as-file', { data: new Map([[`skills/${sk}`, Buffer.from('not a folder')]]) });
state('skills-root-missing', { data: merge(new Map([[`agents/${ag}/AGENT.md`, picks.agents[0].old.get('AGENT.md')]])) });
state('user-own-items', { data: new Map([['skills/mine/SKILL.md', Buffer.from('mine\n')], ['agents/mine/AGENT.md', Buffer.from('---\nname: Mine\n---\n\nBody\n')], ['workflows/mine/WORKFLOW.md', Buffer.from('Body\n')], ['output-styles/mine.md', Buffer.from('mine\n')], ['output-styles/notes.txt', Buffer.from('x')], [`output-styles/${picks.outputStyles[0].name.replace(/\.md$/, '')}.d/a.md`, Buffer.from('x')], ['orchestration/mine.md', Buffer.from('mine\n')]]) });
state('backups-blocked-by-a-file', { data: merge(old('agents'), new Map([['backups', Buffer.from('a file')]])) });
state('no-data-dir', { noDataDir: true });
state('empty-data-dir', {});
state('no-plugin-manifest', { root: new Map([['defaults/plugin.json', null]]), data: oldEvery() });
state('plugin-manifest-extra-skill-root', {
  root: new Map([['defaults/plugin.json', Buffer.from(JSON.stringify({ skills: ['./skills', './more', '../escape', '/abs', 7] }))], ...[...picks.skills[1].current].map(([rel, buf]) => [`defaults/more/${picks.skills[1].name}x/${rel}`, buf])]),
  data: merge(new Map([...picks.skills[1].current].map(([rel, buf]) => [`skills/${picks.skills[1].name}x/${rel}`, buf]))),
});

writeJson(join(stage, 'twin.json'), { world: Object.fromEntries([...world].map(([k, v]) => [k, enc(v)])), states });
writeSetManifest(stage, {
  set: 'shipped-retirement',
  recorder: 'benchmarks/rust-core/recorders/record-shipped-retirement.mjs',
  command: `node benchmarks/rust-core/recorders/record-shipped-retirement.mjs --tree <git checkout of ${commit}> --commit ${commit}`,
  identity,
});
commitStage(stage, outDir);
rmSync(work, { recursive: true, force: true });
console.log(`shipped-retirement: ${states.length} states -> ${outDir}`);
