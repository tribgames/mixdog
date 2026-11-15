#!/usr/bin/env node
// Golden of the Office tool end to end (crate mixdog-office, tests/twin_e2e.rs): what Node's `executeOfficeTool`
// (src/runtime/office/index.mjs) answers to the ordered call sequences of native/core/fixtures/office-e2e/scenarios.json, which
// carry the cases of the Office suites that need neither a live model nor Microsoft Office (office-runtime-contract,
// office-runtime-portable.slow, office-runtime-design, office-runtime-pdf.slow, office-runtime-pdf-marks, office-assurance.slow,
// office-authoring, office-render-preview, document-acceptance). Every call runs inside the write ledger the extension host gives
// it (core/office-write-ledger.mjs), so each call records four things: (1) the text of the answer, whether it is an error and how many
// image blocks it carries, (2) the receipts, the workspace files the call's write routes changed with the state before and after,
// (3) after the last call the files the scenario names, and (4) with data:true the journal JSON of the data folder. The wall time of
// each scenario is recorded too: the Rust replay may not take longer in total.
//
//   node benchmarks/rust-core/recorders/record-office-e2e.mjs --tree <exact export of NODE_COMMIT with node_modules>
//
// What is normalised, and nothing else (the replay applies the same rules):
//  - the call's folder is `<dir>`, the data folder `<data>`, the system temporary folder `<tmp>`, and every separator is a `/`;
//  - session ids (`office_<16 hex>`) and transaction ids (`office_tx_<16 hex>`) are numbered in the order they appear in a scenario;
//  - every `"<name>Ms":<number>` is 0 (durations);
//  - a `"nextCursor"` (base64 of a JSON that names the session) is shown as its decoded JSON with the ids numbered;
//  - `.mixdog-backup-<uuid>` and the uuid of a transaction checkpoint name;
//  - `"reviewToken":"<value>"` is `"reviewToken":"<token>"` (the token is carried to the next call as <reviewToken> unchanged);
//  - in a zip, the `dcterms:created` and `dcterms:modified` values of docProps/core.xml and docProps/app.xml; a zip is compared by its
//    entry names (in order) and the sha256 of each entry's uncompressed bytes, never by its compressed bytes (the deflate of two
//    libraries differs); an entry that is itself a zip (a chart's workbook) is its own entries, stamps settled the same way;
//  - a PDF is what a reader finds in it (lib/office-files.mjs: page sizes, text items with positions to the thousandth, form fields, the
//    document properties without the dates), never its bytes (two PDF writers share no object layout); a PNG is its width, height, the
//    sha256 of its decoded RGBA pixels (two encoders share no chunks or deflate) and `data`, the PNG Node wrote (base64): the replay compares
//    the pixels of the two PNGs as a picture, by the shared rule of `twin::pixels` (the rasterisers anti-alias an edge differently), and
//    checks that `data` decodes to the pixels the sha256 names;
//  - in a data-folder JSON file, ISO timestamps and the numbers under keys ending At, Ms or Time.
// The text of an answer is otherwise compared as written, so key order is compared too.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOfficeFileReader, isPdf, isPng } from './lib/office-files.mjs';
import { FIXTURES_ROOT, exactProductIdentity, importFrom, parseArgs, resolveTree, writeSetManifest } from './lib/common.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-e2e.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const NODE_COMMIT = 'dbfaf98fdb82113209d84d9b943ce8c3c06a98cc';
const identity = exactProductIdentity(tree, NODE_COMMIT);
const JSZip = createRequire(path.join(tree, 'package.json'))('jszip');

const { pdfFingerprint, pngFingerprint } = await createOfficeFileReader(tree);
const tool = await importFrom(tree, 'src/runtime/office/index.mjs');
const ledgers = await importFrom(tree, 'src/runtime/office/core/office-write-ledger.mjs');

const CLOCK = 1_700_000_000_000;
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

const set = path.join(FIXTURES_ROOT, 'office-e2e');
const scenarios = JSON.parse(readFileSync(path.join(set, 'scenarios.json'), 'utf8')).scenarios;

const slashed = (text) => text.replaceAll('\\', '/');
const named = (text, folder, name) => {
  let out = text;
  for (const form of [folder, slashed(folder)]) out = out.replaceAll(JSON.stringify(form).slice(1, -1), name).replaceAll(form, name);
  return out;
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

let root = '';
let docs = '';
let data = '';
let sessions = [];
let transactions = [];
const numbered = (list, id, label) => {
  let at = list.indexOf(id);
  if (at < 0) at = list.push(id) - 1;
  return `<${label} ${at + 1}>`;
};
const ids = (text) =>
  text
    .replace(/office_tx_[0-9a-f]{16}/g, (id) => numbered(transactions, id, 'tx'))
    .replace(/office_[0-9a-f]{16}/g, (id) => numbered(sessions, id, 'session'));
const scrub = (text) => {
  let out = named(named(named(text, data, '<data>'), root, '<dir>'), tmpdir(), '<tmp>');
  out = out.replace(/"nextCursor":"([A-Za-z0-9+/=_-]+)"/g, (_, cursor) => `"nextCursor":"<cursor ${ids(Buffer.from(cursor, 'base64').toString('utf8'))}>"`);
  out = ids(out);
  out = out.replace(/"([A-Za-z]+Ms)":\d+(\.\d+)?/g, '"$1":0');
  out = out.replace(/"reviewToken":"[^"]*"/g, '"reviewToken":"<token>"');
  out = out.replace(/\.mixdog-backup-[0-9a-f-]{32,36}/g, '.mixdog-backup-<uuid>');
  out = out.replace(/(mixdog-office-transaction-[A-Za-z0-9_<> ]+)-[0-9a-f-]{32,36}/g, '$1-<uuid>');
  return slashed(out.replaceAll('\\\\', '/'));
};

const STAMPED = new Set(['docProps/core.xml', 'docProps/app.xml']);
const settleStamps = (name, text) =>
  STAMPED.has(name) ? text.replace(/(<dcterms:(?:created|modified)[^>]*>)[^<]*(<\/dcterms:(?:created|modified)>)/g, '$1<timestamp>$2') : text;

const isZip = (bytes) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

/** One file's bytes as the replay compares them: a zip by its entries (an entry that is itself a zip, a chart's workbook, by its own
 *  entries), a PDF by what a reader finds in it (with the document properties but for the dates), a PNG by its size and decoded
 *  pixels, anything else exactly. */
const describeBytes = async (bytes) => {
  if (isPdf(bytes)) return await pdfFingerprint(bytes, { properties: true });
  if (isPng(bytes)) {
    const described = await pngFingerprint(bytes);
    return described.png.unreadable ? described : { png: { ...described.png, data: bytes.toString('base64') } };
  }
  if (isZip(bytes)) {
    const zip = await JSZip.loadAsync(bytes);
    const entries = [];
    for (const name of Object.keys(zip.files)) {
      const entry = zip.files[name];
      if (entry.dir) {
        entries.push({ name, dir: true });
        continue;
      }
      const raw = await entry.async('nodebuffer');
      if (isZip(raw)) {
        entries.push({ name, ...(await describeBytes(raw)) });
        continue;
      }
      const settled = STAMPED.has(name) ? Buffer.from(settleStamps(name, raw.toString('utf8')), 'utf8') : raw;
      entries.push({ name, size: raw.length, sha256: sha(settled) });
    }
    return { zip: entries };
  }
  const state = { bytes: bytes.length, sha256: sha(bytes) };
  if (bytes.length <= 2000) {
    const text = bytes.toString('utf8');
    if (Buffer.from(text, 'utf8').equals(bytes) && !text.includes('\0')) state.text = scrub(text);
  }
  return state;
};
const describeSide = async (side) => {
  if (side === null || side === undefined) return null;
  if (Buffer.isBuffer(side)) return await describeBytes(side);
  return { omitted: true, size: side.size, reason: side.reason ?? null };
};

const settleJournal = (value, key = '') => {
  if (typeof value === 'string') return value.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/g, '<timestamp>');
  if (typeof value === 'number') return /(At|Ms|Time)$/.test(key) ? 0 : value;
  if (Array.isArray(value)) return value.map((item) => settleJournal(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, settleJournal(item, name)]));
  return value;
};
const dataFiles = (dir) => {
  const out = [];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  const listed = out.map((full) => {
    const name = scrub(slashed(path.relative(data, full)));
    if (!full.endsWith('.json')) return { name };
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(full, 'utf8'));
    } catch {
      return { name, unreadable: true };
    }
    return { name, json: scrub(JSON.stringify(settleJournal(parsed))) };
  });
  return listed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

const put = (entry) => {
  const full = path.join(docs, entry.file);
  mkdirSync(path.dirname(full), { recursive: true });
  if (entry.zip) {
    const zip = new JSZip();
    for (const [name, text] of Object.entries(entry.zip)) zip.file(name, text);
    return zip.generateAsync({ type: 'nodebuffer' }).then((bytes) => writeFileSync(full, bytes));
  }
  writeFileSync(full, entry.hex ? Buffer.from(entry.hex, 'hex') : entry.text);
  return Promise.resolve();
};

const recorded = [];
let totalMs = 0;
for (const scenario of scenarios) {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'office-e2e-')));
  docs = path.join(root, 'docs');
  data = path.join(root, 'data');
  mkdirSync(docs);
  mkdirSync(data);
  sessions = [];
  transactions = [];
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = data;
  for (const entry of scenario.setup ?? []) await put(entry);
  const calls = [];
  let latest = '<none>';
  let latestToken = '<none>';
  const named_sessions = new Map();
  const started = performance.now();
  for (const call of scenario.calls) {
    const known = latest;
    const token = latestToken;
    const given = JSON.parse(JSON.stringify(call.args), (key, value) => {
      if (value === '<session>') return known;
      if (value === '<reviewToken>') return token;
      const mark = typeof value === 'string' ? /^<session:(.+)>$/.exec(value) : null;
      return mark ? (named_sessions.get(mark[1]) ?? '<none>') : value;
    });
    const context = { cwd: docs, dataDir: data };
    if (call.cancelled) context.signal = AbortSignal.abort();
    const { ledger, run } = ledgers.runWithOfficeWriteLedger({ cwd: docs, dataDir: data }, () => tool.executeOfficeTool(given, context));
    const result = await run;
    const text = result.content[0].text;
    if (!call.cancelled) latest = /office_[0-9a-f]{16}/.exec(text)?.[0] ?? latest;
    latestToken = /"reviewToken":"([^"]*)"/.exec(text)?.[1] ?? latestToken;
    if (call.as) named_sessions.set(call.as, /office_[0-9a-f]{16}/.exec(text)?.[0] ?? '<none>');
    const receipts = [];
    for (const change of ledgers.officeWriteChanges(ledger)) {
      receipts.push({
        path: scrub(slashed(path.relative(docs, change.fullPath))),
        before: await describeSide(change.before),
        after: await describeSide(change.after),
      });
    }
    calls.push({ args: call.args, ...(call.cancelled ? { cancelled: true } : {}), text: scrub(text), isError: result.isError === true, images: result.content.length - 1, receipts });
  }
  const ms = Math.round(performance.now() - started);
  totalMs += ms;
  const files = {};
  for (const name of scenario.outputs ?? []) {
    let bytes = null;
    try {
      bytes = readFileSync(path.join(docs, name));
    } catch {}
    files[name] = bytes === null ? null : await describeBytes(bytes);
  }
  recorded.push({ name: scenario.name, calls, files, ...(scenario.data ? { data: dataFiles(data) } : {}), ms });
  tool.resetOfficeSessionsForTest();
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
}

const out = {
  note: 'Recorded from the Node entry point (runtime/office/index.mjs executeOfficeTool) inside the write ledger; tests/twin_e2e.rs replays scenarios.json through the Rust engine. ms is the wall time of a scenario.',
  totalMs,
  scenarios: recorded,
};
const body = `${JSON.stringify(out, null, 2)}\n`;
writeFileSync(path.join(set, 'golden.json'), body);
writeSetManifest(set, { set: 'office-e2e', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${body.length} bytes, ${recorded.length} scenarios, ${totalMs} ms`);
