#!/usr/bin/env node
// Golden twin of the boot retirement of a user's untouched copies of shipped definitions: Node's real
// `ensureStandaloneEnvironment` (session-runtime/services/seeds.mjs, with runtime/shared/shipped-definitions.mjs) over
// representative states, replayed by `mixdog-core-config` `workflow/retire.rs`.
//
// The package root of every state holds the REAL shipped files of the commit (blobs of `--commit`) and its real
// defaults/shipped-history.json; an "old copy" is a real earlier version of that item taken from git history whose hash the
// history lists. Each state records the data dir before, the data dir tree afterwards (every file's bytes, the marker
// included; backup folder names as Node named them under the pinned clock; on Linux also every permission bit), what the function threw, and what it printed.
//
//   node benchmarks/rust-core/recorders/record-shipped-retirement.mjs --tree <git checkout at --commit, with node_modules> --commit <40-hex>
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, parse } from 'node:path';
import { FIXTURES_ROOT, commitCheckoutIdentity, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const commit = cli.get('commit');
const identity = commitCheckoutIdentity(tree, commit);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, process.platform === 'linux' ? 'shipped-retirement-linux' : 'shipped-retirement');
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
// The folder of another volume for the EXDEV states: the Public profile of the system drive (writable by any user).
// On Linux (RETIRE_OTHER_VOLUME: a folder of another mount than TMPDIR) only the states marked `linux` are recorded, into their own set.
const LINUX = process.platform === 'linux';
const OTHER_VOLUME = LINUX ? process.env.RETIRE_OTHER_VOLUME : join(`${process.env.SystemDrive}\\`, 'Users', 'Public');
const sameVolume = LINUX ? statSync(OTHER_VOLUME).dev === statSync(work).dev : parse(OTHER_VOLUME).root.toLowerCase() === parse(work).root.toLowerCase();
if (sameVolume) throw new Error(`${OTHER_VOLUME} is on the volume of ${work}: the EXDEV states need two volumes`);
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
// Every state pins the clock of the pass, so the backup folder names are recorded as Node named them (`shipped-definitions.mjs:236`).
const CLOCK = '2026-01-02T03:04:05.678Z';
// A link (a junction: creating a symlink needs a privilege this machine does not grant) is recorded as the link it is, with its
// target made relative to the data dir (`<data>/x`) or to the second-volume folder (`<external>/x`).
function snapshot(dir, ctx) {
  if (!existsSync(dir)) return null;
  const out = [];
  const portable = (target) => {
    const text = target.replace(/\\/g, '/');
    const data = ctx.data.replace(/\\/g, '/');
    if (text === data || text.startsWith(`${data}/`)) return `<data>${text.slice(data.length)}`;
    if (ctx.external) {
      const external = ctx.external.replace(/\\/g, '/');
      if (text === external || text.startsWith(`${external}/`)) return `<external>${text.slice(external.length)}`;
    }
    if (LINUX && !text.startsWith('/')) return `<text>${text}`;
    if (LINUX && text.startsWith('/nonexistent-dir/')) return `<abs>${text}`;
    throw new Error(`link target ${target}`);
  };
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      // Permission bits are recorded on Linux only (Windows has no such bits).
      const modeOf = () => (LINUX ? { mode: (lstatSync(join(current, entry.name)).mode & 0o777).toString(8) } : {});
      if (entry.isSymbolicLink()) out.push({ path: rel, link: portable(readlinkSync(join(current, entry.name))) });
      else if (entry.isDirectory()) {
        out.push({ path: `${rel}/`, ...modeOf() });
        walk(join(current, entry.name), rel);
      } else {
        // A file another process holds without sharing cannot be read: recorded as such.
        let content;
        try {
          content = enc(readFileSync(join(current, entry.name)));
        } catch (error) {
          if (error.code !== 'EBUSY') throw error;
          content = { unreadable: 'EBUSY' };
        }
        out.push({ path: rel, content, ...modeOf() });
      }
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
function state(name, { root = new Map(), data = new Map(), runs = 1, noDataDir = false, clock = CLOCK, base: given = null, prepared = false, links = [], crossVolume = false, locks = [], symlinks = [], modes = [], linux = false }) {
  if (linux !== LINUX) return;
  // A pinned clock makes the backup folder name known, so a state can hold folders that clash with the one the pass claims.
  const RealDate = globalThis.Date;
  if (clock) {
    globalThis.Date = class extends RealDate {
      constructor(...a) {
        super(...(a.length ? a : [clock]));
      }
      static now() {
        return RealDate.parse(clock);
      }
    };
  }
  const base = given ?? mkdtempSync(join(work, 's-'));
  const rootDir = join(base, 'package');
  const dataDir = join(base, 'data');
  materialize(rootDir, root);
  if (!noDataDir) mkdirSync(dataDir, { recursive: true });
  if (!prepared) materialize(dataDir, data, true);
  for (const [path, target] of links) symlinkSync(join(dataDir, target), join(dataDir, path), 'junction');
  // Symbolic links with their text as given (relative or not), made after the files.
  for (const [path, text] of symlinks) {
    mkdirSync(dirname(join(dataDir, path)), { recursive: true });
    symlinkSync(text, join(dataDir, path));
  }
  // Permission bits as the test lays them (deepest first, so a folder closed to its owner is changed last).
  for (const [path, mode] of [...modes].sort((a, b) => b[0].length - a[0].length)) chmodSync(join(dataDir, path), mode);
  // `backups` on another volume: the pass's rename into it fails with EXDEV and falls back to copy and remove.
  let external = null;
  if (crossVolume) {
    external = mkdtempSync(join(OTHER_VOLUME, 'mixdog-retire-'));
    symlinkSync(external, join(dataDir, 'backups'), 'junction');
  }
  const ctx = { data: dataDir, external };
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
  const externalAfter = [];
  let error = null;
  try {
    for (let run = 0; run < runs; run += 1) {
      try {
        ensureStandaloneEnvironment({ rootDir, dataDir });
      } catch (e) {
        error = `${e.constructor.name}: ${e.message}`;
      }
      after.push(snapshot(dataDir, ctx));
      externalAfter.push(external ? snapshot(external, ctx) : null);
    }
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    for (const restore of patched) restore();
    globalThis.Date = RealDate;
  }
  const backups = backupFolders(dataDir);
  for (const folder of backups) if (!/^defaults-separation-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?$/.test(folder)) throw new Error(`backup folder ${folder}`);
  const files = (map) => Object.fromEntries([...map].filter(([, v]) => v !== null).map(([k, v]) => [k, enc(v)]));
  states.push({ name, root: Object.fromEntries([...root].map(([k, v]) => [k, v === null ? null : enc(v)])), noDataDir, clock, links, symlinks, modes, crossVolume, locks, before: files(data), runs, after, externalAfter, error, logs });
  // A given base still holds the lockers' files: its owner removes it once they let go.
  if (external) rmSync(external, { recursive: true, force: true });
  if (!given) rmSync(base, { recursive: true, force: true });
}

/** `state` over files another process holds open: [relative data path, 'Read' (others may read, not delete) | 'None'] each. */
async function lockedState(name, opts) {
  if (LINUX) return;
  const base = mkdtempSync(join(work, 's-'));
  const dataDir = join(base, 'data');
  mkdirSync(dataDir, { recursive: true });
  materialize(dataDir, opts.data, true);
  const holders = [];
  for (const [path, share] of opts.locks) {
    const file = join(dataDir, path);
    const child = spawn('powershell', ['-NoProfile', '-Command', `$f=[IO.File]::Open('${file}','Open','Read','${share}'); [Console]::Out.WriteLine('ready'); [Console]::In.ReadLine()`], { stdio: ['pipe', 'pipe', 'inherit'] });
    await new Promise((resolve) => child.stdout.once('data', resolve));
    holders.push(child);
  }
  try {
    state(name, { ...opts, base, prepared: true });
  } finally {
    for (const child of holders) {
      child.stdin.end();
      await new Promise((resolve) => child.once('exit', resolve));
    }
    rmSync(base, { recursive: true, force: true });
  }
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
// The backup folder of the pass is `defaults-separation-<ISO with : and . as ->`; an existing one is never reused (`-2`, `-3`, ...).
const clashing = (...names) => new Map(names.map((n) => [`backups/defaults-separation-2026-01-02T03-04-05-678Z${n}/keep.txt`, Buffer.from('earlier\n')]));
state('backup-folder-clash-once', { clock: CLOCK, data: merge(old('agents'), clashing('')) });
state('backup-folder-clash-twice', { clock: CLOCK, data: merge(old('agents'), clashing('', '-2')) });
state('backup-folder-clash-gap', { clock: CLOCK, data: merge(old('agents'), clashing('', '-3')) });
state('backup-folder-pinned-clock', { clock: CLOCK, data: oldEvery() });
// The marker only saves repeating the sweep: a write that fails (the marker path is a folder) is swallowed.
state('marker-is-a-folder', { data: merge(oldEvery(), new Map([[`${HISTORY_MARKER_FILE}/x`, Buffer.from('x')]])) });
// The fallback of a move (rename fails -> cpSync -> rmSync). A junction inside a skill: hashing ignores links, so the copy still
// matches; the link target lives in the data dir (`linked/`).
const linked = new Map([['linked/e.txt', Buffer.from('linked\n')]]);
const linkOf = [[`skills/${sk}/ref-link`, 'linked']];
state('skill-with-junction-renamed', { data: merge(old('skills'), linked), links: linkOf });
// Rename into a `backups` folder on another volume fails with EXDEV: copy and remove instead.
state('cross-volume-every-kind', { clock: CLOCK, data: oldEvery(), crossVolume: true });
state('cross-volume-skill-with-junction', { clock: CLOCK, data: merge(old('skills'), linked), links: linkOf, crossVolume: true });
// A file another process holds (open for reading, without sharing delete) blocks the rename and the remove, not the copy.
const stray = (path, name) => new Map([[`${path}/${name}`, Buffer.from('stray\n')]]);
const skillDir = `skills/${sk}`;
await lockedState('locked-first-file-read-share', { clock: CLOCK, runs: 2, data: merge(old('skills'), stray(skillDir, '0.orig')), locks: [[`${skillDir}/0.orig`, 'Read']] });
await lockedState('locked-last-file-read-share', { clock: CLOCK, runs: 2, data: merge(old('skills'), stray(skillDir, 'zzzz.orig')), locks: [[`${skillDir}/zzzz.orig`, 'Read']] });
await lockedState('locked-pack-read-share', { clock: CLOCK, data: merge(old('agents'), oldEvery()), locks: [[`agents/${ag}/AGENT.md`, 'Read']] });
await lockedState('locked-file-no-share-unreadable', { clock: CLOCK, data: merge(old('skills'), stray(skillDir, '0.orig')), locks: [[`${skillDir}/0.orig`, 'None']] });
await lockedState('locked-last-file-cross-volume', { clock: CLOCK, data: merge(old('skills'), stray(skillDir, 'zzzz.orig')), locks: [[`${skillDir}/zzzz.orig`, 'Read']], crossVolume: true });
// A pack's ignorable stray (`*.bak`, `*.orig`, `*.tmp`, `*~`) passes eligibility without being read, so a stray held without sharing
// makes the rename fail and the copy fail part-way: the copy keeps the entries copied before, both sources stay, the move counts as failed.
const packFor = (kind, entry, name) => `${KINDS[kind].dest}/${name}`;
const agentDir = packFor('agents', 'AGENT.md', ag), workflowDir = packFor('workflows', 'WORKFLOW.md', wf);
await lockedState('failed-copy-agent-stray-first', { clock: CLOCK, runs: 2, data: merge(old('agents'), stray(agentDir, '0.bak')), locks: [[`${agentDir}/0.bak`, 'None']] });
await lockedState('failed-copy-agent-stray-middle', { clock: CLOCK, runs: 2, data: merge(old('agents'), stray(agentDir, 'AGENT.md.BAK'), stray(agentDir, 'zz.orig')), locks: [[`${agentDir}/AGENT.md.BAK`, 'None']] });
await lockedState('failed-copy-workflow-stray-middle', { clock: CLOCK, data: merge(old('workflows'), stray(workflowDir, 'WORKFLOW.md.BAK'), stray(workflowDir, 'zz.tmp')), locks: [[`${workflowDir}/WORKFLOW.md.BAK`, 'None']] });
await lockedState('failed-copy-agent-stray-cross-volume', { clock: CLOCK, data: merge(old('agents'), stray(agentDir, 'AGENT.md.BAK'), stray(agentDir, 'zz.orig')), locks: [[`${agentDir}/AGENT.md.BAK`, 'None']], crossVolume: true });
// Linux: the native copy of a symbolic link writes weakly_canonical(absolute(<its folder>/<link text>)): an absolute path, `..`
// normalised, the links met on the way resolved as far as they exist. A rename keeps the text as it is.
{
  const base = new Map([['linked/e.txt', Buffer.from('linked\n')], ['linked/sub/f.txt', Buffer.from('f\n')]]);
  const skill = `skills/${sk}`;
  const cases = {
    relative: [[`${skill}/up`, '../../linked/e.txt']],
    'relative-dir': [[`${skill}/updir`, '../../linked']],
    'nested-folder': [[`${skill}/sub/deep/inner`, '../../../../linked/e.txt']],
    'through-intermediate-link': [['hop', 'linked'], [`${skill}/via`, '../../hop/e.txt']],
    'through-two-intermediate-links': [['hop', 'linked'], ['hop2', 'hop'], [`${skill}/via2`, '../../hop2/sub/f.txt']],
    'dotdot-through-link': [['hop', 'linked/sub'], [`${skill}/back`, '../../hop/../e.txt']],
    dangling: [[`${skill}/gone`, '../../nothing/x']],
    'dangling-behind-link': [['hop', 'linked'], [`${skill}/gone2`, '../../hop/missing/../more.txt']],
    absolute: [[`${skill}/abs`, '/nonexistent-dir/x/../y']],
    'link-to-link': [[`${skill}/first`, 'second'], [`${skill}/second`, '../../linked/e.txt']],
    'link-with-dot-segments': [[`${skill}/dots`, './../.././linked//e.txt']],
  };
  state('linux-skill-links-renamed', { linux: true, data: merge(old('skills'), base), symlinks: [[`${skill}/up`, '../../linked/e.txt'], ['hop', 'linked'], [`${skill}/via`, '../../hop/e.txt'], [`${skill}/gone`, '../../nothing/x']] });
  for (const [label, symlinks] of Object.entries(cases)) state(`linux-cross-volume-skill-link-${label}`, { linux: true, clock: CLOCK, data: merge(old('skills'), base), symlinks, crossVolume: true });
  // `cpSync` keeps the source modes: an executable, a 0600 file, an executable ignorable stray, closed-down folders.
  const modesOf = [[skill, 0o750], [`${skill}/SKILL.md`, 0o755], [`${skill}/notes.orig`, 0o600], [`${skill}/run.bak`, 0o755], [`${skill}/sub`, 0o711], [`${skill}/sub/tool.bak`, 0o700]];
  const withModes = merge(old('skills'), stray(skill, 'notes.orig'), stray(skill, 'run.bak'), stray(`${skill}/sub`, 'tool.bak'));
  state('linux-skill-modes-renamed', { linux: true, data: withModes, modes: modesOf });
  state('linux-cross-volume-skill-modes', { linux: true, data: withModes, modes: modesOf, crossVolume: true });
  state('linux-cross-volume-skill-modes-and-links', { linux: true, data: merge(withModes, base), modes: modesOf, symlinks: cases.relative, crossVolume: true });
  state('linux-cross-volume-skill-all-links', { linux: true, clock: CLOCK, data: merge(old('skills'), base), symlinks: [['hop', 'linked'], ...Object.values(cases).flat().filter(([p]) => p.startsWith(skill) && p !== `${skill}/via2` && p !== `${skill}/back` && p !== `${skill}/gone2` && p !== `${skill}/first` && p !== `${skill}/second`)], crossVolume: true });
}
if (LINUX) {
  writeJson(join(stage, 'twin.json'), { world: Object.fromEntries([...world].map(([k, v]) => [k, enc(v)])), states });
  writeSetManifest(stage, { set: 'shipped-retirement-linux', recorder: 'benchmarks/rust-core/recorders/record-shipped-retirement.mjs', command: `RETIRE_OTHER_VOLUME=<a mount other than TMPDIR> node benchmarks/rust-core/recorders/record-shipped-retirement.mjs --tree <git checkout of ${commit}> --commit ${commit} (on Linux, Node ${process.version})`, identity });
  commitStage(stage, outDir);
  rmSync(work, { recursive: true, force: true });
  console.log(`shipped-retirement-linux: ${states.length} states -> ${outDir}`);
  process.exit(0);
}
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
