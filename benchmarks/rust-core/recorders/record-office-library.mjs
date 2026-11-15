#!/usr/bin/env node
// Golden of the office design library (crate mixdog-office-design, module `library`): what Node's
// `runtime/office/design/library/design-library-core.mjs`, `design-library-pack.mjs` and `design-library.mjs` answer to a
// fixed corpus. Writes native/core/fixtures/office-library/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-library.mjs --tree <product tree>
//
// Sections: `pure` (safe ids, version order, canonical JSON, layout and sample normalisation, envelope verification,
// configuration reading) and `script` (steps run against one data directory: a fake network serving signed packs, sync,
// resolution, bindings, composition history, inspection and snapshots of the files written). The signing keys are
// generated here; the golden carries the public keys, the envelopes and the template bytes the replay needs, so
// replaying needs no randomness. The clock is fixed (`Date` is replaced by a clock the script sets) and every path
// is written relative to a placeholder for the temporary folder (`<root>`), with `/` separators.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-library.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);

// ---- the controlled world ---------------------------------------------------------------------------------------
const ENV_NAMES = [
  'MIXDOG_OFFICE_DESIGN_LIBRARY_CONFIG',
  'MIXDOG_OFFICE_DESIGN_PACK_URL',
  'MIXDOG_OFFICE_DESIGN_PACK_KEY_ID',
  'MIXDOG_OFFICE_DESIGN_PACK_PUBLIC_KEY',
  'MIXDOG_OFFICE_TEMPLATE_DIRS',
];
for (const name of ENV_NAMES) delete process.env[name];
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

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'office-library-')));
const dataDir = path.join(root, 'data');
const libraryRoot = path.join(dataDir, 'office', 'design-library');
process.chdir(root);

const library = await importFrom(tree, 'src/runtime/office/design/library/design-library.mjs');
const core = await importFrom(tree, 'src/runtime/office/design/library/design-library-core.mjs');
const packModule = await importFrom(tree, 'src/runtime/office/design/library/design-library-pack.mjs');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const slash = (text) => text.split(path.sep).join('/');
/** A text with the temporary folder as `<root>` and `/` as the separator. */
const scrubText = (text) => text.split(root).join('<root>').replaceAll('\\', '/');
/** A document's key (`sha256(canonicalPath(path))`, a hash of the temporary folder) written `<key docs/NAME>`. */
const documentKeys = new Map();
const scrub = (value) => {
  if (typeof value === 'string') return documentKeys.get(value) ?? scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrubText(key), scrub(item)]));
  return value;
};
/** The inverse for an input written with `<root>`: the real folder. */
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

// ---- keys, packs and the fake network ---------------------------------------------------------------------------
const ed = generateKeyPairSync('ed25519');
const otherEd = generateKeyPairSync('ed25519');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = (key) => key.export({ type: 'spki', format: 'pem' });
const KEYS = { 'key-1': pem(ed.publicKey), 'key-2': pem(otherEd.publicKey), 'rsa-key': pem(rsa.publicKey), garbage: 'not a key' };
const signEnvelope = (pack, keyId = 'key-1', key = ed.privateKey) => ({
  schemaVersion: 1,
  keyId,
  signature: sign(null, Buffer.from(core.canonicalOfficeDesignPack(pack)), key).toString('base64'),
  pack,
});

const TEMPLATE_ONE = Buffer.from('template-one:'.repeat(40));
const TEMPLATE_TWO = Buffer.from('template-two:'.repeat(55));
const BASE = 'https://packs.example.test';
const template = (id, bytes, url, extra = {}) => ({ id, label: `Deck ${id}`, format: 'pptx', url, sha256: sha256(bytes), bytes: bytes.length, ...extra });
const packOf = (version, templates, extra = {}) => ({
  id: 'Acme-Pack',
  version,
  channel: 'Stable',
  publishedAt: '2026-01-02T03:04:05.000Z',
  profiles: { Editorial: { extends: 'Base', formats: { pptx: { density: 'light' } }, tone: 'calm' } },
  defaultProfiles: { pptx: 'Editorial' },
  layouts: [
    {
      id: 'Cover-A',
      format: 'PPTX',
      kind: ' Cover ',
      templateId: 'Deck-One',
      purposes: ['Explain', 'explain', ' '],
      slots: [{ role: 'Title', shape: 1, type: 'TEXT', required: true, geometry: { x: 1 } }],
      capacity: { textSlots: 3, textArea: 5000 },
      priority: 5,
      defaults: { background: '111111' },
    },
    { id: 'Plain', kind: 'process' },
  ],
  templates,
  ...extra,
});
const ONE = template('deck-one', TEMPLATE_ONE, `${BASE}/t/deck-one.pptx`, {
  layouts: [{ id: 'inner', kind: 'process', slots: [{ role: 'title', shape: 2 }] }],
});
const TWO = template('deck-two', TEMPLATE_TWO, `${BASE}/t/deck-two.pptx`);
const PACK_1_0 = packOf('1.0.0', [ONE]);
const PACK_1_1 = packOf('1.1.0', [ONE, TWO]);
const PACK_0_9 = packOf('0.9.0', [ONE]);
const MANIFEST_URL = `${BASE}/manifest.json`;
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const json = (value) => Buffer.from(JSON.stringify(value));
const route = (body, extra = {}) => ({ status: 200, bodyBase64: b64(body), ...extra });
const templateRoutes = { [ONE.url]: route(TEMPLATE_ONE), [TWO.url]: route(TEMPLATE_TWO) };
const manifestRoute = (envelope, extra = {}) => route(json(envelope), { etag: `"${sha256(json(envelope)).slice(0, 8)}"`, conditional: true, ...extra });
const withManifest = (envelope, extra = {}) => ({ [MANIFEST_URL]: manifestRoute(envelope, extra), ...templateRoutes });

const tampered = signEnvelope(PACK_1_1);
tampered.pack = { ...tampered.pack, publishedAt: '2030-01-01T00:00:00.000Z' };
const wrongTemplateBytes = { ...templateRoutes, [ONE.url]: route(Buffer.from('x'.repeat(TEMPLATE_ONE.length))) };
const longTemplateBytes = { ...templateRoutes, [ONE.url]: route(Buffer.concat([TEMPLATE_ONE, Buffer.from('+')])) };
const shortTemplateBytes = { ...templateRoutes, [ONE.url]: route(TEMPLATE_ONE.subarray(0, 10)) };
const httpTemplate = signEnvelope(packOf('2.0.0', [{ ...ONE, url: 'http://packs.example.test/t/deck-one.pptx' }]));
const wrongExtension = signEnvelope(packOf('2.0.0', [{ ...ONE, url: `${BASE}/t/deck-one.docx` }]));
const badVersion = signEnvelope(packOf('1.0', [ONE]));
const otherPack = signEnvelope({ ...PACK_1_1, id: 'Other-Pack' });
const betaPack = signEnvelope({ ...PACK_1_1, channel: 'beta' });
const prerelease = signEnvelope(packOf('1.2.0-beta.1', [ONE]));

let routes = {};
let requests = [];
const fakeFetch = async (url, options = {}) => {
  const ifNoneMatch = options.headers?.['If-None-Match'] ?? null;
  requests.push({ url, ifNoneMatch });
  const served = routes[url];
  if (!served) throw new Error('fetch failed');
  const body = Buffer.from(served.bodyBase64 ?? '', 'base64');
  const notModified = served.conditional && ifNoneMatch && ifNoneMatch === served.etag;
  const status = notModified ? 304 : served.status;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => {
        const key = String(name).toLowerCase();
        if (key === 'content-length') return served.contentLength == null ? null : String(served.contentLength);
        if (key === 'etag') return served.etag ?? null;
        return null;
      },
    },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
};

// ---- pure cases ---------------------------------------------------------------------------------------------------
const pure = {};
pure.keys = KEYS;
pure.safeId = [];
for (const input of ['abc', '  A.b_c-1 ', '', null, 5, 0, '-x', 'a'.repeat(64), 'a'.repeat(65), 'Ünï', 'a b', '.a', 'a.']) {
  pure.safeId.push({ input, ...(await attempt(() => core.safeId(input, 'pack id'))) });
}
pure.versions = [];
for (const [left, right] of [['1.2.3', '1.2.4'], ['v2.0.0', '1.9.9'], ['1.0.0-beta', '1.0.0'], ['1.0.0-b', '1.0.0-a'], ['1.0.0', 'v1.0.0'], ['1.0', '1.0.0'], ['1.0.0-', '1.0.0'], [' 1.0.0 ', '1.0.0-rc.1'], ['10.0.0', '9.0.0'], ['1.0.0-a.b', '1.0.0-a-b']]) {
  pure.versions.push({ left, right, ...(await attempt(() => core.compareOfficeDesignVersions(left, right))) });
}
pure.canonical = [
  { b: 2, a: { z: 1, y: [3, { d: 1, c: 2 }] }, 10: 'x', 2: 'y' },
  { id: 'pack', templates: [{ sha256: 'f', bytes: 3 }] },
].map((input) => ({ input, value: core.canonicalOfficeDesignPack(input) }));
pure.layouts = [];
const layoutCases = [
  { value: null },
  { value: [] },
  { value: 'x' },
  { value: [5] },
  { value: [{ id: 'A', kind: 'Cover' }] },
  { value: [{ id: 'A', kind: 'Cover' }], templatePath: '/t/p.pptx' },
  { value: [{ id: 'A', format: 'PNG', kind: 'x' }] },
  { value: [{ id: 'A' }] },
  { value: [{ id: 'A', kind: 'x', defaults: { nope: 1, layout: 2, also: 3 } }] },
  { value: [{ id: 'A', kind: 'x', sourceSlide: 1.5 }] },
  { value: [{ id: 'A', kind: 'x', sourceSlide: 'abc', sourceLayout: 2 }] },
  { value: [{ id: 'A', kind: 'x', sourceLayout: -1 }] },
  { value: [{ id: 'A', kind: 'x', slots: [{ role: 'T', shape: 0 }] }] },
  { value: [{ id: 'A', kind: 'x', slots: [{ role: 'T', shape: 2, type: 'video' }] }] },
  { value: [{ id: 'A', kind: 'x', slots: [{ role: 'T', shape: 2, placeholderType: 'ctrTitle', placeholderIndex: null }, { role: 'U', shape: 3, placeholderIndex: 'x', geometry: [1] }] }] },
  { value: [{ id: 'A', kind: 'x', slots: 'no' }] },
  { value: [{ id: 'A', kind: 'x', capacity: { sampleTextChars: 5e6, shapeCount: -3, textSlots: '7', metricGroups: 'a' } }] },
  { value: [{ id: 'A', kind: 'x', priority: 500, strict: true, purposes: ['A', 'a', ' b '], expressionModes: 'x', capabilities: new Array(40).fill(0).map((_, i) => `c${i}`) }] },
  { value: [{ id: 'A', kind: 'x', profile: 'Bad Profile' }] },
  { value: [{ id: 'A', kind: 'x', templateId: 'Tpl' }] },
];
for (const input of layoutCases) {
  pure.layouts.push({ input, ...(await attempt(() => packModule.normalizeLayouts(input.value, input.templatePath ? { templatePath: input.templatePath } : {}))) });
}
pure.samples = [];
for (const input of [
  null,
  [],
  [{ slide: 1 }],
  [{ slide: 0 }],
  [{ slide: 2, id: 'Cover', kind: ' Cover ', roles: { 1: 'Title', '02': 'Sub', 10: 'Body' }, defaults: { layout: 'x' }, priority: -500, strict: true }],
  [{ slide: 2, roles: { x: 'a' } }],
  [{ slide: 2, roles: { 1: 'Bad Role' } }],
  [{ slide: 2, defaults: { zzz: 1 } }],
  [5],
  'no',
]) {
  pure.samples.push({ input, ...(await attempt(() => packModule.normalizeLocalSamples(input))) });
}
const verifyCases = [
  { name: 'valid', envelope: signEnvelope(PACK_1_1), trustedKeys: { 'key-1': KEYS['key-1'] } },
  { name: 'tampered', envelope: tampered, trustedKeys: { 'key-1': KEYS['key-1'] } },
  { name: 'other key', envelope: signEnvelope(PACK_1_1, 'key-1', otherEd.privateKey), trustedKeys: { 'key-1': KEYS['key-1'] } },
  { name: 'untrusted', envelope: signEnvelope(PACK_1_1, 'key-2'), trustedKeys: { 'key-1': KEYS['key-1'] } },
  { name: 'bad schema', envelope: { ...signEnvelope(PACK_1_1), schemaVersion: 2 }, trustedKeys: { 'key-1': KEYS['key-1'] } },
  { name: 'not an object', envelope: [], trustedKeys: {} },
  { name: 'short signature', envelope: { ...signEnvelope(PACK_1_1), signature: 'AAAA' }, trustedKeys: { 'key-1': KEYS['key-1'] } },
  { name: 'rsa key', envelope: { ...signEnvelope(PACK_1_1), keyId: 'rsa-key' }, trustedKeys: { 'rsa-key': KEYS['rsa-key'] } },
  { name: 'garbage key', envelope: { ...signEnvelope(PACK_1_1), keyId: 'garbage' }, trustedKeys: { garbage: KEYS.garbage } },
  { name: 'bad key id', envelope: { ...signEnvelope(PACK_1_1), keyId: 'Bad Key' }, trustedKeys: {} },
  { name: 'bad version', envelope: badVersion, trustedKeys: { 'key-1': KEYS['key-1'] } },
  { name: 'http template', envelope: httpTemplate, trustedKeys: { 'key-1': KEYS['key-1'] } },
  { name: 'wrong extension', envelope: wrongExtension, trustedKeys: { 'key-1': KEYS['key-1'] } },
  { name: 'duplicate template', envelope: signEnvelope(packOf('1.0.0', [ONE, ONE])), trustedKeys: { 'key-1': KEYS['key-1'] } },
  { name: 'profile format', envelope: signEnvelope(packOf('1.0.0', [], { profiles: { a: { formats: { gif: {} } } } })), trustedKeys: { 'key-1': KEYS['key-1'] } },
  { name: 'profile not object', envelope: signEnvelope(packOf('1.0.0', [], { profiles: { a: 5 } })), trustedKeys: { 'key-1': KEYS['key-1'] } },
  { name: 'default format', envelope: signEnvelope(packOf('1.0.0', [], { defaultProfiles: { gif: 'x' } })), trustedKeys: { 'key-1': KEYS['key-1'] } },
  { name: 'prerelease', envelope: prerelease, trustedKeys: { 'key-1': KEYS['key-1'] } },
];
pure.verify = [];
for (const input of verifyCases) {
  pure.verify.push({ input, ...(await attempt(() => library.verifyOfficeDesignPackEnvelope(input.envelope, input.trustedKeys))) });
}

// loadConfig: an override object or the config file, with the environment variables.
const CONFIG_FILE = path.join(libraryRoot, 'config.json');
const configCases = [
  { name: 'empty' },
  { name: 'override', override: { manifestUrl: ' https://x.test/m.json ', trustedKeys: { a: 'k' }, packId: 'Pk', channel: ' Beta ', checkIntervalMs: 5, templateDirectories: ['<root>/tpl', 'rel/dir', '', '<root>/tpl'], defaultTemplates: { docx: 'd' } } },
  { name: 'interval high', override: { checkIntervalMs: 999999999999 } },
  { name: 'interval text', override: { checkIntervalMs: '45000' } },
  { name: 'interval zero', override: { checkIntervalMs: 0 } },
  { name: 'bad pack id', override: { packId: 'Bad Id' } },
  { name: 'discover explicit', override: { discoverInstalledTemplates: true, templateDirectories: ['<root>/only'] } },
  { name: 'discover off', override: { discoverInstalledTemplates: false } },
  { name: 'discover null', override: { discoverInstalledTemplates: null } },
  { name: 'discover default', override: {}, discover: true },
  { name: 'default pptx kept', override: { defaultTemplates: { pptx: 'mine' } }, discover: true },
  { name: 'default pptx falsy', override: { defaultTemplates: { pptx: '' } }, discover: true },
  { name: 'env', override: { trustedKeys: { environment: 'old' } }, env: { MIXDOG_OFFICE_DESIGN_PACK_URL: 'https://env.test/m.json', MIXDOG_OFFICE_DESIGN_PACK_PUBLIC_KEY: ' line1\\nline2 ', MIXDOG_OFFICE_TEMPLATE_DIRS: '<root>/envdir' } },
  { name: 'env key id', override: {}, env: { MIXDOG_OFFICE_DESIGN_PACK_KEY_ID: 'Mine', MIXDOG_OFFICE_DESIGN_PACK_PUBLIC_KEY: 'abc' } },
  { name: 'env relative dir', env: { MIXDOG_OFFICE_TEMPLATE_DIRS: 'rel/envdir' }, override: null },
  { name: 'config file', file: { manifestUrl: 'https://file.test/m.json', templateDirectories: ['sub/dir'], discoverInstalledTemplates: false } },
  { name: 'config file elsewhere', file: { manifestUrl: 'https://elsewhere.test/m.json', templateDirectories: ['sub/dir'] }, env: { MIXDOG_OFFICE_DESIGN_LIBRARY_CONFIG: '<root>/cfg/lib.json' }, fileAt: '<root>/cfg/lib.json' },
  { name: 'config file relative env', file: { manifestUrl: 'https://rel.test/m.json' }, env: { MIXDOG_OFFICE_DESIGN_LIBRARY_CONFIG: 'cfg2/lib.json' }, fileAt: '<root>/cfg2/lib.json' },
  { name: 'config file not an object', fileText: '[1,2]' },
  { name: 'config file broken', fileText: '{nope' },
];
pure.config = [];
const BUNDLED = core.defaultOfficeTemplateDirectories({ platform: 'linux' })[0];
for (const input of configCases) {
  for (const name of ENV_NAMES) delete process.env[name];
  rmSync(path.join(root, 'cfg'), { recursive: true, force: true });
  rmSync(path.join(root, 'cfg2'), { recursive: true, force: true });
  rmSync(libraryRoot, { recursive: true, force: true });
  for (const [name, value] of Object.entries(input.env ?? {})) process.env[name] = unscrub(value);
  const at = input.fileAt ? unscrub(input.fileAt) : CONFIG_FILE;
  if (input.file || input.fileText) {
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, input.fileText ?? JSON.stringify(input.file));
  }
  const override = input.override === undefined ? null : unscrub(input.override);
  const result = await attempt(async () => {
    const config = await core.loadConfig(dataDir, override);
    const text = JSON.stringify(config).split(BUNDLED.replaceAll('\\', '\\\\')).join('<bundled>');
    return JSON.parse(text);
  });
  pure.config.push({ input, ...result });
}
for (const name of ENV_NAMES) delete process.env[name];
rmSync(libraryRoot, { recursive: true, force: true });
rmSync(path.join(root, 'cfg'), { recursive: true, force: true });
rmSync(path.join(root, 'cfg2'), { recursive: true, force: true });
pure.defaultDirectories = [
  {
    input: { windows: true },
    value: scrub(core.defaultOfficeTemplateDirectories({ platform: 'win32', environment: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', APPDATA: 'C:\\Users\\twin\\AppData\\Roaming' }, home: 'C:\\Users\\twin' }).slice(1)),
  },
  { input: { windows: true, partial: true }, value: scrub(core.defaultOfficeTemplateDirectories({ platform: 'win32', environment: { PROGRAMFILES: 'D:\\PF\\..\\Apps' }, home: '' }).slice(1)) },
  { input: { windows: false }, value: scrub(core.defaultOfficeTemplateDirectories({ platform: 'linux', environment: {}, home: '/home/x' }).slice(1)) },
];

// ---- the script -------------------------------------------------------------------------------------------------------
const CONFIG = (extra = {}) => ({ manifestUrl: MANIFEST_URL, trustedKeys: { 'key-1': KEYS['key-1'] }, templateDirectories: [], discoverInstalledTemplates: false, ...extra });
const DOCUMENT = (name) => {
  const document = path.join(root, 'docs', name);
  documentKeys.set(sha256(core.canonicalPath(document)), `<key docs/${name}>`);
  return document;
};

/** Every file under the library folder: parsed JSON, else its size and digest. Binding files are named by what they bind. */
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
        const expected = `${sha256(core.canonicalPath(value.documentPath))}.json${suffix}`;
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

const script = [];
const step = async (op, input, run) => {
  requests = [];
  const result = run ? await attempt(run) : {};
  const entry = { op, ...scrub(input) };
  if (result.value !== undefined) entry.value = result.value;
  if (result.error !== undefined) entry.error = result.error;
  if (requests.length) entry.requests = requests;
  script.push(entry);
};
const setClock = (ms) => step('setClock', { ms }, async () => {
  clock = ms;
});
const setRoutes = (name, value) => step('setRoutes', { name, routes: value }, async () => {
  routes = value;
});
const reset = () => step('reset', {}, async () => {
  rmSync(libraryRoot, { recursive: true, force: true });
});
const sync = (name, input = {}) => step('sync', { name, ...input }, async () => library.syncOfficeDesignLibrary({ dataDir, fetchImpl: fakeFetch, ...unscrub(input) }));
const snap = (name) => step('snapshot', { name }, async () => snapshot());
const resolve = (name, input) => step('resolve', { name, ...input }, async () => library.resolveOfficeDesignLibrary({ dataDir, fetchImpl: fakeFetch, ...unscrub(input) }));
const persist = (name, documentPath, binding) => step('persistBinding', { name, documentPath, binding }, async () => library.persistOfficeDesignBinding(dataDir, unscrub(documentPath), binding));
const record = (name, input) => step('recordHistory', { name, ...input }, async () => library.recordOfficeCompositionHistory(dataDir, unscrub(input)));
const readHistory = (name, input) => step('readHistory', { name, ...input }, async () => library.readOfficeCompositionHistory(dataDir, unscrub(input)));
const inspect = (name, input = {}) => step('inspect', { name, ...input }, async () => library.inspectOfficeDesignLibrary({ dataDir, ...unscrub(input) }));
const removeFile = (name, relative) => step('remove', { name, relative }, async () => {
  rmSync(path.join(libraryRoot, relative), { recursive: true, force: true });
});

const T0 = 1_700_000_000_000;
await reset();
await setClock(T0);
await sync('no manifest url', { config: CONFIG({ manifestUrl: '' }), indexTemplates: false });
await snap('after a sync without a pack server');
await setRoutes('pack 1.0.0', withManifest(signEnvelope(PACK_1_0)));
await sync('first pack', { config: CONFIG(), force: true, indexTemplates: false });
await snap('first pack cached');
await setClock(T0 + 60_000);
await sync('not due', { config: CONFIG(), indexTemplates: false });
await sync('remote not allowed', { config: CONFIG(), force: true, allowRemote: false, indexTemplates: false });
await setClock(T0 + 10 * 60_000);
await sync('due, not modified', { config: CONFIG(), indexTemplates: false });
await snap('after not modified');
await setRoutes('pack 1.1.0', withManifest(signEnvelope(PACK_1_1)));
await setClock(T0 + 20 * 60_000);
await sync('newer pack', { config: CONFIG(), indexTemplates: false });
await snap('newer pack cached beside the first');
await setRoutes('pack 0.9.0', withManifest(signEnvelope(PACK_0_9)));
await sync('older pack is not activated', { config: CONFIG(), force: true, indexTemplates: false });
await setRoutes('pack 1.2.0-beta.1', withManifest(prerelease));
await sync('prerelease above the active one', { config: CONFIG(), force: true, indexTemplates: false });
await setRoutes('pack 1.1.0 again', withManifest(signEnvelope(PACK_1_1)));
await sync('same version again', { config: CONFIG(), force: true, indexTemplates: false });
await inspect('active pack', { config: CONFIG() });
await setClock(T0 + 30 * 60_000);
await setRoutes('tampered pack', withManifest(tampered));
await sync('tampered signature', { config: CONFIG(), force: true, indexTemplates: false });
await snap('after a tampered pack');
await setRoutes('declared oversize manifest', { [MANIFEST_URL]: route(Buffer.from('{}'), { contentLength: 3 * 1024 * 1024 }) });
await sync('manifest over the limit', { config: CONFIG(), force: true, indexTemplates: false });
await setRoutes('manifest error status', { [MANIFEST_URL]: { status: 500, bodyBase64: '' } });
await sync('manifest http 500', { config: CONFIG(), force: true, indexTemplates: false });
await setRoutes('manifest not json', { [MANIFEST_URL]: route(Buffer.from('<html>nope</html>')) });
await sync('manifest not json', { config: CONFIG(), force: true, indexTemplates: false });
await setRoutes('network down', {});
await sync('network failure', { config: CONFIG(), force: true, indexTemplates: false });
await sync('plain http manifest', { config: CONFIG({ manifestUrl: 'http://packs.example.test/manifest.json' }), force: true, indexTemplates: false });
await sync('manifest url not a url', { config: CONFIG({ manifestUrl: 'packs' }), force: true, indexTemplates: false });
await setRoutes('pack 1.1.0 for config checks', withManifest(otherPack));
await sync('pack id mismatch', { config: CONFIG({ packId: 'Acme-Pack' }), force: true, indexTemplates: false });
await setRoutes('beta pack', withManifest(betaPack));
await sync('channel mismatch', { config: CONFIG(), force: true, indexTemplates: false });
await sync('channel match', { config: CONFIG({ channel: 'BETA', packId: 'acme-pack' }), force: true, indexTemplates: false });
await snap('after a beta pack of the same version');
await inspect('after errors');
await reset();
await setClock(T0 + 40 * 60_000);
await setRoutes('template sha mismatch', { ...withManifest(signEnvelope(PACK_1_0)), ...wrongTemplateBytes });
await sync('template digest', { config: CONFIG(), force: true, indexTemplates: false });
await setRoutes('template too long', { ...withManifest(signEnvelope(PACK_1_0)), ...longTemplateBytes });
await sync('template longer than declared', { config: CONFIG(), force: true, indexTemplates: false });
await setRoutes('template too short', { ...withManifest(signEnvelope(PACK_1_0)), ...shortTemplateBytes });
await sync('template shorter than declared', { config: CONFIG(), force: true, indexTemplates: false });
await setRoutes('template missing', { [MANIFEST_URL]: manifestRoute(signEnvelope(PACK_1_0)) });
await sync('template unreachable', { config: CONFIG(), force: true, indexTemplates: false });
await setRoutes('http template', withManifest(httpTemplate));
await sync('template over http', { config: CONFIG(), force: true, indexTemplates: false });
await snap('nothing cached after the refused packs');
await inspect('nothing active');

// resolution, bindings and history over a cached pack
await reset();
await setClock(T0 + 50 * 60_000);
await setRoutes('pack 1.0.0 for resolution', withManifest(signEnvelope(PACK_1_0)));
await sync('cache 1.0.0', { config: CONFIG(), force: true, indexTemplates: false });
await setClock(T0 + 51 * 60_000);
await setRoutes('pack 1.1.0 for resolution', withManifest(signEnvelope(PACK_1_1)));
await sync('cache 1.1.0', { config: CONFIG(), force: true, indexTemplates: true });
await snap('both packs and an index');
await resolve('new pptx', { documentPath: DOCUMENT('a.pptx'), format: 'PPTX', created: true, request: {}, config: CONFIG() });
await resolve('new pptx with a template', { documentPath: DOCUMENT('a.pptx'), format: 'pptx', created: true, request: { template: 'DECK-TWO' }, config: CONFIG() });
await resolve('new docx', { documentPath: DOCUMENT('a.docx'), format: 'docx', created: true, request: {}, config: CONFIG() });
await resolve('template not indexed', { documentPath: DOCUMENT('a.pptx'), format: 'pptx', created: true, request: { template: 'nope' }, config: CONFIG() });
await resolve('template of another format', { documentPath: DOCUMENT('a.docx'), format: 'docx', created: true, request: { template: 'deck-one' }, config: CONFIG() });
await resolve('template by path', { documentPath: DOCUMENT('a.pptx'), format: 'pptx', created: true, request: { template: path.join(libraryRoot, 'packs', 'acme-pack', '1.1.0', 'templates', 'deck-one.pptx') }, config: CONFIG() });
await resolve('pack id without version', { documentPath: DOCUMENT('a.pptx'), format: 'pptx', created: true, request: { packId: 'acme-pack' }, config: CONFIG() });
await resolve('pack version without id', { documentPath: DOCUMENT('a.pptx'), format: 'pptx', created: true, request: { packVersion: '1.0.0' }, config: CONFIG() });
await resolve('pack not cached', { documentPath: DOCUMENT('a.pptx'), format: 'pptx', created: true, request: { packId: 'acme-pack', packVersion: '9.9.9' }, config: CONFIG() });
await resolve('pack bad id', { documentPath: DOCUMENT('a.pptx'), format: 'pptx', created: true, request: { packId: 'Bad Id', packVersion: '1.0.0' }, config: CONFIG() });
await resolve('older pack by request', { documentPath: DOCUMENT('b.pptx'), format: 'pptx', created: true, request: { packId: 'Acme-Pack', packVersion: '1.0.0', template: 'deck-one' }, config: CONFIG() });
await resolve('unsupported format', { documentPath: DOCUMENT('a.png'), format: 'png', created: true, request: {}, config: CONFIG() });
await resolve('existing unbound document', { documentPath: DOCUMENT('c.pptx'), format: 'pptx', created: false, request: {}, config: CONFIG() });
await resolve('existing unbound document with a template', { documentPath: DOCUMENT('c.pptx'), format: 'pptx', created: false, request: { template: 'deck-one' }, config: CONFIG() });
await resolve('default template', { documentPath: DOCUMENT('d.pptx'), format: 'pptx', created: true, request: {}, config: CONFIG({ defaultTemplates: { pptx: 'deck-two' } }) });
await setClock(T0 + 52 * 60_000);
await persist('bind b to the older pack', DOCUMENT('b.pptx'), { source: 'remote-pack', format: 'pptx', packId: 'acme-pack', packVersion: '1.0.0', keyId: 'key-1', templateId: 'deck-one', templateVersion: '1.0.0', templateSource: 'remote-pack', pinnedAt: '2026-01-01T00:00:00.000Z' });
await persist('bind c with no pack', DOCUMENT('c.pptx'), { source: 'mixdog-starter', format: 'pptx', packId: '', packVersion: '', keyId: '', templateId: '', templateVersion: '', templateSource: '', pinnedAt: 'x' });
await persist('bind e to a vanished template', DOCUMENT('e.pptx'), { source: 'remote-pack', format: 'pptx', packId: 'acme-pack', packVersion: '1.1.0', keyId: 'key-1', templateId: 'deck-one', templateVersion: '7.7.7', templateSource: 'remote-pack', pinnedAt: 'x' });
await persist('bind f to a missing pack', DOCUMENT('f.pptx'), { source: 'remote-pack', format: 'pptx', packId: 'acme-pack', packVersion: '5.0.0', keyId: 'key-1', templateId: 'deck-one', templateVersion: '5.0.0', templateSource: 'remote-pack', pinnedAt: 'x' });
await persist('rebind b', DOCUMENT('b.pptx'), { source: 'remote-pack', format: 'pptx', packId: 'acme-pack', packVersion: '1.0.0', keyId: 'key-1', templateId: 'deck-one', templateVersion: '1.0.0', templateSource: 'remote-pack', pinnedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 9, extra: { n: 1 } });
await persist('no binding', DOCUMENT('g.pptx'), null);
await snap('bindings written');
await resolve('pinned to the older pack', { documentPath: DOCUMENT('b.pptx'), format: 'pptx', created: false, request: {}, config: CONFIG() });
await resolve('pinned, no pack', { documentPath: DOCUMENT('c.pptx'), format: 'pptx', created: false, request: {}, config: CONFIG() });
await resolve('pinned, template gone', { documentPath: DOCUMENT('e.pptx'), format: 'pptx', created: false, request: {}, config: CONFIG() });
await resolve('pinned, pack gone', { documentPath: DOCUMENT('f.pptx'), format: 'pptx', created: false, request: {}, config: CONFIG() });
await resolve('copy inherits the source binding', { documentPath: DOCUMENT('copy-of-b.pptx'), sourcePath: DOCUMENT('b.pptx'), format: 'pptx', created: false, request: {}, config: CONFIG() });
await resolve('created ignores the binding', { documentPath: DOCUMENT('b.pptx'), format: 'pptx', created: true, request: {}, config: CONFIG() });
await resolve('upgrade ignores the binding', { documentPath: DOCUMENT('b.pptx'), format: 'pptx', created: false, request: { upgradeLibrary: true }, config: CONFIG() });
await removeFile('delete the cached 1.0.0 envelope', 'packs/acme-pack/1.0.0/envelope.json');
await resolve('pinned, envelope gone', { documentPath: DOCUMENT('b.pptx'), format: 'pptx', created: false, request: {}, config: CONFIG() });
await removeFile('delete a cached template', 'packs/acme-pack/1.1.0/templates/deck-two.pptx');
await inspect('integrity failure', { config: CONFIG() });
await resolve('new document, cached pack damaged', { documentPath: DOCUMENT('h.pptx'), format: 'pptx', created: true, request: {}, config: CONFIG() });
await inspect('no pack server', {});

// composition history
await reset();
const history = (n, extra = {}) => ({ documentPath: DOCUMENT(`h${n}.pptx`), format: n % 3 === 0 ? 'docx' : 'pptx', profile: 'Editorial', purpose: 'explain', expressionMode: 'strong-fit', fingerprint: `fp-${n}`, compositionIds: [`c${n}`, ' c1 ', 'c1', ''], ...extra });
for (let n = 1; n <= 4; n += 1) {
  await setClock(T0 + n * 1000);
  await record(`record ${n}`, history(n));
}
await record('same document again', history(2, { fingerprint: 'fp-2b', compositionIds: ['z'] }));
await record('no fingerprint', history(5, { fingerprint: '' }));
await record('unsupported format', history(5, { format: 'png' }));
await record('ids over the cap', history(6, { compositionIds: Array.from({ length: 70 }, (_, i) => `id${i}`) }));
await readHistory('all', {});
await readHistory('pptx only', { format: 'PPTX' });
await readHistory('docx', { format: 'docx' });
await readHistory('exclude a document', { excludeDocumentPath: DOCUMENT('h1.pptx') });
await readHistory('limit 2', { limit: 2 });
await readHistory('limit 0 is 24', { limit: 0 });
await readHistory('limit 2.9', { limit: 2.9 });
await readHistory('negative limit', { limit: -5 });
await readHistory('limit text', { limit: '3' });
await snap('history file');
for (let n = 100; n < 160; n += 1) {
  await setClock(T0 + n * 1000);
  await record(`cap ${n}`, history(n, { format: 'pptx' }));
}
await readHistory('capped at 48', { limit: 100 });
await readHistory('default limit after the cap', {});
await step('historyLength', {}, async () => JSON.parse(readFileSync(path.join(libraryRoot, 'composition-history.json'), 'utf8')).records.length);
await removeFile('damage the history', 'composition-history.json');
await readHistory('history missing', {});
await step('writeDamaged', {}, async () => {
  writeFileSync(path.join(libraryRoot, 'composition-history.json'), '{"records": 5}');
});
await readHistory('records not an array', {});
await inspect('empty library');

// ---- write ------------------------------------------------------------------------------------------------------------
const out = {
  note: 'Recorded from the Node office design library modules; tests/twin_library.rs replays it.',
  keys: KEYS,
  pure,
  script,
};
process.chdir(path.dirname(root));
rmSync(root, { recursive: true, force: true });
const fixtures = path.join(FIXTURES_ROOT, 'office-library');
mkdirSync(fixtures, { recursive: true });
const text = `${JSON.stringify(out, null, 2)}\n`;
writeFileSync(path.join(fixtures, 'golden.json'), text);
writeSetManifest(fixtures, { set: 'office-library', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${text.length} bytes`);
