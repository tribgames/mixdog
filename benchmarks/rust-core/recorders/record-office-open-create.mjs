#!/usr/bin/env node
// Golden of opening and creating office documents (crate mixdog-office, module `session`: mode, open, create, working_copy):
// what Node's `selectMode`, `openSession`, `createSession`, `createAuthoredSession`, `registerHtmlPdfSession`,
// `resolveSession` and `materializeWorkingCopy` of `runtime/office/core/office-sessions.mjs` answer to a fixed script. Writes
// native/core/fixtures/office-open-create/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-open-create.mjs --tree <product tree with node_modules>
//
// The script is a list of steps run in order against one folder of documents, one data directory and one session registry. A
// step is `{ op, ...input, result | error, seen, files, registry }`:
//   `file`        writes a fixture document (hex);
//   `select`      `selectMode(requested, format, source)`;
//   `open`        `openSession(args, cwd, dataDir, { readOnly })`, the session held under `as`;
//   `create`      `createSession(args, cwd, dataDir)`;
//   `author`      `createAuthoredSession(args, cwd, dataDir, target)`;
//   `htmlPdf`     `registerHtmlPdfSession(args, dataDir, target, { targetExisted, receipt })`;
//   `resolve`     `resolveSession(args, cwd, dataDir, { readOnly })`;
//   `materialize` `materializeWorkingCopy(session)` of the session held under `session`.
// A session is recorded as the fields of its record (identity, mode, backend, design request and state, the Microsoft Office
// fields, the working-copy marks, the create receipt) without its id, its time stamp and its design (the design crate has its
// own recordings); ids are written as the name the script gave the session. `seen` is what the Microsoft Office host was asked
// (`host` scripts it: `supported`, the answer to `detect`, the answer to `open`), `files` is what changed under the documents
// folder since the step before (a file by its parts when it is a package, else by its length and sha256, `sameAs` the fixture it
// equals; `null` for a file that is gone), `registry` the
// sessions map and the document index. LibreOffice is hidden from the process (the loader): the conversion of a legacy file is
// recorded as the refusal Node gives without it, and the replay's converter answers that text.
//
// Microsoft Office is a scripted host: the recorder loads `com/com-adapter.mjs` with the three functions that start Office
// replaced by calls to it, and `portable/portable-soffice.mjs` with LibreOffice not found wherever it is installed. Every path is written relative to a placeholder for the temporary folder (`<root>`) with `/`
// separators.
import { createHash } from 'node:crypto';
import { createRequire, register } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-open-create.mjs';
const args = parseArgs();
const tree = path.resolve(args.get('tree') ?? process.cwd());
// A tree without its own node_modules reads the packages of the one `--modules` names.
const modules = args.get('modules') ? path.resolve(args.get('modules')) : null;
let identity;
try {
  identity = productIdentity(tree);
} catch {
  identity = { tree: 'product tree loaded by the recorder', treeKind: 'export' };
}
if (process.platform !== 'win32') throw new Error('the Microsoft Office paths are recorded on Windows');

// ---- the controlled world ---------------------------------------------------------------------------------------
for (const name of [
  'MIXDOG_OFFICE_DESIGN_LIBRARY_CONFIG',
  'MIXDOG_OFFICE_DESIGN_PACK_URL',
  'MIXDOG_OFFICE_DESIGN_PACK_KEY_ID',
  'MIXDOG_OFFICE_DESIGN_PACK_PUBLIC_KEY',
  'MIXDOG_OFFICE_TEMPLATE_DIRS',
]) {
  delete process.env[name];
}
process.env.ProgramFiles = 'C:\\Program Files';
process.env['ProgramFiles(x86)'] = 'C:\\Program Files (x86)';
process.env.APPDATA = 'C:\\Users\\twin\\AppData\\Roaming';
process.env.USERPROFILE = 'C:\\Users\\twin';
process.env.HOME = 'C:\\Users\\twin';

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'office-open-create-')));
const docs = path.join(root, 'docs');
const dataDir = path.join(root, 'data');
const libraryRoot = path.join(dataDir, 'office', 'design-library');
mkdirSync(docs, { recursive: true });
mkdirSync(libraryRoot, { recursive: true });
writeFileSync(path.join(libraryRoot, 'config.json'), JSON.stringify({ templateDirectories: [], discoverInstalledTemplates: false }));
process.chdir(root);

// The loader: Microsoft Office is the script's, LibreOffice is not found, and a tree without node_modules finds its packages in
// `--modules`. The two hooks run in the loader's own thread, so they are shipped as source.
async function resolveHook(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (!MODULES || /^(\.|file:|node:|data:)/.test(specifier)) throw error;
    return await next(specifier, { ...context, parentURL: MODULES });
  }
}
async function loadHook(url, context, next) {
  const result = await next(url, context);
  let source = String(result.source);
  const swap = (pattern, replacement) => {
    if (!pattern.test(source)) throw new Error(`${url} changed: ${pattern}`);
    source = source.replace(pattern, replacement);
  };
  if (url.endsWith('/src/runtime/office/portable/portable-soffice.mjs')) {
    swap(/async function libreOfficeProgram\(\) \{/, "async function libreOfficeProgram() {\n  return '';\n}\nasync function realLibreOfficeProgram() {");
    return { ...result, source };
  }
  if (!url.endsWith('/src/runtime/office/com/com-adapter.mjs')) return result;
  swap(/export function microsoftOfficeComSupported\(\) \{[\s\S]*?\n\}/, 'export function microsoftOfficeComSupported() { return globalThis.__officeHost.supported; }');
  swap(/export async function openMicrosoftOfficeSession\(/, 'async function realOpenMicrosoftOfficeSession(');
  swap(/export async function detectMicrosoftOffice\(/, 'async function realDetectMicrosoftOffice(');
  source += '\nexport const openMicrosoftOfficeSession = (payload, options) => globalThis.__officeHost.open(payload, options);\n';
  source += 'export const detectMicrosoftOffice = (request) => globalThis.__officeHost.detect(request);\n';
  return { ...result, source };
}
const modulesUrl = modules ? pathToFileURL(path.join(modules, 'package.json')).href : '';
const hooks = `const MODULES = ${JSON.stringify(modulesUrl)};\nexport ${resolveHook.toString().replace("resolveHook", "resolve")}\nexport ${loadHook.toString().replace("loadHook", "load")}\n`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`, import.meta.url);

const host = { supported: false, detect: null, open: null, seen: [] };
globalThis.__officeHost = {
  get supported() {
    return host.supported;
  },
  async detect(request) {
    host.seen.push({ call: 'detect', format: request?.format, path: request?.path });
    return structuredClone(host.detect ?? { ok: false, error: 'no answer scripted' });
  },
  async open(payload) {
    host.seen.push({ call: 'open', payload: { ...payload, session: '<session>' } });
    return structuredClone(host.open ?? { ok: false, error: 'no answer scripted' });
  },
};

const require = createRequire(path.join(modules ?? tree, 'package.json'));
const { PDFDocument, StandardFonts } = require('pdf-lib');
const JSZip = require('jszip');
const sessionsModule = await importFrom(tree, 'src/runtime/office/core/office-sessions.mjs');
const core = await importFrom(tree, 'src/runtime/office/core/office-core.mjs');
const packageModule = await importFrom(tree, 'src/runtime/office/portable/portable-package.mjs');
const sofficeModule = await importFrom(tree, 'src/runtime/office/portable/portable-soffice.mjs');
if (await sofficeModule.libreOfficeAvailable()) throw new Error('LibreOffice could not be hidden: the conversion of a legacy file is recorded without it');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const names = new Map();
const scrubText = (text) => {
  let out = String(text);
  for (const [id, name] of names) out = out.split(id).join(`<session:${name}>`);
  out = out.replace(/office_[0-9a-f]{16}/g, '<session>');
  return out.split(root).join('<root>').replaceAll('\\', '/');
};
/** A key of the document index: the resolved path, lower-cased, so the folder is found in lower case too. */
const scrubKey = (text) => scrubText(text.split(root.toLowerCase()).join(root));
const scrub = (value) => {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
  return value;
};
const unscrub = (value) => {
  if (typeof value === 'string') {
    let out = value.replace(/<session:([^>]+)>/g, (_, name) => [...names].find(([, held]) => held === name)?.[0] ?? '<unknown session>');
    out = out.split('<root>').join(root);
    return out.includes(`${root}/`) ? out.split(`${root}/`).join(`${root}${path.sep}`).replaceAll('/', path.sep) : out;
  }
  if (Array.isArray(value)) return value.map(unscrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unscrub(item)]));
  return value;
};
const plain = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const sorted = (value) => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  return value;
};

// ---- what a session shows ------------------------------------------------------------------------------------------------
const FIELDS = [
  'source', 'target', 'fileKind', 'format', 'mode', 'backend', 'created', 'createdNewFile', 'snapshotVersion', 'designRequest',
  'designState', 'ownership', 'visible', 'appPid', 'windowHwnd', 'foregroundActivated', 'backgroundIsolation', 'documentId',
  'readsSource', 'convertedFrom', 'createReceipt', 'authored', 'reused',
];
let anonymous = 0;
const nameOf = (session, as) => {
  if (!names.has(session.id)) names.set(session.id, as ?? `unnamed ${(anonymous += 1)}`);
  return names.get(session.id);
};
const project = (session, as) => {
  const out = { session: nameOf(session, as) };
  for (const field of FIELDS) if (session[field] !== undefined) out[field] = session[field];
  return sorted(scrub(plain(out)));
};

const registryState = () => ({
  sessions: [...core.sessions.values()].map((session) => nameOf(session)),
  documents: [...core.documentSessions.entries()].map(([key, id]) => [scrubKey(key), names.get(id) ?? '<unknown>']),
});

// ---- the files -------------------------------------------------------------------------------------------------------------
const fixtures = new Map();
const describeFiles = async () => {
  const out = {};
  const walk = async (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const bytes = readFileSync(full);
      const key = scrubText(path.relative(docs, full));
      const same = [...fixtures].find(([, digest]) => digest === sha256(bytes))?.[0];
      let value;
      if (bytes.subarray(0, 2).toString('latin1') === 'PK') {
        const zip = await JSZip.loadAsync(bytes);
        value = { kind: 'zip', parts: Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort() };
      } else if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') value = { kind: 'pdf' };
      else value = { kind: 'bytes', length: bytes.length, sha256: sha256(bytes) };
      if (same) value.sameAs = same;
      out[key] = value;
    }
  };
  await walk(docs);
  return out;
};

// What changed under the documents folder since the last step: a file that is new or differs, and `null` for one that is gone.
let lastFiles = {};
const filesChanged = (now) => {
  const changed = {};
  for (const [name, value] of Object.entries(now)) if (JSON.stringify(sorted(value)) !== JSON.stringify(sorted(lastFiles[name] ?? null))) changed[name] = value;
  for (const name of Object.keys(lastFiles)) if (!(name in now)) changed[name] = null;
  lastFiles = now;
  return changed;
};

const script = [];
const step = async (op, input, run, { as, host: scripted } = {}) => {
  host.supported = scripted?.supported ?? false;
  host.detect = scripted?.detect ?? null;
  host.open = scripted?.open ?? null;
  host.seen = [];
  const entry = { op, ...scrub(input) };
  if (scripted) entry.host = scripted;
  try {
    const value = await run(unscrub(input));
    entry.result = value === undefined ? null : sorted(scrub(plain(value)));
  } catch (error) {
    entry.error = scrubText(String(error?.message ?? error));
  }
  if (as && entry.result && typeof entry.result === 'object') entry.as = as;
  entry.seen = scrub(host.seen);
  entry.files = filesChanged(await describeFiles());
  entry.registry = registryState();
  script.push(entry);
};

const held = new Map();
const hold = (as, session) => held.set(nameOf(session, as), session);

const hex = (buffer) => Buffer.from(buffer).toString('hex');
const file = (name, data) =>
  step('file', { name }, async () => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    mkdirSync(path.dirname(path.join(docs, name)), { recursive: true });
    writeFileSync(path.join(docs, name), bytes);
    fixtures.set(name, sha256(bytes));
    return { hex: hex(bytes) };
  });
const fixtureOf = async (name, kind) => {
  await packageModule.createPortableOoxmlDocument(path.join(docs, name), { fileKind: kind });
  const bytes = readFileSync(path.join(docs, name));
  rmSync(path.join(docs, name));
  return bytes;
};

const select = (input, scripted) =>
  step('select', input, async (given) => sessionsModule.selectMode(given.requested, given.format, given.source), { host: scripted });
const open = (as, given, { readOnly = false, host: scripted } = {}) =>
  step(
    'open',
    { args: given, readOnly },
    async (input) => {
      const session = await sessionsModule.openSession(input.args, docs, dataDir, { readOnly: input.readOnly });
      hold(as, session);
      return project(session, as);
    },
    { as, host: scripted }
  );
const create = (as, given, { host: scripted } = {}) =>
  step(
    'create',
    { args: given },
    async (input) => {
      const session = await sessionsModule.createSession(input.args, docs, dataDir);
      hold(as, session);
      return project(session, as);
    },
    { as, host: scripted }
  );
const author = (as, given, target, { host: scripted } = {}) =>
  step(
    'author',
    { args: given, target },
    async (input) => {
      const session = await sessionsModule.createAuthoredSession(input.args, docs, dataDir, input.target);
      hold(as, session);
      return project(session, as);
    },
    { as, host: scripted }
  );
const htmlPdf = (as, given, target, receipt, targetExisted) =>
  step(
    'htmlPdf',
    { args: given, target, targetExisted, receipt },
    async (input) => {
      const session = await sessionsModule.registerHtmlPdfSession(input.args, dataDir, input.target, { targetExisted: input.targetExisted, receipt: input.receipt });
      hold(as, session);
      return project(session, as);
    },
    { as }
  );
const resolve = (as, given, { readOnly = false } = {}) =>
  step(
    'resolve',
    { args: given, readOnly },
    async (input) => {
      const { session, implicit } = await sessionsModule.resolveSession(input.args, docs, dataDir, { readOnly: input.readOnly });
      hold(as, session);
      return { implicit, ...project(session, as) };
    },
    { as }
  );
const materialize = (as) =>
  step('materialize', { session: as }, async () => {
    const session = held.get(as);
    const target = await sessionsModule.materializeWorkingCopy(session);
    return { target, session: project(session, as) };
  });

// ---- the script ----------------------------------------------------------------------------------------------------------
const docx = await fixtureOf('seed.docx', 'docx');
const xlsx = await fixtureOf('seed.xlsx', 'xlsx');
const pptx = await fixtureOf('seed.pptx', 'pptx');
const pdf = await (async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('Hello World', { x: 72, y: 700, size: 12, font });
  return Buffer.from(await doc.save());
})();
const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from('legacy binary body')]);

const OFFICE = { supported: true };
const opened = (extra = {}) => ({
  ok: true,
  mode: 'background',
  ownership: 'owned',
  visible: false,
  appPid: 4242,
  windowHwnd: 99,
  foregroundActivated: true,
  backgroundIsolation: { desktop: 'mixdog' },
  documentId: 'doc-1',
  ...extra,
});

await file('memo.docx', docx);
await file('book.xlsx', xlsx);
await file('deck.pptx', pptx);
await file('report.pdf', pdf);
await file('people.csv', 'name,score\r\nann,7\r\n');
await file('table.tsv', 'region\tcount\r\nseoul\t12\r\n');
await file('notes.txt', 'not a document');
await file('old.doc', OLE);
for (const name of ['com-bg.docx', 'com-bad.docx', 'com-dmg.docx', 'com-auto.docx', 'com-none.docx', 'com-shared.docx']) await file(name, docx);
await file('com-attach.xlsx', xlsx);
await file('com-vis.pptx', pptx);

// the choice of the backend
await select({ requested: undefined, format: 'pdf', source: '<root>/docs/report.pdf' }, OFFICE);
await select({ requested: 'visible', format: 'pdf', source: '<root>/docs/report.pdf' });
await select({ requested: undefined, format: 'csv', source: '<root>/docs/people.csv' }, OFFICE);
await select({ requested: 'LIVE', format: 'tsv', source: '<root>/docs/table.tsv' }, OFFICE);
await select({ requested: 'visible', format: 'csv', source: '<root>/docs/people.csv' }, OFFICE);
await select({ requested: 'portable', format: 'docx', source: '<root>/docs/memo.docx' }, OFFICE);
await select({ requested: 'live', format: 'docx', source: '<root>/docs/memo.docx' }, OFFICE);
await select({ requested: 'Visible', format: 'xlsx', source: '<root>/docs/book.xlsx' }, OFFICE);
await select({ requested: 'sideways', format: 'docx', source: '<root>/docs/memo.docx' }, OFFICE);
await select({ requested: 'background', format: 'docx', source: '<root>/docs/memo.docx' });
await select({ requested: 'attach', format: 'pptx', source: '<root>/docs/deck.pptx' });
await select({ requested: undefined, format: 'docx', source: '<root>/docs/memo.docx' });
await select({ requested: 'auto', format: 'docx', source: '<root>/docs/memo.docx' }, { supported: true, detect: { ok: true, applications: [{ format: 'docx', installed: true }] } });
await select({ requested: 'auto', format: 'docx', source: '<root>/docs/memo.docx' }, { supported: true, detect: { ok: true, applications: [{ format: 'xlsx', installed: true }, { format: 'docx', installed: false }] } });
await select({ requested: 'auto', format: 'docx', source: '<root>/docs/memo.docx' }, { supported: true, detect: { ok: false, error: 'powershell is gone' } });

// opening: a read opens the file itself, an edit works on a copy, a second open finds the first
await open('read memo', { path: '<root>/docs/memo.docx' }, { readOnly: true });
await open('edit memo', { path: '<root>/docs/memo.docx' });
await open('again memo', { path: 'memo.docx' });
await materialize('read memo');
await materialize('read memo');
await materialize('edit memo');
await open('copy book', { path: '<root>/docs/book.xlsx', output: 'out/copy.xlsx' });
await open('folder book', { path: '<root>/docs/book.xlsx', output: '<root>/docs/out' });
await open('same book', { path: '<root>/docs/book.xlsx', output: '<root>/docs/BOOK.xlsx' });
await open('missing', { path: '<root>/docs/missing.docx' });
await open('notes', { path: '<root>/docs/notes.txt' });
await open('no path', {});
await open('read deck', { path: 'deck.pptx' }, { readOnly: true });
await open('edit deck', { path: 'deck.pptx', mode: 'portable' });
await open('read csv', { path: 'people.csv' }, { readOnly: true });
await open('edit csv', { path: 'people.csv' });
await open('read pdf', { path: 'report.pdf' }, { readOnly: true });
await open('edit pdf', { path: 'report.pdf' });
await open('read pdf to output', { path: 'report.pdf', output: 'out/report-copy.pdf' }, { readOnly: true });
await open('visible csv', { path: 'people.csv', mode: 'visible' });
await open('attach tsv', { path: 'table.tsv', mode: 'attach' });
await open('bad mode', { path: 'table.tsv', mode: 'sideways' });
await open('no office', { path: 'com-none.docx', mode: 'background' });

// a legacy binary file converts once beside the original, and never over a file that is there
await open('legacy', { path: 'old.doc' });
await file('old.docx', docx);
await open('legacy again', { path: 'old.doc' });

// Microsoft Office
await open('com background', { path: 'com-bg.docx', mode: 'background' }, { host: { ...OFFICE, open: opened() } });
await open('com read', { path: 'com-auto.docx' }, { readOnly: true, host: { ...OFFICE, detect: { ok: true, applications: [{ format: 'docx', installed: true }] }, open: opened() } });
await open('com rpc', { path: 'com-bad.docx', mode: 'background' }, { host: { ...OFFICE, open: { ok: false, error: 'The RPC server is unavailable.' } } });
await open('com damaged', { path: 'com-dmg.docx', mode: 'background' }, { host: { ...OFFICE, open: { ok: false, error: 'The file is corrupt...' } } });
await open('com silent', { path: 'com-dmg.docx', mode: 'background' }, { host: { ...OFFICE, open: { ok: false } } });
await open('com attach', { path: 'com-attach.xlsx', mode: 'live' }, { host: { ...OFFICE, open: opened({ mode: 'attach', ownership: 'shared', visible: true, windowHwnd: 7, foregroundActivated: false, backgroundIsolation: null }) } });
await open('com visible', { path: 'com-vis.pptx', mode: 'visible' }, { host: { ...OFFICE, open: opened({ mode: 'visible', visible: true }) } });
await open('com shared', { path: 'com-shared.docx', mode: 'attach' }, { host: { ...OFFICE, open: opened({ mode: 'attach', ownership: 'shared', visible: true }) } });

// creating
await create('new docx', { path: 'new.docx', mode: 'portable' });
await create('new docx again', { path: 'new.docx', mode: 'portable' });
await create('new docx overwritten', { path: 'new.docx', mode: 'portable', overwrite: true });
await create('new docx output', { output: '  made/by-output.docx  ' });
await create('bad operation', { path: 'bad-op.xlsx', operations: [{ op: 'no_such_operation' }] });
await create('docx blocks', { path: 'blocks.docx', blocks: [{ type: 'heading', text: 'x' }] });
await create('pdf operations', { path: 'ops.pdf', operations: [{ op: 'append_text', text: 'x' }] });
await create('many faults', { path: 'faults.pptx', blocks: [{ type: 'heading' }], values: [[1]], script: 'x', design: { content: { facts: ['a'] } } });
await create('facts only', { path: 'facts.docx', design: { content: { objective: 'Sell more' } } });
await create('new pdf', { path: 'made.pdf', blocks: [{ type: 'heading', text: 'Quarterly report' }, { type: 'paragraph', text: 'Plain text of the report.' }] });
await create('new pdf designed', { path: 'designed.pdf', design: { review: false, blocks: [{ type: 'heading', text: 'From the design' }], fields: [] }, properties: { margin: 60 } });
await create('new pdf exists', { path: 'made.pdf', blocks: [{ type: 'heading', text: 'again' }] });
await create('new pdf overwritten', { path: 'made.pdf', overwrite: true, blocks: [{ type: 'heading', text: 'again' }] });
await create('new csv', { path: 'new.csv' });
await create('new tsv', { path: 'new.tsv', mode: 'attach' });
await create('new csv again', { path: 'new.csv' });
await create('new csv overwritten', { path: 'new.csv', overwrite: true });
await create('new pptx', { path: 'new.pptx' });
await create('new xlsx', { path: 'new.xlsx', operations: [{ op: 'set_range', sheet: 'Sheet1', range: 'A1', values: [[1]] }] });
await create('template', { path: 'new.dotx', mode: 'portable' });
await create('format mismatch', { path: 'mismatch.docx', format: 'xlsx' });
await create('format named', { path: 'named.xlsx', format: 'XLSX' });
await create('format unknown', { path: 'unknown.docx', format: 'rtf' });
await create('no path', {});
await create('blank path', { path: '   ' });
await create('unsupported target', { path: 'notes2.txt' });
await create('legacy target', { path: 'legacy.xls' });
await create('attach create', { path: 'attach.docx', mode: 'attach' }, { host: OFFICE });
await create('no office create', { path: 'visible.docx', mode: 'visible' });
await create('com create', { path: 'com-new.docx', mode: 'background' }, { host: { ...OFFICE, open: opened() } });
await create('com create failed', { path: 'com-fail.docx', mode: 'background' }, { host: { ...OFFICE, open: { ok: false, error: 'Office could not create the document' } } });
await create('com create silent', { path: 'com-silent.docx', mode: 'visible' }, { host: { ...OFFICE, open: { ok: false } } });
await create('com create auto', { path: 'com-auto-new.xlsx' }, { host: { ...OFFICE, detect: { ok: true, applications: [{ format: 'xlsx', installed: true }] }, open: opened() } });
await create('overwrite shared', { path: 'com-shared.docx', overwrite: true });

// authored documents
await author('authored deck', { mode: 'portable' }, '<root>/docs/authored.pptx');
await author('authored sheet', {}, '<root>/docs/authored.xlsx');
await author('authored pdf', {}, '<root>/docs/authored.pdf');
await author('authored attach', { mode: 'attach' }, '<root>/docs/authored2.pptx');
await author('authored visible', { mode: 'live' }, '<root>/docs/authored2.pptx');
await author('authored weird', { mode: 'weird' }, '<root>/docs/authored2.pptx');
await author('authored com', { mode: 'background' }, '<root>/docs/authored3.pptx', { host: { ...OFFICE, open: opened() } });
await author('authored com failed', { mode: 'background' }, '<root>/docs/authored4.pptx', { host: { ...OFFICE, open: { ok: false, error: 'automation server is busy' } } });

// a PDF printed from HTML
await file('printed.pdf', pdf);
await htmlPdf('printed', {}, '<root>/docs/printed.pdf', { pages: 1, source: 'html' }, true);

// finding a session
await resolve('resolved', { session: '<session:new docx output>' });
await resolve('resolved unknown', { session: 'office_ffffffffffffffff' });
await resolve('resolved nothing', {});
await resolve('resolved path', { path: 'people.csv' }, { readOnly: true });
await resolve('resolved new path', { path: 'table.tsv' }, { readOnly: true });

// ---- write ------------------------------------------------------------------------------------------------------------------
const out = {
  note: 'Recorded from the open and create part of the Node office core; tests/twin_open_create.rs replays it.',
  script,
};
process.chdir(path.dirname(root));
rmSync(root, { recursive: true, force: true });
const fixtureDir = path.join(FIXTURES_ROOT, 'office-open-create');
mkdirSync(fixtureDir, { recursive: true });
const text = `${JSON.stringify(out, null, 2)}\n`;
writeFileSync(path.join(fixtureDir, 'golden.json'), text);
writeSetManifest(fixtureDir, { set: 'office-open-create', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${text.length} bytes`);
