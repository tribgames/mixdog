#!/usr/bin/env node
// Golden of the Office tool's entry point (crate mixdog-office, modules `dispatch`, `actions`, `engine`): what Node's
// `executeOfficeTool` (src/runtime/office/index.mjs) answers to whole call sequences, and what each call leaves behind.
//
//   node benchmarks/rust-core/recorders/record-office-dispatch.mjs --tree <product tree with node_modules>
//
// Two kinds of scenario are recorded:
//  - the hand-written ones, run here: the calls that need no session, a cancelled call, the initial operations of a delimited file and
//    the life of a delimited-file session;
//  - every call the Node test files of SUITES make through `executeOfficeTool` (the contract suite, and the selected portable, PDF and
//    design cases): each test file is run unchanged in a child process whose imports of `index.mjs` and of `office-test-support.mjs`
//    are answered by wrappers (lib/office-dispatch-loader.mjs), and every call is recorded as the test made it. The product tree is
//    only read.
//
// A call records its arguments (as the tests wrote them, with the folders, session ids and cursors named below), the text of the answer,
// whether it is an error, how many image blocks it carries, the write receipts of the call's ledger (`officeWriteChanges`: the path
// and the state before and after of each file a write route noted, in the order noted) and the files of the call's folder that the call
// created, changed or removed (`disk`). Files the test itself put in the folder before the call (a CSV it wrote, a package it zipped)
// are the call's `seeds`. A file is its byte count and sha256, a ZIP package its parts (name, byte count, sha256) in archive order.
// The clock is fixed. The call's folder is `<dir>` (the scenario's root), the Office data folder `<data>`, the system temporary folder
// `<tmp>`; session and transaction ids and snapshot cursors are numbered in the order they appear in answers (an id an argument names
// that no earlier answer carried is `<session ?>`, `<tx ?>`); every duration is 0.
// A scenario's `layout` says where the call's folder and the data folder are under the root.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOfficeFileReader } from './lib/office-files.mjs';
import { createCapture } from './lib/office-dispatch-capture.mjs';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, sha256, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-dispatch.mjs';
const CLOCK = 1_700_000_000_000;
const OFFICE = 'src/runtime/office';

/** The Node test files whose calls are recorded: `file` under src/runtime/office. */
const SUITES = [
  { file: 'office-runtime-contract.test.mjs' },
  { file: 'office-runtime-design.test.mjs' },
  { file: 'office-runtime-pdf-marks.test.mjs' },
  { file: 'xlsx-portable-snapshot.test.mjs' },
];

const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const here = path.dirname(fileURLToPath(import.meta.url));
const requireFromTree = createRequire(path.join(tree, 'package.json'));
const JSZip = requireFromTree('jszip');

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

// ---- naming what a run leaves --------------------------------------------------------------------------------------------------

const slashed = (text) => text.replaceAll('\\', '/');
const named = (text, folder, name) => {
  let out = text;
  for (const form of [folder, slashed(folder)]) out = out.replaceAll(JSON.stringify(form).slice(1, -1), name).replaceAll(form, name);
  return out;
};
const CURSOR = /"(cursor|nextCursor)":"([A-Za-z0-9_-]{16,})"/g;

class Scrub {
  constructor(root, data) {
    this.root = root;
    this.data = data;
    this.sessions = [];
    this.transactions = [];
    this.cursors = [];
    this.fresh = {};
  }

  number(list, id, label, learn) {
    let at = list.indexOf(id);
    if (at < 0) {
      if (!learn) return `<${label} ?>`;
      at = list.push(id) - 1;
    }
    return `<${label} ${at + 1}>`;
  }

  /** The folders named. */
  folders(text) {
    const out = this.data ? named(text, this.data, '<data>') : text;
    return named(named(out, this.root, '<dir>'), tmpdir(), '<tmp>');
  }

  /** Folders, ids, durations and separators. `learn` numbers the ids it has not seen. */
  plain(text, learn) {
    let out = this.folders(text);
    out = out.replace(/office_tx_[0-9a-f]{16}/g, (id) => this.number(this.transactions, id, 'tx', learn));
    out = out.replace(/office_[0-9a-f]{16}/g, (id) => this.number(this.sessions, id, 'session', learn));
    out = out.replace(/"([A-Za-z]+Ms)":\d+(\.\d+)?/g, '"$1":0');
    out = out.replace(/\.mixdog-backup-[0-9a-f-]{32,36}/g, '.mixdog-backup-<uuid>');
    out = out.replace(/\.mixdog-authoring-[A-Za-z0-9]{6}/g, '.mixdog-authoring-<id>');
    out = out.replace(/(mixdog-office-transaction-[A-Za-z0-9_<> ]+)-[0-9a-f-]{32,36}/g, '$1-<uuid>');
    return slashed(out.replaceAll('\\\\', '/'));
  }

  /** An answer: the cursors it carries are numbered and described (decoded, with the session named), then `plain`. */
  answer(text) {
    this.fresh = {};
    const swapped = this.folders(text).replace(CURSOR, (_, key, value) => {
      let at = this.cursors.indexOf(value);
      if (at < 0) {
        at = this.cursors.push(value) - 1;
        this.fresh[at + 1] = this.plain(Buffer.from(value, 'base64url').toString('utf8'), true);
      }
      return `"${key}":"<cursor ${at + 1}>"`;
    });
    return this.plain(swapped, true);
  }

  /** Arguments: a string that is a cursor an answer carried is that cursor; any other string is `plain` without numbering new ids. */
  arguments(value) {
    if (typeof value === 'string') {
      const at = this.cursors.indexOf(value);
      if (at >= 0) return `<cursor ${at + 1}>`;
      // Only the folders and the ids are named: a backslash of an argument is the caller's (a pattern's `\d`), not a separator.
      return this.folders(value)
        .replace(/office_tx_[0-9a-f]{16}/g, (id) => this.number(this.transactions, id, 'tx', false))
        .replace(/office_[0-9a-f]{16}/g, (id) => this.number(this.sessions, id, 'session', false));
    }
    if (Array.isArray(value)) return value.map((item) => this.arguments(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.arguments(item)]));
    return value;
  }
}

const base64 = (text) => Buffer.from(text, 'base64');

/** The package properties' stamps (the content of `<dcterms:created ...>` and `<dcterms:modified ...>`) are the clock's: each is `<stamp>`. */
function withoutStamps(xml) {
  let out = '';
  let at = 0;
  for (;;) {
    const found = [xml.indexOf('<dcterms:created', at), xml.indexOf('<dcterms:modified', at)].filter((index) => index >= 0);
    if (!found.length) return out + xml.slice(at);
    const open = Math.min(...found);
    const close = xml.indexOf('>', open);
    const end = close < 0 ? -1 : xml.indexOf('<', close + 1);
    if (end < 0) return out + xml.slice(at);
    out += `${xml.slice(at, close + 1)}<stamp>`;
    at = end;
  }
}
const { pdfFingerprint } = await createOfficeFileReader(tree);

const isPackage = (bytes) => bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;

/** A file as the golden holds it: a PDF by what a reader finds in it, a ZIP package by its parts (the stamps of the package's
 *  properties, which are the clock's, left out), else its bytes. */
async function fingerprint(bytes) {
  if (bytes.length > 4 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return pdfFingerprint(bytes);
  if (bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) {
    try {
      const zip = await JSZip.loadAsync(bytes);
      const parts = [];
      for (const name of Object.keys(zip.files)) {
        const entry = zip.files[name];
        const data = entry.dir ? Buffer.alloc(0) : await entry.async('nodebuffer');
        const held = name === 'docProps/core.xml' ? Buffer.from(withoutStamps(data.toString('utf8')), 'utf8') : data;
        // A package inside a package (a chart's workbook) is its parts and has no byte count: its compression is not Node's.
        parts.push(isPackage(data) ? [name, null, await fingerprint(data)] : [name, data.length, sha256(held)]);
      }
      return { zip: parts };
    } catch {
      // not a package: its bytes
    }
  }
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

/** A file a test put in the folder, as the call that follows it finds it. */
function seeded(encoded) {
  if (typeof encoded === 'object') return encoded;
  const bytes = base64(encoded);
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? { text } : { base64: encoded };
}

async function sideOf(side) {
  if (side.absent) return 'absent';
  if (side.uncaptured) return 'uncaptured';
  return fingerprint(base64(side.base64));
}

/** The golden's entry of one captured call. */
async function entryOf(event, scrub) {
  const text = scrub.answer(event.text);
  const given = scrub.arguments(event.args);
  const entry = { args: given };
  if (event.aborted) entry.cancelled = true;
  const seeds = Object.entries(event.seeds);
  const put = seeds.filter(([, content]) => content !== null);
  if (put.length) entry.seeds = Object.fromEntries(put.map(([name, content]) => [scrub.plain(name, false), seeded(content)]));
  const removed = seeds.filter(([, content]) => content === null);
  if (removed.length) entry.removed = removed.map(([name]) => scrub.plain(name, false));
  entry.text = text;
  entry.isError = event.isError;
  entry.images = event.images;
  if (Object.keys(scrub.fresh).length) entry.cursors = scrub.fresh;
  entry.writes = [];
  for (const write of event.writes) entry.writes.push({ path: scrub.plain(write.path, false), before: await sideOf(write.before), after: await sideOf(write.after) });
  entry.disk = {};
  for (const [name, content] of Object.entries(event.disk)) entry.disk[scrub.plain(name, false)] = content === null ? null : typeof content === 'object' ? content : await fingerprint(base64(content));
  return entry;
}

const layoutOf = (root, event) => {
  const inside = (folder) => {
    const relative = path.relative(root, folder).split(path.sep).join('/');
    return relative.startsWith('..') ? null : relative;
  };
  return { cwd: event.cwd ? inside(event.cwd) : '', data: event.dataDir ? inside(event.dataDir) : null };
};

// ---- the hand-written scenarios ------------------------------------------------------------------------------------------------

const tool = await importFrom(tree, `${OFFICE}/index.mjs`);
const RealDate = globalThis.Date;
globalThis.Date = class extends RealDate {
  constructor(...given) {
    if (given.length === 0) super(CLOCK);
    else super(...given);
  }
  static now() {
    return CLOCK;
  }
};
const capture = await createCapture(tree);

const handwritten = [
  {
    name: 'calls that need no session',
    calls: [
      { args: { action: 'describe' } },
      { args: { action: 'describe', format: 'csv' } },
      { args: { action: 'describe', format: 'csv', operation: 'set_cell' } },
      { args: { action: 'describe', format: 'csv', backend: 'nowhere' } },
      { args: { action: 'transactions' } },
      { args: { action: 'recover' } },
      { args: { action: 'frobnicate' } },
      { args: { action: 'snapshot', session: 'office_missing' } },
      { args: { action: 'secure', path: 'a.csv', output: 'b.pdf', security: 'encrypt' } },
      { args: { action: 'attach', path: 'x.csv', finalize: true } },
      { args: { action: 'create' } },
      { args: { action: 'open', path: 'missing.csv' } },
    ],
  },
  { name: 'a cancelled call', calls: [{ args: { action: 'describe' }, cancelled: true }] },
  {
    // `initial tabular batches keep session identity and the source document when snapshots are omitted` of office-actions-open.test.mjs.
    name: 'initial operations of a delimited file',
    calls: [
      { args: { action: 'create', path: 'table.csv', operations: [{ op: 'append_row', values: ['original'] }] } },
      { args: { action: 'open', path: 'table.csv', output: 'edited.csv', mode: 'portable', operations: [{ op: 'append_row', values: ['edited'] }] } },
    ],
  },
  {
    name: 'the life of a delimited-file session',
    calls: [
      { args: { action: 'create', path: 'people.csv', operations: [{ op: 'set_range', range: 'A1:B3', values: [['name', 'score'], ['alpha', 1], ['beta', 2]] }] } },
      { args: { action: 'batch', session: '<session>', operations: [{ op: 'set_cell', cell: 'B3', value: 5 }] } },
      { args: { action: 'issues', session: '<session>' } },
      { args: { action: 'begin', session: '<session>' } },
      { args: { action: 'batch', session: '<session>', operations: [{ op: 'set_cell', cell: 'A4', value: 'gamma' }] } },
      { args: { action: 'diff', session: '<session>' } },
      { args: { action: 'rollback', session: '<session>' } },
      { args: { action: 'begin', session: '<session>' } },
      { args: { action: 'batch', session: '<session>', operations: [{ op: 'set_cell', cell: 'A4', value: 'delta' }] } },
      { args: { action: 'commit', session: '<session>' } },
      { args: { action: 'snapshot', session: '<session>' } },
      { args: { action: 'qa', session: '<session>' } },
      { args: { action: 'save', session: '<session>' } },
      { args: { action: 'finalize', session: '<session>' } },
      { args: { action: 'finalize', session: '<session>', failOn: 'error' } },
      { args: { action: 'snapshot', path: 'people.csv' } },
      { args: { action: 'close', session: '<session>' } },
      { args: { action: 'close', session: '<session>' } },
    ],
  },
];

const recorded = [];
for (const scenario of handwritten) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'office-dispatch-')));
  const docs = path.join(root, 'docs');
  const data = path.join(root, 'data');
  mkdirSync(docs);
  mkdirSync(data);
  const scrub = new Scrub(root, data);
  const calls = [];
  let last = '';
  let layout = null;
  for (const call of scenario.calls) {
    const known = /office_[0-9a-f]{16}/.exec(last)?.[0] ?? '<none>';
    const given = JSON.parse(JSON.stringify(call.args), (key, value) => (value === '<session>' ? known : value));
    const context = { cwd: docs, dataDir: data };
    if (call.cancelled) context.signal = AbortSignal.abort();
    const { event } = await capture(tool, given, context);
    layout ??= layoutOf(root, event);
    if (!call.cancelled) last = event.text;
    const entry = await entryOf(event, scrub);
    // The hand-written arguments name the session by its placeholder, not by the id it stood for.
    entry.args = JSON.parse(JSON.stringify(call.args));
    calls.push(entry);
  }
  recorded.push({ name: scenario.name, source: 'hand-written', layout, calls });
  tool.resetOfficeSessionsForTest();
  rmSync(root, { recursive: true, force: true });
}

// ---- the calls of the Node test files ------------------------------------------------------------------------------------------

const wrapperDir = mkdtempSync(path.join(tmpdir(), 'office-dispatch-wrappers-'));
const urlOf = (file) => pathToFileURL(file).href;
const realIndex = urlOf(path.join(tree, OFFICE, 'index.mjs'));
const realSupport = urlOf(path.join(tree, OFFICE, 'office-test-support.mjs'));
const namesOf = async (url) => Object.keys(await import(url)).filter((name) => name !== 'default');
const sink = path.join(wrapperDir, 'calls.jsonl');
const reexports = (names, skip) => names.filter((name) => !skip.includes(name)).map((name) => `export const ${name} = real.${name};`).join('\n');
writeFileSync(
  path.join(wrapperDir, 'index.mjs'),
  `import * as real from ${JSON.stringify(realIndex)};
import { appendFileSync } from 'node:fs';
import { createCapture } from ${JSON.stringify(urlOf(path.join(here, 'lib/office-dispatch-capture.mjs')))};
const capture = await createCapture(${JSON.stringify(tree)});
export const executeOfficeTool = async (args = {}, context = {}) => {
  const { result, event } = await capture(real, args, context);
  appendFileSync(process.env.OFFICE_DISPATCH_SINK, JSON.stringify({ kind: 'call', ...event }) + '\\n');
  return result;
};
export const resetOfficeSessionsForTest = (...given) => {
  appendFileSync(process.env.OFFICE_DISPATCH_SINK, JSON.stringify({ kind: 'boundary' }) + '\\n');
  return real.resetOfficeSessionsForTest(...given);
};
${reexports(await namesOf(realIndex), ['executeOfficeTool', 'resetOfficeSessionsForTest'])}
`
);
writeFileSync(
  path.join(wrapperDir, 'support.mjs'),
  `import * as real from ${JSON.stringify(realSupport)};
import { appendFileSync } from 'node:fs';
export const workspace = async (t) => {
  const folder = await real.workspace(t);
  appendFileSync(process.env.OFFICE_DISPATCH_SINK, JSON.stringify({ kind: 'test', name: t.name, cwd: folder }) + '\\n');
  return folder;
};
${reexports(await namesOf(realSupport), ['workspace'])}
`
);
const config = { wrappers: urlOf(wrapperDir + path.sep), realIndex, realSupport, wrapperIndex: urlOf(path.join(wrapperDir, 'index.mjs')), wrapperSupport: urlOf(path.join(wrapperDir, 'support.mjs')), clock: CLOCK };

/** A pptxgenjs script is JavaScript the product runs on the Node of the skill-script launcher, not in the Rust build, so a scenario
 *  that authors a deck from one is left out; the golden lists each. */
const SCRIPT_RUNTIME = "authors a deck from a pptxgenjs script, which the Rust build does not run (the script runtime is the skill-script launcher's)";
const omitted = [];
const suiteLog = [];
for (const suite of SUITES) {
  writeFileSync(sink, '');
  const ran = spawnSync(process.execPath, ['--import', urlOf(path.join(here, 'lib/office-dispatch-preload.mjs')), path.join(tree, OFFICE, suite.file)], {
    cwd: tree,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, OFFICE_DISPATCH_CONFIG: JSON.stringify(config), OFFICE_DISPATCH_SINK: sink },
  });
  const failed = /^# fail (\d+)/m.exec(ran.stdout ?? '')?.[1] ?? '?';
  suiteLog.push(`${suite.file}: exit ${ran.status}, failed tests ${failed}`);
  if (ran.status !== 0) suiteLog.push((ran.stdout ?? '').split('\n').filter((line) => /not ok|# fail/.test(line)).slice(0, 12).join('\n'), (ran.stderr ?? '').slice(0, 600));
  const events = readFileSync(sink, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  let current = null;
  let loose = 0;
  const scenarios = [];
  for (const event of events) {
    if (event.kind === 'boundary') current = null;
    else if (event.kind === 'test') {
      current = { name: `${suite.file}: ${event.name}`, root: event.cwd, calls: [] };
      scenarios.push(current);
    } else if (event.kind === 'call') {
      if (!current || (event.cwd ? event.cwd !== current.root : current.root !== null)) {
        loose += 1;
        current = { name: `${suite.file}: calls made without a workspace, ${loose}`, root: event.cwd ?? null, calls: [] };
        scenarios.push(current);
      }
      current.calls.push(event);
    }
  }
  for (const scenario of scenarios) {
    if (!scenario.calls.length) continue;
    if (scenario.calls.some((event) => event.args?.action === 'author' && typeof event.args.script === 'string')) {
      omitted.push({ name: scenario.name, why: SCRIPT_RUNTIME });
      continue;
    }
    const root = scenario.root ?? realpathSync(mkdtempSync(path.join(tmpdir(), 'office-dispatch-loose-')));
    const first = scenario.calls[0];
    const scrub = new Scrub(root, first.dataDir || '');
    const calls = [];
    for (const event of scenario.calls) calls.push(await entryOf(event, scrub));
    recorded.push({ name: scenario.name, source: suite.file, layout: scenario.root ? layoutOf(root, first) : { cwd: '', data: null }, calls });
    if (!scenario.root) rmSync(root, { recursive: true, force: true });
  }
}
rmSync(wrapperDir, { recursive: true, force: true });

const out = {
  note: 'Recorded from the Node entry point (runtime/office/index.mjs executeOfficeTool); tests/twin_dispatch.rs replays it.',
  omitted,
  scenarios: recorded,
};
const set = path.join(FIXTURES_ROOT, 'office-dispatch');
mkdirSync(set, { recursive: true });
const body = `${JSON.stringify(out, null, 2)}\n`;
writeFileSync(path.join(set, 'golden.json'), body);
writeSetManifest(set, { set: 'office-dispatch', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(suiteLog.join('\n'));
console.log(`golden.json ${body.length} bytes, ${recorded.length} scenarios, ${recorded.reduce((sum, scenario) => sum + scenario.calls.length, 0)} calls`);
