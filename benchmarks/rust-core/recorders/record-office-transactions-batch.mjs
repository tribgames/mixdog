#!/usr/bin/env node
// Golden of the office transactions and the atomic batch (crate mixdog-office, modules `transactions` and `batch`): what Node's
// `core/office-transactions.mjs`, `core/office-documents.mjs` and `core/office-actions-batch.mjs` answer to scripted sessions, and what they leave
// behind. Writes native/core/fixtures/office-transactions-batch/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-transactions-batch.mjs --tree <product tree with node_modules>
//
// The golden has `files` (the fixture documents as hex: a csv, a workbook, a Word document, a deck, and the two workbooks the scripted
// Microsoft Office host saves as its checkpoints) and `scenarios`. A scenario is one session (its id, file, format, backend and mode) and
// a list of steps run in order: `begin`, `batch` (the call's `args`), `commit`, `rollback`, `external` (another program overwrites the
// document with the fixture `file`), `restart` (the process ends: the sessions are gone and the journals, the checkpoint and the document
// are what a new process finds, kept in `seed`), `recover` (`strategy` on the transaction numbered `tx`) and `pending`. Every step records
// its answer (the JSON text) or its error (with the conflict's `details`), the journal files that exist afterwards, the document as the
// engine left it (a delimited file's text; a package's parts, each part's text or the SHA-256 of its bytes, without docProps) and the
// files the call reported before writing them. Microsoft Office is a scripted host (`host`: the answers in order; an answer that names a
// `copy` first writes that fixture file to the request's `output`) and each step records the requests it saw. The clock is fixed; every file
// lives in a temporary directory named `<dir>` (the system temporary folder is `<tmp>`), the transaction ids are numbered in the order they
// appear (`<tx 1>`) and the random part of a checkpoint's name is `<uuid>`.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-transactions-batch.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
if (process.platform !== 'win32') throw new Error('the Microsoft Office host path is recorded on Windows');

const require = createRequire(path.join(tree, 'package.json'));
const JSZip = require('jszip');
const core = await importFrom(tree, 'src/runtime/office/core/office-core.mjs');
const transactions = await importFrom(tree, 'src/runtime/office/core/office-transactions.mjs');
const batchModule = await importFrom(tree, 'src/runtime/office/core/office-actions-batch.mjs');
const ledgerModule = await importFrom(tree, 'src/runtime/office/core/office-write-ledger.mjs');
const clientModule = await importFrom(tree, 'src/runtime/office/com/office-session-client.mjs');
const packageModule = await importFrom(tree, 'src/runtime/office/portable/portable-package.mjs');
const ooxml = await importFrom(tree, 'src/runtime/office/portable/portable-ooxml.mjs');

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

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const text = (value) => JSON.stringify(value === undefined ? null : value);
const quoted = (value) => JSON.stringify(value).slice(1, -1);
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'office-transactions-batch-')));
const fixtures = path.join(root, 'fixtures');
mkdirSync(fixtures);
const files = {};
const write = (name, data) => {
  writeFileSync(path.join(fixtures, name), data);
  files[name] = readFileSync(path.join(fixtures, name)).toString('hex');
};

// ---- the fixture documents ------------------------------------------------------------------------------------------
write('people.csv', 'name,score\r\nalpha,1\r\nbeta,2\r\n');
write('other.csv', 'name,score\r\nsomeone,9\r\n');
write('table.tsv', 'name\tvalue\r\nalpha\t1\r\n');
const create = async (name, kind, operations) => {
  await packageModule.createPortableOoxmlDocument(path.join(fixtures, name), { fileKind: kind });
  if (operations.length) await ooxml.applyPortableOoxmlBatch(path.join(fixtures, name), kind, operations);
  files[name] = readFileSync(path.join(fixtures, name)).toString('hex');
};
await create('book.xlsx', 'xlsx', [{ op: 'set_range', sheet: 'Sheet1', range: 'A1:B3', values: [['item', 'count'], ['pens', 12], ['ink', 7]] }]);
await create('memo.docx', 'docx', [{ op: 'append_text', text: 'First paragraph of the memo.' }, { op: 'append_text', text: 'Second paragraph.' }]);
await create('deck.pptx', 'pptx', [
  { op: 'add_slide', layout: 'blank' },
  { op: 'add_textbox', slide: 1, text: 'Quarterly review', left: 48, top: 40, width: 600, height: 60 },
]);
await create('office-before.xlsx', 'xlsx', [{ op: 'set_range', sheet: 'Sheet1', range: 'A1:A2', values: [['total'], [10]] }]);
await create('office-after.xlsx', 'xlsx', [{ op: 'set_range', sheet: 'Sheet1', range: 'A1:A2', values: [['total'], [25]] }]);

// ---- the scripted Microsoft Office host -----------------------------------------------------------------------------
let seen = [];
const installHost = (sessionId, answers, dir) => {
  const client = {
    sessionId,
    closed: false,
    closing: false,
    pending: new Map(),
    stderr: '',
    child: {
      stdin: {
        write(line) {
          const request = JSON.parse(line);
          const requestId = request.requestId;
          delete request.requestId;
          const answer = answers.shift() ?? { reply: { ok: false, error: 'no answer scripted' } };
          if (answer.copy) copyFileSync(path.join(fixtures, answer.copy), request.output);
          seen.push(request);
          const pending = client.pending.get(requestId);
          client.pending.delete(requestId);
          clearTimeout(pending.timer);
          pending.resolve(structuredClone(answer.reply));
        },
      },
    },
  };
  clientModule.sessionClients.set(sessionId, client);
};

const excelValue = (total) => ({
  format: 'xlsx',
  sheets: [{ path: '/sheet[Sheet1]', name: 'Sheet1', cells: [{ path: '/sheet[Sheet1]/cell[A1]', ref: 'A1', value: 'total' }, { path: '/sheet[Sheet1]/cell[A2]', ref: 'A2', value: total }] }],
});

// ---- what a step leaves behind ----------------------------------------------------------------------------------------
const walkDirectory = (directory) => {
  try {
    return readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch {
    return [];
  }
};

async function recordScenario(spec) {
  const dir = path.join(root, spec.name.replace(/[^a-z0-9]+/gi, '-'));
  const docs = path.join(dir, 'docs');
  const dataDir = path.join(dir, 'data');
  mkdirSync(docs, { recursive: true });
  const target = path.join(docs, spec.file);
  copyFileSync(path.join(fixtures, spec.file), target);
  const transactionIds = [];
  // `json`: the text is JSON, where a path separator is two backslashes; otherwise it is one. Both become `/`.
  const scrub = (input, json = false) => {
    let out = String(input);
    for (const form of [dir, dir.replaceAll('\\', '/')]) out = out.replaceAll(quoted(form), '<dir>').replaceAll(form, '<dir>');
    const temporary = tmpdir().replace(/[\\/]+$/, '');
    for (const form of [temporary, temporary.replaceAll('\\', '/')]) out = out.replaceAll(quoted(form), '<tmp>').replaceAll(form, '<tmp>');
    out = out.replace(/(mixdog-office-transaction-[A-Za-z0-9_]+)-[0-9a-f-]{32,36}/g, '$1-<uuid>');
    out = out.replace(/\.mixdog-backup-[0-9a-f-]{32,36}/g, '.mixdog-backup-<uuid>');
    out = out.replace(/office_tx_[0-9a-f]{16}/g, (id) => {
      if (!transactionIds.includes(id)) transactionIds.push(id);
      return `<tx ${transactionIds.indexOf(id) + 1}>`;
    });
    return out.replaceAll(json ? '\\\\' : '\\', '/');
  };
  const session = {
    id: spec.id,
    source: target,
    target,
    fileKind: path.extname(spec.file).slice(1),
    format: spec.format,
    mode: spec.mode,
    backend: spec.backend,
    openedAt: new Date().toISOString(),
    dataDir,
    created: true,
    snapshotVersion: 0,
    designState: core.emptyOfficeDesignState(),
  };
  core.sessions.set(session.id, session);
  seen = [];
  if (spec.host) installHost(session.id, structuredClone(spec.host), dir);
  const live = () => (core.sessions.get(session.id) ?? session);
  const documentOf = async () => {
    let bytes;
    try {
      bytes = readFileSync(target);
    } catch {
      return null;
    }
    if (['csv', 'tsv'].includes(spec.format)) return { text: bytes.toString('utf8') };
    const zip = await JSZip.loadAsync(bytes);
    const parts = {};
    for (const name of Object.keys(zip.files).sort()) {
      if (zip.files[name].dir || name.startsWith('docProps/')) continue;
      const data = await zip.file(name).async('nodebuffer');
      parts[name] = /\.(xml|rels)$/.test(name) ? data.toString('utf8') : { sha256: sha256(data) };
    }
    return { parts };
  };
  const journalsOf = () => {
    const found = {};
    for (const entry of walkDirectory(path.join(dataDir, 'office-transactions'))) {
      if (entry.isFile()) found[scrub(entry.name)] = scrub(readFileSync(path.join(dataDir, 'office-transactions', entry.name), 'utf8'), true);
    }
    return found;
  };
  const recorded = [];
  for (const step of spec.steps) {
    seen = [];
    const entry = { kind: step.kind };
    for (const key of ['args', 'strategy', 'tx', 'file']) if (step[key] !== undefined) entry[key] = step[key];
    const { ledger, run } = ledgerModule.runWithOfficeWriteLedger({ cwd: dir, dataDir }, async () => {
      switch (step.kind) {
        case 'begin':
          return transactions.beginTransaction(live());
        case 'batch':
          return batchModule.applyBatch(live(), { ...step.args, __cwd: docs });
        case 'commit':
          return transactions.commitTransaction(live());
        case 'rollback':
          return transactions.rollbackTransaction(live());
        case 'external':
          writeFileSync(target, readFileSync(path.join(fixtures, step.file)));
          return { replaced: step.file };
        case 'restart':
          core.sessions.delete(session.id);
          return { restarted: true };
        case 'recover':
          return transactions.recoverOfficeTransaction({ transaction: transactionIds[step.tx - 1], strategy: step.strategy }, dataDir);
        case 'pending':
          return transactions.pendingOfficeTransactions(dataDir);
        default:
          throw new Error(`unknown step ${step.kind}`);
      }
    });
    try {
      entry.result = scrub(text(await run), true);
    } catch (error) {
      entry.error = scrub(String(error?.message ?? error));
      if (error?.details) entry.details = scrub(text(error.details), true);
    }
    entry.notes = [...new Set([...ledger.before.values()].map((held) => scrub(held.fullPath)))].sort();
    entry.journals = journalsOf();
    entry.document = await documentOf();
    entry.requests = seen.map((request) => scrub(text(request), true));
    if (step.kind === 'restart') {
      // What a new process finds: the journal files, the files they name (the checkpoint) and the document.
      const named = {};
      for (const entryName of walkDirectory(path.join(dataDir, 'office-transactions'))) {
        const record = JSON.parse(readFileSync(path.join(dataDir, 'office-transactions', entryName.name), 'utf8'));
        for (const file of [record.checkpoint, record.baselinePdf]) {
          if (file) {
            try {
              named[scrub(file)] = readFileSync(file).toString('hex');
            } catch {}
          }
        }
      }
      entry.seed = { files: named, document: readFileSync(target).toString('hex') };
    }
    recorded.push(entry);
  }
  core.sessions.delete(session.id);
  clientModule.sessionClients.delete(session.id);
  return { name: spec.name, id: spec.id, file: spec.file, format: spec.format, backend: spec.backend, mode: spec.mode, ...(spec.host ? { host: spec.host } : {}), steps: recorded };
}

// ---- the script -------------------------------------------------------------------------------------------------------
const portable = (name, file, format, backend, steps) => ({ name, id: 'office_twin', file, format, backend, mode: 'portable', steps });
const audit = { audit: false };
const scenarios = [
  portable('csv commit', 'people.csv', 'csv', 'mixdog-tabular', [
    { kind: 'begin' },
    { kind: 'batch', args: { ...audit, operations: [{ op: 'set_cell', cell: 'B2', value: '10' }, { op: 'append_row', values: ['gamma', '3'] }] } },
    { kind: 'batch', args: { ...audit, operations: [{ op: 'set_cell', cell: 'A3', value: 'beta2' }] } },
    { kind: 'pending' },
    { kind: 'commit' },
    { kind: 'pending' },
  ]),
  portable('csv rollback', 'people.csv', 'csv', 'mixdog-tabular', [
    { kind: 'begin' },
    { kind: 'batch', args: { ...audit, operations: [{ op: 'set_cell', cell: 'B2', value: '99' }] } },
    { kind: 'rollback' },
    { kind: 'commit' },
  ]),
  portable('csv batch without a transaction', 'people.csv', 'csv', 'mixdog-tabular', [
    { kind: 'batch', args: { ...audit, operations: [{ op: 'set_cell', cell: 'B2', value: '5' }] } },
    { kind: 'batch', args: { ...audit, operations: [{ op: 'set_cell', cell: 'B2', value: '5' }] } },
    { kind: 'batch', args: { ...audit, requireChanges: false, operations: [{ op: 'set_cell', cell: 'B2', value: '5' }] } },
    { kind: 'batch', args: { ...audit, operations: [{ op: 'no_such_operation' }] } },
    { kind: 'batch', args: { ...audit, operations: [] } },
  ]),
  portable('tsv sessions keep their delimiter', 'table.tsv', 'tsv', 'mixdog-tabular', [
    { kind: 'begin' },
    {
      kind: 'batch',
      args: {
        ...audit,
        operations: [
          { op: 'set_range', range: 'A1:B2', values: [['name', 'value'], ['alpha\tquoted', 1]] },
          { op: 'append_row', values: ['formula', '=SUM(1,2)'] },
          { op: 'insert_columns', column: 2, count: 1 },
          { op: 'set_cell', cell: 'B1', value: 'inserted' },
        ],
      },
    },
    { kind: 'rollback' },
    { kind: 'batch', args: { ...audit, operations: [{ op: 'set_cell', cell: 'C3', value: 'formula text' }] } },
  ]),
  portable('csv conflict', 'people.csv', 'csv', 'mixdog-tabular', [
    { kind: 'begin' },
    { kind: 'begin' },
    { kind: 'batch', args: { ...audit, operations: [{ op: 'set_cell', cell: 'B2', value: '7' }] } },
    { kind: 'external', file: 'other.csv' },
    { kind: 'commit' },
    { kind: 'rollback' },
    { kind: 'batch', args: { ...audit, operations: [{ op: 'set_cell', cell: 'B2', value: '8' }] } },
  ]),
  portable('xlsx rollback', 'book.xlsx', 'xlsx', 'mixdog-ooxml', [
    { kind: 'begin' },
    {
      kind: 'batch',
      args: { ...audit, operations: [{ op: 'set_range', sheet: 'Sheet1', range: 'A4:B4', values: [['paper', 30]] }, { op: 'add_sheet', name: 'Extra' }] },
    },
    { kind: 'rollback' },
  ]),
  portable('xlsx failing batch restores the file', 'book.xlsx', 'xlsx', 'mixdog-ooxml', [
    { kind: 'begin' },
    {
      kind: 'batch',
      args: { ...audit, operations: [{ op: 'set_range', sheet: 'Sheet1', range: 'A1', values: [['changed']] }, { op: 'set_range', sheet: 'Missing', range: 'A1', values: [['x']] }] },
    },
    { kind: 'commit' },
  ]),
  portable('docx commit', 'memo.docx', 'docx', 'mixdog-ooxml', [
    { kind: 'begin' },
    { kind: 'batch', args: { ...audit, operations: [{ op: 'append_text', text: 'Third paragraph.' }, { op: 'append_text', text: 'Fourth paragraph.', style: 'Title', properties: { size: 24 } }] } },
    { kind: 'commit' },
  ]),
  portable('pptx slide', 'deck.pptx', 'pptx', 'mixdog-ooxml', [
    { kind: 'begin' },
    { kind: 'batch', args: { ...audit, operations: [{ op: 'add_slide', layout: 'blank' }, { op: 'add_textbox', slide: 2, text: 'Results', left: 48, top: 40, width: 600, height: 60 }] } },
    { kind: 'rollback' },
  ]),
  portable('recover after a restart', 'book.xlsx', 'xlsx', 'mixdog-ooxml', [
    { kind: 'begin' },
    { kind: 'batch', args: { ...audit, operations: [{ op: 'set_range', sheet: 'Sheet1', range: 'A5:B5', values: [['tape', 4]] }] } },
    { kind: 'restart' },
    { kind: 'pending' },
    { kind: 'recover', tx: 1, strategy: 'rollback' },
    { kind: 'pending' },
    { kind: 'recover', tx: 1, strategy: 'commit' },
  ]),
  portable('recover commit and discard', 'book.xlsx', 'xlsx', 'mixdog-ooxml', [
    { kind: 'begin' },
    { kind: 'batch', args: { ...audit, operations: [{ op: 'set_range', sheet: 'Sheet1', range: 'A5:B5', values: [['tape', 4]] }] } },
    { kind: 'restart' },
    { kind: 'recover', tx: 1, strategy: 'commit' },
    { kind: 'pending' },
    { kind: 'begin' },
    { kind: 'restart' },
    { kind: 'recover', tx: 2, strategy: 'discard' },
    { kind: 'recover', tx: 2, strategy: 'rollback' },
    { kind: 'recover', strategy: 'rollback' },
    { kind: 'recover', tx: 1, strategy: 'repair' },
  ]),
  {
    name: 'office workbook rollback',
    id: 'office_twin',
    file: 'office-before.xlsx',
    format: 'xlsx',
    backend: 'microsoft-office-com',
    mode: 'background',
    host: [
      { copy: 'office-before.xlsx', reply: { ok: true, value: excelValue(10) } },
      { copy: 'office-before.xlsx', reply: { ok: true, value: excelValue(10) } },
      { reply: { ok: true, results: [{ op: 'set_cell', changed: true }], saved: false, undoUnits: 2 } },
      { copy: 'office-after.xlsx', reply: { ok: true, value: excelValue(25) } },
      { copy: 'office-after.xlsx', reply: { ok: true, value: excelValue(25) } },
      { reply: { ok: true } },
      { copy: 'office-before.xlsx', reply: { ok: true, value: excelValue(10) } },
    ],
    steps: [
      { kind: 'begin' },
      { kind: 'batch', args: { ...audit, operations: [{ op: 'set_cell', sheet: 'Sheet1', cell: 'A2', value: 25 }] } },
      { kind: 'rollback' },
    ],
  },
  {
    name: 'office host refuses',
    id: 'office_twin',
    file: 'office-before.xlsx',
    format: 'xlsx',
    backend: 'microsoft-office-com',
    mode: 'background',
    host: [
      { copy: 'office-before.xlsx', reply: { ok: true, value: excelValue(10) } },
      { copy: 'office-before.xlsx', reply: { ok: true, value: excelValue(10) } },
      { reply: { ok: false, error: 'Excel refused the batch' } },
    ],
    steps: [
      { kind: 'begin' },
      { kind: 'batch', args: { ...audit, operations: [{ op: 'set_cell', sheet: 'Sheet1', cell: 'A2', value: 25 }] } },
    ],
  },
];

const recordedScenarios = [];
for (const spec of scenarios) recordedScenarios.push(await recordScenario(spec));

// ---- the output ---------------------------------------------------------------------------------------------------
const out = {
  note: 'Recorded from the Node transactions and batch (runtime/office/core/office-transactions.mjs, office-documents.mjs, office-actions-batch.mjs); tests/twin_transactions_batch.rs replays it.',
  files,
  scenarios: recordedScenarios,
};
rmSync(root, { recursive: true, force: true });
const set = path.join(FIXTURES_ROOT, 'office-transactions-batch');
mkdirSync(set, { recursive: true });
const body = `${JSON.stringify(out, null, 2)}\n`;
writeFileSync(path.join(set, 'golden.json'), body);
writeSetManifest(set, { set: 'office-transactions-batch', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${body.length} bytes, ${recordedScenarios.length} scenarios`);
