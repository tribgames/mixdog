#!/usr/bin/env node
// Golden of the Office data directory, transaction journal and per-call write ledger (crate mixdog-office-base): what
// Node's `runtime/office/core/journal.mjs` and `core/office-write-ledger.mjs` answer to a fixed corpus. Writes
// native/core/fixtures/office-journal/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-journal.mjs --tree <product tree>
//   node benchmarks/rust-core/recorders/record-office-journal.mjs --tree <product tree> --read-dir <data dir>
//
// The second form is the other direction of the twin: it prints what Node's `listOfficeJournals` (no cleanup) and
// `readOfficeJournal` make of a data directory the Rust code wrote, and writes no golden.
//
// Every case runs in a fresh folder under the system temp directory; the folder never appears in the golden (`<root>`
// stands for it, `<cwd>` for the working directory, paths use `/`). Ages are recorded as days, never as dates: the
// replay builds its own timestamps from them. The output is byte-stable.
import { appendFileSync, closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-journal.mjs';
const DAY_MS = 24 * 60 * 60 * 1000;
const MIB = 1024 * 1024;
const args = parseArgs();
const tree = resolveTree(args);
const load = (name) => importFrom(tree, `src/runtime/office/${name}`);
const journal = await load('core/journal.mjs');
const ledgerModule = await load('core/office-write-ledger.mjs');

const slash = (text) => text.split(path.sep).join('/');
const base64 = (bytes) => Buffer.from(bytes).toString('base64');
const withRoot = (run) => {
  const root = mkdtempSync(path.join(tmpdir(), 'office-journal-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const withRootAsync = async (run) => {
  const root = mkdtempSync(path.join(tmpdir(), 'office-journal-'));
  try {
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

if (args.has('read-dir')) {
  const dir = path.resolve(args.get('read-dir'));
  const records = await journal.listOfficeJournals(dir, { cleanup: false });
  const reads = {};
  for (const record of records) reads[String(record.id)] = await journal.readOfficeJournal(record.id, dir);
  console.log(JSON.stringify({ records, reads }));
  process.exit(0);
}

const identity = productIdentity(tree);
const out = {
  note: 'Recorded from the Node office journal and write ledger; tests/twin_journal.rs and tests/twin_ledger.rs replay it.',
  platform: process.platform,
};

// ---- the data directory ---------------------------------------------------------------------------------------------
const ENV_NAMES = ['MIXDOG_DATA_DIR', 'MIXDOG_HOME'];
const dataDirCases = [
  { MIXDOG_DATA_DIR: '<root>/data-a' },
  { MIXDOG_HOME: '<root>/home-b' },
  {},
  { MIXDOG_DATA_DIR: '', MIXDOG_HOME: '' },
  { MIXDOG_DATA_DIR: '', MIXDOG_HOME: '<root>/home-c' },
  { MIXDOG_DATA_DIR: 'rel/dir' },
  { MIXDOG_DATA_DIR: '<root>/a/../b/./c' },
  { MIXDOG_HOME: '<root>/h/../h2' },
  { MIXDOG_DATA_DIR: '<root>/data-a/' },
  { MIXDOG_DATA_DIR: '<root>/data-a', MIXDOG_HOME: '<root>/home-b' },
];
out.dataDir = withRoot((root) => {
  const cwd = path.join(root, 'cwd');
  mkdirSync(cwd);
  const saved = { cwd: process.cwd(), home: process.env.HOME, profile: process.env.USERPROFILE, env: ENV_NAMES.map((name) => process.env[name]) };
  const restore = (name, value) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
  try {
    process.chdir(cwd);
    process.env.HOME = path.join(root, 'home');
    process.env.USERPROFILE = path.join(root, 'home');
    const fill = (text) => text.replaceAll('<root>', slash(root));
    const shown = (text) => slash(text).replaceAll(slash(root), '<root>');
    return {
      home: shown(homedir()),
      cases: dataDirCases.map((env) => {
        for (const name of ENV_NAMES) delete process.env[name];
        for (const [name, value] of Object.entries(env)) process.env[name] = fill(value);
        return { env, dir: shown(journal.defaultOfficeDataDir()) };
      }),
    };
  } finally {
    process.chdir(saved.cwd);
    restore('HOME', saved.home);
    restore('USERPROFILE', saved.profile);
    ENV_NAMES.forEach((name, index) => restore(name, saved.env[index]));
  }
});

// ---- the journal ----------------------------------------------------------------------------------------------------
const iso = (ms) => new Date(ms).toISOString();
const journalFolder = (dir) => path.join(dir, 'office-transactions');
const putRaw = (dir, name, bytes) => {
  mkdirSync(journalFolder(dir), { recursive: true });
  writeFileSync(path.join(journalFolder(dir), name), bytes);
};
const listTree = (root) => {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(slash(path.relative(root, full)));
    }
  };
  walk(root);
  return found.sort();
};

const WRITTEN = [
  { version: 1, id: 'office_tx_0000000000000001', updatedAt: '2026-03-01T10:20:30.456Z', session: { id: 'office_0000000000000001', path: 'C:\\work\\a b.docx', format: 'docx' }, transaction: { id: 'office_tx_0000000000000001', state: 'open', revision: 3 } },
  { version: 1, id: 'office_tx_0000000000000002', startedAt: '2026-03-02T00:00:00.000Z', session: { id: 'office_0000000000000002', title: '한글 \u00e9 \ud83d\ude00 "quoted" \\ back' }, transaction: { id: 'office_tx_0000000000000002', ops: [1, 2.5, null, true, { nested: [] , empty: {} }] } },
  { id: 'plain', note: 'a record with only an id' },
];
out.journal = {
  // `writeOfficeJournal` answers the path; the file text is what Rust must write byte for byte.
  written: await withRootAsync(async (root) => {
    const entries = [];
    for (const record of WRITTEN) {
      const target = await journal.writeOfficeJournal(record, root);
      entries.push({ record, text: readFileSync(target, 'utf8') });
    }
    return entries;
  }),
};

const READS = [
  { name: 'missing', bytes: null },
  { name: 'nul-filled', bytes: Buffer.alloc(32) },
  { name: 'empty', bytes: Buffer.alloc(0) },
  { name: 'blanks', bytes: Buffer.from('  \n') },
  { name: 'invalid', bytes: Buffer.from('{"id": "invalid",') },
  { name: 'bom', bytes: Buffer.from('\ufeff{"id":"bom","updatedAt":"2026-03-01T00:00:00.000Z"}') },
  { name: 'null-literal', bytes: Buffer.from('null') },
  { name: 'array', bytes: Buffer.from('[1,2]') },
  { name: 'valid', bytes: Buffer.from('{"version":1,"id":"valid","session":{"id":"s"},"transaction":{"id":"t"}}\n') },
  { name: 'invalid-utf8', bytes: Buffer.concat([Buffer.from('{"id":"bad-utf8","text":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]) },
];
out.journal.reads = await Promise.all(READS.map((entry) => withRootAsync(async (root) => {
  if (entry.bytes) putRaw(root, `${entry.name}.json`, entry.bytes);
  const value = await journal.readOfficeJournal(entry.name, root);
  return { name: entry.name, bytes: entry.bytes ? base64(entry.bytes) : null, value };
})));

const LISTING = [
  { name: 'a.json', bytes: Buffer.from('{"id":"a","updatedAt":"2026-03-01T00:00:00.000Z"}') },
  { name: 'b.json', bytes: Buffer.from('{"id":"b","updatedAt":"2026-03-05T00:00:00.000Z"}') },
  { name: 'c.json', bytes: Buffer.from('{"id":"c"}') },
  { name: 'd.json', bytes: Buffer.from('garbage') },
  { name: 'e.txt', bytes: Buffer.from('{"id":"e","updatedAt":"2026-03-09T00:00:00.000Z"}') },
  { name: 'f.json', bytes: Buffer.from('\ufeff{"id":"f","updatedAt":"2026-03-09T00:00:00.000Z"}') },
  { name: 'g.json', bytes: Buffer.from('null') },
  { name: 'h.json', bytes: Buffer.from('5') },
  { name: 'i.json', bytes: Buffer.from('{"id":"i","updatedAt":"2026-03-01T00:00:00.000Z"}') },
  { name: 'j.json', bytes: Buffer.from('{"id":"j","updatedAt":"2026-03-05T00:00:00.000Z","startedAt":"2027-01-01T00:00:00.000Z"}') },
  { name: 'k.json', bytes: Buffer.from('{"id":"k","updatedAt":"2026-03-05T00:00:00.000Z"}') },
  { name: 'l.json', bytes: Buffer.from('{"id":"l","updatedAt":"2026-03-05T00:00:00Z"}') },
  { name: 'dir.json', dir: true },
];
out.journal.listing = await withRootAsync(async (root) => {
  for (const entry of LISTING) {
    if (entry.dir) mkdirSync(path.join(journalFolder(root), entry.name), { recursive: true });
    else putRaw(root, entry.name, entry.bytes);
  }
  const records = await journal.listOfficeJournals(root, { cleanup: false });
  return {
    files: LISTING.map((entry) => (entry.dir ? { name: entry.name, dir: true } : { name: entry.name, bytes: base64(entry.bytes) })),
    records,
    remaining: listTree(root),
  };
});

// Retention: ages in days; every record names a checkpoint file and a baseline PDF beside the journal.
const RETENTION = {
  records: [
    { id: 'fresh', field: 'updatedAt', ageDays: 1, checkpoint: true, baselinePdf: true },
    { id: 'recent', field: 'updatedAt', ageDays: 3 },
    { id: 'month', field: 'updatedAt', ageDays: 29, checkpoint: true },
    { id: 'old', field: 'updatedAt', ageDays: 31, checkpoint: true, baselinePdf: true },
    { id: 'older', field: 'updatedAt', ageDays: 45, baselinePdf: true },
    { id: 'started-old', field: 'startedAt', ageDays: 45, checkpoint: true },
    { id: 'started-new', field: 'startedAt', ageDays: 2 },
    { id: 'unstamped-old', field: null, ageDays: 40, mtimeAgeDays: 40, checkpoint: true },
    { id: 'unstamped-new', field: null, ageDays: 0, mtimeAgeDays: 2 },
  ],
  raw: [
    { name: 'invalid-old.json', text: 'not json', mtimeAgeDays: 40 },
    { name: 'invalid-new.json', text: 'not json', mtimeAgeDays: 2 },
    { name: 'bom-old.json', text: '\ufeff{"id":"bom-old","updatedAt":"2026-03-01T00:00:00.000Z"}', mtimeAgeDays: 40 },
    { name: 'nul-old.json', nul: 32, mtimeAgeDays: 35 },
    { name: 'note.txt', text: 'not a journal', mtimeAgeDays: 90 },
  ],
};
const retentionRun = async (cleanup) => withRootAsync(async (root) => {
  const now = Date.now();
  const side = path.join(root, 'side');
  mkdirSync(side, { recursive: true });
  const touch = (file, ageDays) => utimesSync(file, new Date(now - ageDays * DAY_MS), new Date(now - ageDays * DAY_MS));
  const data = path.join(root, 'data');
  for (const spec of RETENTION.records) {
    const record = { version: 1, id: spec.id, session: { id: `office_${spec.id}` }, transaction: { id: spec.id } };
    if (spec.field) record[spec.field] = iso(now - spec.ageDays * DAY_MS);
    if (spec.checkpoint) {
      record.checkpoint = path.join(side, `${spec.id}.checkpoint`);
      writeFileSync(record.checkpoint, 'checkpoint');
    }
    if (spec.baselinePdf) {
      record.baselinePdf = path.join(side, `${spec.id}.pdf`);
      writeFileSync(record.baselinePdf, '%PDF');
    }
    const target = await journal.writeOfficeJournal(record, data);
    if (spec.mtimeAgeDays !== undefined) touch(target, spec.mtimeAgeDays);
  }
  for (const spec of RETENTION.raw) {
    putRaw(data, spec.name, spec.nul ? Buffer.alloc(spec.nul) : Buffer.from(spec.text));
    touch(path.join(journalFolder(data), spec.name), spec.mtimeAgeDays);
  }
  const records = await journal.listOfficeJournals(data, { cleanup });
  return { kept: records.map((record) => record.id), remaining: listTree(root) };
});
out.journal.retention = { spec: RETENTION, withCleanup: await retentionRun(true), withoutCleanup: await retentionRun(false) };

// ---- the write ledger -----------------------------------------------------------------------------------------------
const side = (value) => {
  if (value === null) return null;
  if (Buffer.isBuffer(value)) {
    const entry = { bytes: value.length, sha256: createHash('sha256').update(value).digest('hex') };
    if (value.length <= 64) entry.text = value.toString('latin1');
    return entry;
  }
  return { omitted: true, size: value.size, reason: value.reason };
};
const put = (full, bytes) => {
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, bytes);
};
const sized = (full, size) => {
  mkdirSync(path.dirname(full), { recursive: true });
  const fd = openSync(full, 'w');
  try {
    ftruncateSync(fd, size);
  } finally {
    closeSync(fd);
  }
};

const SCENARIOS = [
  {
    name: 'create-edit-remove',
    ops: [
      { op: 'put', at: 'work/edit.docx', text: 'old' },
      { op: 'put', at: 'work/gone.docx', text: 'bye' },
      { op: 'note', abs: 'work/new.docx' },
      { op: 'note', abs: 'work/edit.docx' },
      { op: 'note', abs: 'work/gone.docx' },
      { op: 'put', at: 'work/new.docx', text: 'created' },
      { op: 'put', at: 'work/edit.docx', text: 'edited' },
      { op: 'rm', at: 'work/gone.docx' },
    ],
  },
  {
    name: 'unchanged-and-never-created',
    ops: [
      { op: 'put', at: 'work/same.docx', text: 'same' },
      { op: 'note', abs: 'work/same.docx' },
      { op: 'note', abs: 'work/never.docx' },
      { op: 'put', at: 'work/same.docx', text: 'same' },
    ],
  },
  {
    name: 'data-folder-and-temp-folder',
    ops: [
      { op: 'put', at: 'data/journal.json', text: 'x' },
      { op: 'put', at: 'scratch/tmp.bin', text: 'x' },
      { op: 'note', abs: 'data/journal.json' },
      { op: 'note', abs: 'scratch/tmp.bin' },
      { op: 'put', at: 'data/journal.json', text: 'y' },
      { op: 'put', at: 'scratch/tmp.bin', text: 'y' },
      { op: 'put', at: 'work/inside-temp.docx', text: 'a' },
      { op: 'note', abs: 'work/inside-temp.docx' },
      { op: 'put', at: 'work/inside-temp.docx', text: 'b' },
    ],
  },
  {
    name: 'directory-is-not-recorded',
    ops: [
      { op: 'mkdir', at: 'work/folder' },
      { op: 'note', abs: 'work/folder' },
      { op: 'rmdir', at: 'work/folder' },
      { op: 'note', abs: 'work/folder' },
      { op: 'put', at: 'work/folder', text: 'now a file' },
    ],
  },
  {
    name: 'padded-relative-and-repeated-paths',
    ops: [
      { op: 'put', at: 'work/a.docx', text: 'one' },
      { op: 'note', rel: '  a.docx ' },
      { op: 'put', at: 'work/a.docx', text: 'two' },
      { op: 'note', abs: 'work/a.docx' },
      { op: 'note', rel: '   ' },
      { op: 'note', rel: 'sub/../a.docx' },
      { op: 'put', at: 'work/a.docx', text: 'three' },
      { op: 'put', at: 'work/sub/b.docx', text: 'b1' },
      { op: 'note', rel: './sub/b.docx' },
      { op: 'put', at: 'work/sub/b.docx', text: 'b2' },
    ],
  },
  {
    name: 'binary-bytes-are-kept',
    ops: [
      { op: 'put', at: 'work/data.bin', hex: '00010200ff' },
      { op: 'note', abs: 'work/data.bin' },
      { op: 'put', at: 'work/data.bin', hex: '00010200fe' },
    ],
  },
  {
    name: 'oversized-files',
    ops: [
      { op: 'sparse', at: 'work/big-same.bin', size: 65 * MIB },
      { op: 'sparse', at: 'work/big-grows.bin', size: 65 * MIB },
      { op: 'put', at: 'work/small-then-big.bin', text: 'tiny' },
      { op: 'note', abs: 'work/big-same.bin' },
      { op: 'note', abs: 'work/big-grows.bin' },
      { op: 'note', abs: 'work/small-then-big.bin' },
      { op: 'sparse', at: 'work/big-grows.bin', size: 66 * MIB },
      { op: 'sparse', at: 'work/small-then-big.bin', size: 65 * MIB },
    ],
  },
  {
    name: 'snapshot-budget',
    ops: [
      { op: 'sparse', at: 'work/one.bin', size: 60 * MIB },
      { op: 'sparse', at: 'work/two.bin', size: 60 * MIB },
      { op: 'sparse', at: 'work/three.bin', size: 20 * MIB },
      { op: 'put', at: 'work/small.docx', text: 'small' },
      { op: 'note', abs: 'work/one.bin' },
      { op: 'note', abs: 'work/two.bin' },
      { op: 'note', abs: 'work/three.bin' },
      { op: 'note', abs: 'work/small.docx' },
      { op: 'append', at: 'work/one.bin', text: 'x' },
      { op: 'append', at: 'work/three.bin', text: 'x' },
      { op: 'put', at: 'work/small.docx', text: 'smaller' },
    ],
  },
  {
    // Windows compares paths without regard to case; the replay checks this scenario on a platform of the same kind.
    name: 'case-different-paths',
    caseFolding: process.platform === 'win32',
    ops: [
      { op: 'note', abs: 'work/case.docx' },
      { op: 'note', abs: 'work/CASE.DOCX' },
      { op: 'put', at: 'work/Case.docx', text: 'made' },
    ],
  },
];

const runScenario = (scenario) => withRoot((root) => {
  const work = path.join(root, 'work');
  const data = path.join(root, 'data');
  for (const dir of [work, data, path.join(root, 'scratch')]) mkdirSync(dir, { recursive: true });
  const { ledger } = ledgerModule.runWithOfficeWriteLedger({ cwd: work, dataDir: data }, () => {
    for (const op of scenario.ops) {
      const full = op.at ? path.join(root, op.at) : null;
      if (op.op === 'put') put(full, op.hex ? Buffer.from(op.hex, 'hex') : op.text);
      else if (op.op === 'sparse') sized(full, op.size);
      else if (op.op === 'append') appendFileSync(full, op.text);
      else if (op.op === 'mkdir') mkdirSync(full, { recursive: true });
      else if (op.op === 'rm') unlinkSync(full);
      else if (op.op === 'rmdir') rmdirSync(full);
      else if (op.op === 'note') ledgerModule.noteOfficeWrite(op.abs ? path.join(root, op.abs) : op.rel);
      else throw new Error(`unknown op ${op.op}`);
    }
  });
  const changes = ledgerModule.officeWriteChanges(ledger).map((change) => ({
    path: slash(path.relative(root, change.fullPath)),
    before: side(change.before),
    after: side(change.after),
  }));
  return { name: scenario.name, ...(scenario.caseFolding === undefined ? {} : { caseFolding: scenario.caseFolding }), ops: scenario.ops, changes };
});
out.ledger = { scenarios: SCENARIOS.map(runScenario) };

const fixtures = path.join(FIXTURES_ROOT, 'office-journal');
mkdirSync(fixtures, { recursive: true });
const text = `${JSON.stringify(out, null, 2)}\n`;
writeFileSync(path.join(fixtures, 'golden.json'), text);
writeSetManifest(fixtures, { set: 'office-journal', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${text.length} bytes`);
