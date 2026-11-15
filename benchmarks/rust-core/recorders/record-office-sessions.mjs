#!/usr/bin/env node
// Golden of the office session record and registry (crate mixdog-office, module `session`): what Node's session part of
// `runtime/office/core/office-core.mjs` answers to a fixed script. Writes native/core/fixtures/office-sessions/golden.json
// and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-sessions.mjs --tree <product tree>
//
// The script is a list of steps, each `{ op, ...input, value | error }`, run in order against one data directory:
// `emptyState`, `comFields` and `merge` (the pure helpers), `context` (resolveOfficeDesignContext), `open` (a session
// record as buildOfficeSessionRecord makes it, held under a name), `ensure` (ensureOfficeSessionDesign on a named
// session), `register`, `index`, `release`, `forDocument` and `registry` (the sessions map and the document index), and
// `snapshot` (the binding files the library wrote). The library has no pack server and no template directory
// (`config.json` says so), the clock is fixed, every path is written relative to a placeholder for the temporary
// folder (`<root>`) with `/` separators, and session ids are the script's own.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-sessions.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);

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

let clock = 0;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...given) {
    if (given.length === 0) super(clock);
    else super(...given);
  }
  static now() {
    return clock;
  }
};

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'office-sessions-')));
const dataDir = path.join(root, 'data');
const libraryRoot = path.join(dataDir, 'office', 'design-library');
mkdirSync(path.join(root, 'docs'), { recursive: true });
process.chdir(root);

const core = await importFrom(tree, 'src/runtime/office/core/office-core.mjs');
const libraryCore = await importFrom(tree, 'src/runtime/office/design/library/design-library-core.mjs');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const slash = (text) => text.split(path.sep).join('/');
const scrubText = (text) => text.split(root).join('<root>').replaceAll('\\', '/');
/** A key of the document index: the resolved path, lower-cased, so the folder is found in lower case too. */
const scrubKey = (text) => scrubText(text.split(root.toLowerCase()).join(root));
const documentKeys = new Map();
const scrub = (value) => {
  if (typeof value === 'string') return documentKeys.get(value) ?? scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrubText(key), scrub(item)]));
  return value;
};
const unscrub = (value) => {
  if (typeof value === 'string') return value.split('<root>').join(root);
  if (Array.isArray(value)) return value.map(unscrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unscrub(item)]));
  return value;
};
const plain = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const attempt = async (run) => {
  try {
    return { value: scrub(plain(await run())) };
  } catch (error) {
    return { error: scrubText(String(error?.message ?? error)) };
  }
};
const document = (name) => {
  const full = path.join(root, 'docs', name);
  documentKeys.set(sha256(libraryCore.canonicalPath(full)), `<key docs/${name}>`);
  return `<root>/docs/${name}`;
};

// ---- the script ---------------------------------------------------------------------------------------------------
const sessions = new Map();
const script = [];

/** What a session shows of its design binding. */
const bound = (session) => ({
  designRequest: session.designRequest ?? null,
  designLibrary: session.designLibrary ?? null,
  design: session.design ?? null,
  designState: session.designState ?? null,
});

const snapshot = () => {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      let key = slash(path.relative(libraryRoot, full));
      const bytes = readFileSync(full);
      let value;
      if (/\.(json|bak)$/.test(entry.name)) {
        try {
          value = JSON.parse(bytes.toString('utf8'));
        } catch {
          value = { bytes: bytes.length, sha256: sha256(bytes) };
        }
      } else value = { bytes: bytes.length, sha256: sha256(bytes) };
      if (key.startsWith('bindings/') && value?.documentPath) {
        const suffix = key.endsWith('.bak') ? '.bak' : '';
        const expected = `${sha256(libraryCore.canonicalPath(value.documentPath))}.json${suffix}`;
        key = `bindings/${scrubText(value.documentPath)}${suffix}`;
        if (entry.name !== expected) value = { misnamed: entry.name };
      }
      out[key] = scrub(value);
    }
  };
  try {
    statSync(libraryRoot);
    walk(libraryRoot);
  } catch {}
  return out;
};

const registryState = () => ({
  sessions: [...core.sessions.keys()],
  documents: [...core.documentSessions.entries()].map(([key, id]) => [scrubKey(key), id]),
});

const step = async (op, input, run) => {
  const result = run ? await attempt(run) : {};
  const entry = { op, ...scrub(input) };
  if (result.value !== undefined) entry.value = result.value;
  if (result.error !== undefined) entry.error = result.error;
  script.push(entry);
};

const writeConfig = (config) =>
  step('writeConfig', { config }, async () => {
    mkdirSync(libraryRoot, { recursive: true });
    writeFileSync(path.join(libraryRoot, 'config.json'), JSON.stringify(config));
  });
const setClock = (ms) =>
  step('setClock', { ms }, async () => {
    clock = ms;
  });
const emptyState = (input) => step('emptyState', input, async () => core.emptyOfficeDesignState(input));
const comFields = (opened) => step('comFields', { opened }, async () => core.microsoftOfficeOpenFields(opened));
const merge = (name, current, next) => step('merge', { name, current, next }, async () => core.mergeOfficeDesignRequest(current, next));
const context = (name, input) =>
  step('context', { name, ...input }, async () => {
    const { args: given, target, source, format, created } = unscrub(input);
    return core.resolveOfficeDesignContext({ args: given, dataDir, target, source: source ?? '', format, created });
  });
/** A session record as `buildOfficeSessionRecord` makes it (office-sessions.mjs), held under `name`. */
const open = (name, spec) =>
  step('open', { name, ...spec }, async () => {
    const { id, source, target, fileKind, format, mode, backend, created, createdNewFile } = unscrub(spec);
    sessions.set(name, {
      id,
      source,
      target,
      fileKind,
      format,
      mode,
      backend,
      openedAt: new Date().toISOString(),
      dataDir,
      created,
      snapshotVersion: 0,
      ...(createdNewFile !== undefined ? { createdNewFile } : {}),
    });
    return { openedAt: sessions.get(name).openedAt };
  });
const ensure = (name, given, options = {}) =>
  step('ensure', { name, args: given, options }, async () => {
    const session = sessions.get(name);
    await core.ensureOfficeSessionDesign(session, unscrub(given), dataDir, options);
    return bound(session);
  });
const register = (name) =>
  step('register', { name }, async () => {
    const session = sessions.get(name);
    await core.registerOfficeSession(session);
    return bound(session);
  });
const index = (name) =>
  step('index', { name }, async () => {
    core.indexOfficeSession(sessions.get(name));
    return registryState();
  });
const release = (name) =>
  step('release', { name }, async () => {
    core.releaseOfficeSession(sessions.get(name));
    return registryState();
  });
const forDocument = (target) => step('forDocument', { target }, async () => core.officeSessionForDocument(unscrub(target))?.id ?? null);
const registry = (name) => step('registry', { name }, async () => registryState());
const snap = (name) => step('snapshot', { name }, async () => snapshot());

const T0 = 1_700_000_000_000;
await writeConfig({ templateDirectories: [], discoverInstalledTemplates: false });
await setClock(T0);

// the pure helpers
await emptyState({});
await emptyState({ requiresVisualReview: true });
await emptyState({ includeSlidePlans: false });
await emptyState({ requiresVisualReview: true, includeSlidePlans: false });
await comFields({ mode: 'background', ownership: 'owned', visible: false, appPid: 12, windowHwnd: 34, foregroundActivated: true, backgroundIsolation: { desktop: 'mixdog' }, documentId: 'doc-1' });
await comFields({});
await comFields({ mode: 'attach', ownership: 'shared', visible: true, foregroundActivated: false, backgroundIsolation: null, appPid: null });
await comFields({ mode: 'visible', foregroundActivated: 'yes', backgroundIsolation: 0 });
await merge('both empty', undefined, undefined);
await merge('later wins', { profile: 'executive', review: true }, { profile: 'editorial' });
await merge('palette and typography by key', { palette: { a: 1, b: 2 }, typography: { h: 'x' } }, { palette: { b: 3 }, typography: { body: 'y' }, tone: 'calm' });
await merge('palette on one side', { profile: 'data' }, { palette: { accent: '#123456' } });
await merge('typography only on the left', { typography: { h: 'x' } }, {});
await merge('not objects', 'executive', ['a']);
await merge('a null palette stays', { palette: null }, { typography: null });

// resolveOfficeDesignContext: native documents stay native, the others bind the library
await context('native docx', { args: { design: { intent: 'Quarterly review', audience: 'board' } }, target: document('native.docx'), format: 'docx', created: true });
await context('native docx, no design', { args: {}, target: document('plain.docx'), format: 'docx', created: true });
await context('existing xlsx, no design', { args: {}, target: document('existing.xlsx'), format: 'xlsx', created: false });
await context('native pdf', { args: { design: { review: false } }, target: document('native.pdf'), format: 'pdf', created: true });
await context('docx with a profile', { args: { design: { profile: 'editorial', intent: 'Annual report' } }, target: document('profiled.docx'), format: 'docx', created: true });
await context('docx composer', { args: { operations: [{ op: 'compose_document' }], design: { intent: 'Plan' } }, target: document('composed.docx'), format: 'docx', created: true });
await context('xlsx composer', { args: { operations: [{ op: 'compose_sheet' }] }, target: document('composed.xlsx'), format: 'xlsx', created: true });
await context('new pptx', { args: { design: { profile: 'executive', intent: 'Board update' } }, target: document('deck.pptx'), format: 'pptx', created: true });
await context('new pptx, profile by name', { args: { design: 'technical' }, target: document('named.pptx'), format: 'pptx', created: true });
await context('existing pptx, no design', { args: {}, target: document('existing.pptx'), format: 'pptx', created: false });
await context('pptx with an unknown template', { args: { design: { template: 'nope' } }, target: document('unknown.pptx'), format: 'pptx', created: true });
await context('unsupported format', { args: {}, target: document('image.png'), format: 'png', created: true });

// sessions: opened, bound, registered
await open('native', { id: 'office_00000000000000a1', source: document('native.docx'), target: document('native.docx'), fileKind: 'docx', format: 'docx', mode: 'portable', backend: 'mixdog-ooxml', created: true, createdNewFile: true });
await ensure('native', { design: { intent: 'Quarterly review' } });
await ensure('native', { design: { reviewed: true } }, { preserveNativeDesign: true });
await ensure('native', {});
await ensure('native', { design: { palette: { accent: '#224466' } } });
await ensure('native', { design: { upgradeLibrary: true } }, { allowLibraryUpgrade: true });
await register('native');
await open('deck', { id: 'office_00000000000000a2', source: document('deck.pptx'), target: document('deck.pptx'), fileKind: 'pptx', format: 'pptx', mode: 'background', backend: 'mixdog-ooxml', created: true, createdNewFile: true });
await ensure('deck', { design: { profile: 'executive', intent: 'Board update' } });
await register('deck');
await snap('bindings after the deck');
await ensure('deck', { design: { profile: 'data' } });
await ensure('deck', { design: { palette: { accent: '#aa3300' }, typography: { heading: 'Georgia' } } });
await ensure('deck', { design: { upgradeLibrary: true } }, { allowLibraryUpgrade: true });
await ensure('deck', { design: { upgradeLibrary: true, profile: 'technical' } }, { allowLibraryUpgrade: true });
await ensure('deck', { design: { upgradeLibrary: true } });
await register('deck');
await open('existing deck', { id: 'office_00000000000000a3', source: document('existing.pptx'), target: document('existing.pptx'), fileKind: 'pptx', format: 'pptx', mode: 'portable', backend: 'mixdog-ooxml', created: false });
await ensure('existing deck', {});
await register('existing deck');
await open('copy', { id: 'office_00000000000000a4', source: document('deck.pptx'), target: document('deck.mixdog-edit.pptx'), fileKind: 'pptx', format: 'pptx', mode: 'background', backend: 'mixdog-ooxml', created: false });
await ensure('copy', {});
await register('copy');
await open('sheet', { id: 'office_00000000000000a5', source: document('book.xlsx'), target: document('book.xlsx'), fileKind: 'xlsx', format: 'xlsx', mode: 'portable', backend: 'mixdog-ooxml', created: true });
await ensure('sheet', { operations: [{ op: 'compose_sheet' }], design: { intent: 'Budget' } }, { created: true });
await register('sheet');
await open('same document', { id: 'office_00000000000000a6', source: document('native.docx'), target: document('native.docx'), fileKind: 'docx', format: 'docx', mode: 'portable', backend: 'mixdog-ooxml', created: false });
await ensure('same document', {}, { created: false });
await snap('bindings');

// the registry
await registry('after registering');
await forDocument(document('native.docx'));
await forDocument(document('DECK.PPTX'));
await forDocument(document('nothing.docx'));
await index('same document');
await forDocument(document('native.docx'));
await release('native');
await forDocument(document('native.docx'));
await release('same document');
await forDocument(document('native.docx'));
await release('same document');
await release('deck');
await registry('after releasing');
await index('deck');
await index('deck');
await registry('indexed again');

// ---- write ------------------------------------------------------------------------------------------------------------
const out = {
  note: 'Recorded from the session part of the Node office core; tests/twin_sessions.rs replays it.',
  script,
};
process.chdir(path.dirname(root));
rmSync(root, { recursive: true, force: true });
const fixtures = path.join(FIXTURES_ROOT, 'office-sessions');
mkdirSync(fixtures, { recursive: true });
const text = `${JSON.stringify(out, null, 2)}\n`;
writeFileSync(path.join(fixtures, 'golden.json'), text);
writeSetManifest(fixtures, { set: 'office-sessions', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${text.length} bytes`);
