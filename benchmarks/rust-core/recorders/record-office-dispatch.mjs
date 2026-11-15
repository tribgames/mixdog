#!/usr/bin/env node
// Golden of the Office tool's entry point (crate mixdog-office, modules `dispatch`, `actions` and `engine`): what Node's
// `executeOfficeTool` (src/runtime/office/index.mjs) answers to whole call sequences that need no Microsoft Office, no LibreOffice and
// no browser: the actions that answer without a session, the refusals of a call, a cancelled call, and the life of a delimited-file
// session (create, batch, issues, a transaction rolled back and one committed, qa, finalize, an implicit session opened by path, close).
// Writes native/core/fixtures/office-dispatch/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-dispatch.mjs --tree <product tree with node_modules>
//
// A scenario is a list of calls (`args`, and `cancelled: true` for a call made with an aborted signal). A string argument `<session>`
// stands for the first session id the previous answer names. Every call records the text of the answer, whether it is an error and how
// many image blocks it carries. The clock is fixed; the call's folder is `<dir>`, the data folder `<data>`, the system temporary folder
// `<tmp>`, session and transaction ids are numbered in the order they appear and every duration is 0.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-dispatch.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);

const tool = await importFrom(tree, 'src/runtime/office/index.mjs');

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

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'office-dispatch-')));
const docs = path.join(root, 'docs');
const data = path.join(root, 'data');
mkdirSync(docs);
mkdirSync(data);

const slashed = (text) => text.replaceAll('\\', '/');
const named = (text, folder, name) => {
  let out = text;
  for (const form of [folder, slashed(folder)]) out = out.replaceAll(JSON.stringify(form).slice(1, -1), name).replaceAll(form, name);
  return out;
};
let sessions = [];
let transactions = [];
const numbered = (list, id, label) => {
  let at = list.indexOf(id);
  if (at < 0) at = list.push(id) - 1;
  return `<${label} ${at + 1}>`;
};
const scrub = (text) => {
  let out = named(named(named(text, data, '<data>'), root, '<dir>'), tmpdir(), '<tmp>');
  out = out.replace(/office_tx_[0-9a-f]{16}/g, (id) => numbered(transactions, id, 'tx'));
  out = out.replace(/office_[0-9a-f]{16}/g, (id) => numbered(sessions, id, 'session'));
  out = out.replace(/"([A-Za-z]+Ms)":\d+(\.\d+)?/g, '"$1":0');
  out = out.replace(/\.mixdog-backup-[0-9a-f-]{32,36}/g, '.mixdog-backup-<uuid>');
  out = out.replace(/(mixdog-office-transaction-[A-Za-z0-9_<> ]+)-[0-9a-f-]{32,36}/g, '$1-<uuid>');
  return slashed(out.replaceAll('\\\\', '/'));
};

const scenarios = [
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
    files: ['table.csv', 'edited.csv'],
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
for (const scenario of scenarios) {
  sessions = [];
  transactions = [];
  const calls = [];
  let last = '';
  for (const call of scenario.calls) {
    const known = /office_[0-9a-f]{16}/.exec(last)?.[0] ?? '<none>';
    const given = JSON.parse(JSON.stringify(call.args), (key, value) => (value === '<session>' ? known : value));
    const context = { cwd: docs, dataDir: data };
    if (call.cancelled) context.signal = AbortSignal.abort();
    const result = await tool.executeOfficeTool(given, context);
    const text = result.content[0].text;
    if (!call.cancelled) last = text;
    calls.push({ args: call.args, ...(call.cancelled ? { cancelled: true } : {}), text: scrub(text), isError: result.isError === true, images: result.content.length - 1 });
  }
  const files = {};
  for (const name of scenario.files ?? []) files[name] = readFileSync(path.join(docs, name), 'utf8');
  recorded.push({ name: scenario.name, calls, ...(scenario.files ? { files } : {}) });
  tool.resetOfficeSessionsForTest();
}

const out = {
  note: 'Recorded from the Node entry point (runtime/office/index.mjs executeOfficeTool); tests/twin_dispatch.rs replays it.',
  scenarios: recorded,
};
rmSync(root, { recursive: true, force: true });
const set = path.join(FIXTURES_ROOT, 'office-dispatch');
mkdirSync(set, { recursive: true });
const body = `${JSON.stringify(out, null, 2)}\n`;
writeFileSync(path.join(set, 'golden.json'), body);
writeSetManifest(set, { set: 'office-dispatch', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${body.length} bytes, ${recorded.length} scenarios`);
