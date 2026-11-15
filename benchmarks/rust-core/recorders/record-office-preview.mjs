#!/usr/bin/env node
// What Node's document preview answers (src/runtime/office/pdf/document-preview.mjs), for the Rust module
// mixdog_office_pdf::preview (crates/mixdog-office-pdf/tests/twin_preview.rs replays it):
//   documents  the files the cases open: plain and legacy containers, binary presentations and Word documents with and without
//              protection, encrypted OOXML packages (agile with every hash name, standard, tampered, with malformed or absent
//              integrity data), built with the container writer of the Node tests (cfb-fixture.mjs);
//   cases      sequences of previews of those documents with fake engines (LibreOffice present or hidden, Microsoft Office
//              installed or not and what its host answers): the result of each step (format, size, cached, where the PDF is, the
//              coded error and its message), the calls each engine got (the content it was handed, never the password in the
//              wrong place), what is left in the cache directory and in the scratch tracking;
//   pages      sequences of page requests over a PDF with a fake rasteriser: the reply, the rasteriser's calls and the files
//              the disk cache holds.
//
//   node benchmarks/rust-core/recorders/record-office-preview.mjs --tree <product tree with node_modules>
//
// Output: native/core/fixtures/office-preview/golden.json (and its MANIFEST.json). The product tree is only read; the documents
// are written under the staging directory and removed again.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'office-preview');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-office-preview.mjs';
const work = join(stage, '.work');
mkdirSync(work, { recursive: true });

const fixture = await importFrom(tree, 'src/runtime/office/pdf/cfb-fixture.mjs');
const preview = await importFrom(tree, 'src/runtime/office/pdf/document-preview.mjs');
const { buildCfb, currentUserStream, encryptedOoxmlEntries, encryptOoxmlEntries, wordDocumentStream } = fixture;

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PASSWORD = 'Korée päss \u{1F511}';
const PLAIN = Buffer.concat([Buffer.from('PK\x03\x04 plain package '), Buffer.alloc(3000, 0x41)]);

// ---- documents -------------------------------------------------------------------------------------------------
const documents = {};
const add = (name, bytes) => {
  documents[name] = Buffer.from(bytes);
};
const presentation = (token) => buildCfb([currentUserStream(token), { name: 'PowerPoint Document', data: Buffer.alloc(6000, 7) }]);
const token = Buffer.from([0xdf, 0xc4, 0xd1, 0xf3]);
const strayToken = Buffer.concat([Buffer.alloc(64), token, Buffer.alloc(64)]);
add('zip-bytes', Buffer.from('PK\x03\x04 zip bytes'));
add('source-bytes', Buffer.from('source bytes'));
add('legacy-cfb', buildCfb([{ name: 'WordDocument', data: Buffer.alloc(9000, 1) }, { name: '1Table', data: Buffer.alloc(5000, 2) }]));
add('ppt-locked', presentation(0xf3d1c4df));
add('ppt-open', presentation(0xe391c05f));
add('ppt-stray-bytes', strayToken);
add('ppt-stray-stream', buildCfb([{ name: 'PowerPoint Document', data: strayToken }]));
add('ooxml-unsupported', buildCfb(encryptedOoxmlEntries()));
add('word-encrypted', buildCfb([wordDocumentStream(true), { name: '1Table', data: Buffer.alloc(5000, 2) }]));
add('word-plain', buildCfb([wordDocumentStream(false), { name: '1Table', data: Buffer.alloc(5000, 2) }]));

const encrypted = (options = {}) => encryptOoxmlEntries(PLAIN, PASSWORD, options);
const container = (entries) => buildCfb(entries);
add('agile', container(encrypted()));
add('standard', container(encrypted({ scheme: 'standard' })));
for (const hashAlgorithm of ['SHA-1', 'SHA1', 'SHA256', 'SHA384']) add(`agile-${hashAlgorithm}`, container(encrypted({ hashAlgorithm })));
add('agile-no-integrity', container(encrypted({ integrity: false })));
const tampered = (change) => {
  const [info, encryptedPackage, ...rest] = encrypted();
  const data = Buffer.from(encryptedPackage.data);
  change(data);
  return container([info, { ...encryptedPackage, data }, ...rest]);
};
add('tampered-byte', tampered((data) => { data[100] ^= 1; }));
add('tampered-size', tampered((data) => data.writeBigUInt64LE(BigInt(PLAIN.length - 1), 0)));
const [info, ...rest] = encrypted();
const AGILE_HEADER = Buffer.from([4, 0, 4, 0, 0x40, 0, 0, 0]);
const xml = info.data.subarray(8).toString('utf8');
const withXml = (text) => Buffer.concat([AGILE_HEADER, Buffer.from(text, 'utf8')]);
const broken = {
  'empty-hmac-key': xml.replace(/encryptedHmacKey="[^"]*"/, 'encryptedHmacKey=""'),
  'hmac-key-of-neither-length': xml.replace(/encryptedHmacKey="[^"]*"/, `encryptedHmacKey="${Buffer.alloc(32).toString('base64')}"`),
  'hmac-value-not-base64': xml.replace(/encryptedHmacValue="[^"]*"/, 'encryptedHmacValue="%%%%"'),
  'hmac-value-wrong-length': xml.replace(/encryptedHmacValue="[^"]*"/, `encryptedHmacValue="${Buffer.alloc(16).toString('base64')}"`),
  'no-hmac-value': xml.replace(/ encryptedHmacValue="[^"]*"/, ''),
};
for (const [name, text] of Object.entries(broken)) add(`integrity-${name}`, container([{ ...info, data: withXml(text) }, ...rest]));
for (const [hashAlgorithm, keySaltSize, hmacSaltSize] of [['SHA512', 16, 64], ['SHA512', 129, 129], ['SHA-1', 16, 20], ['SHA-1', 129, 129]]) {
  add(`salts-${hashAlgorithm}-${keySaltSize}-${hmacSaltSize}`, container(encrypted({ hashAlgorithm, keySaltSize, hmacSaltSize })));
}
add('salts-flipped', container((() => {
  const entries = encrypted({ hashAlgorithm: 'SHA512', keySaltSize: 129, hmacSaltSize: 129 });
  const data = Buffer.from(entries[1].data);
  data[100] ^= 1;
  return [entries[0], { ...entries[1], data }, ...entries.slice(2)];
})()));
// A descriptor whose password hashing takes seconds: the full 10,000,000 rounds the spec allows. Only the Rust cancellation test
// opens it; Node's recording holds no case for it.
add('slow-spin', container([{ ...info, data: withXml(xml.replace('spinCount="1000"', 'spinCount="10000000"')) }, ...rest]));

// ---- fake engines ------------------------------------------------------------------------------------------------------
// What a case says about its engines: libreOffice (whether it answers), installed (the Office families found), office (what its
// host answers: 'ok', 'fail', 'wrong-password', 'protected', 'echo-password', 'no-error').
function engines(spec, calls, scratchSeen) {
  return {
    removeBackoffMs: 1,
    libreOfficeAvailable: async () => spec.libreOffice === true,
    renderLibreOffice: async (path, output) => {
      calls.libreOffice.push({ file: basename(path), sourceUntouched: !path.startsWith(spec.root), sha256: sha(readFileSync(path)) });
      writeFileSync(output, 'pdf from libreoffice');
    },
    detectOffice: async (request) => {
      calls.detect.push(request);
      return { ok: true, applications: (spec.installed ?? []).map((format) => ({ format, installed: true })) };
    },
    callOffice: async (payload, options) => {
      scratchSeen.push(dirname(payload.path));
      calls.office.push({
        action: payload.action,
        format: payload.format,
        mode: payload.mode,
        readOnly: payload.readOnly,
        keys: Object.keys(payload).sort(),
        file: basename(payload.path),
        copyIsSource: payload.path === spec.source,
        copyExisted: existsSync(payload.path),
        outputInCache: payload.output.startsWith(spec.cacheRoot),
        outputName: basename(payload.output),
        passwordIsTheGiven: payload.password === spec.password,
        timeoutMs: options.timeoutMs,
        sha256: sha(readFileSync(payload.path)),
      });
      const office = spec.office ?? 'ok';
      if (office === 'ok') {
        writeFileSync(payload.output, 'pdf from office');
        return { ok: true, output: payload.output };
      }
      if (office === 'fail') return { ok: false, error: 'Excel could not open the file' };
      if (office === 'wrong-password') return { ok: false, error: "That password didn't work. (OFFICE_PREVIEW_WRONG_PASSWORD)" };
      if (office === 'protected') return { ok: false, error: 'This file is password-protected. (OFFICE_PREVIEW_PASSWORD_PROTECTED)' };
      if (office === 'echo-password') return { ok: false, error: `Word failed opening ${spec.password} somehow` };
      return { ok: false };
    },
  };
}

// ---- cases -------------------------------------------------------------------------------------------------------------
const keyOf = (text) => text.replace(/\b[0-9a-f]{32}\b/g, '<key>').replace(/\b[0-9a-f]{16}-[0-9a-f]{16}\b/g, '<revision>');
function listing(root) {
  const out = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(directory, entry.name));
      else out.push(keyOf(relative(root, join(directory, entry.name)).replaceAll('\\', '/')));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}
const directories = (root) => (existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length : 0);

const cases = [];
let caseNumber = 0;
async function record(name, document, fileName, spec, steps) {
  caseNumber += 1;
  const dir = join(work, `case-${caseNumber}`);
  mkdirSync(dir, { recursive: true });
  const source = join(dir, fileName);
  if (document) writeFileSync(source, documents[document]);
  const cacheRoot = join(dir, 'cache');
  const calls = { libreOffice: [], detect: [], office: [] };
  const scratchSeen = [];
  const recorded = [];
  const shown = (text) => String(text).replaceAll(dir, '<dir>').replaceAll(dir.replaceAll('\\', '/'), '<dir>');
  for (const step of steps) {
    const before = new Set(preview.trackedPreviewScratch());
    const fakes = engines({ ...spec, ...step, root: dir, source, cacheRoot, password: step.password ?? '' }, calls, scratchSeen);
    const options = { cacheRoot: step.noCacheRoot ? '' : cacheRoot, engines: fakes, password: step.password ?? '' };
    // The cache PDF the host is told to write is `<cacheRoot>/document-previews/<key>/preview.pdf`: it is the one in the cache.
    const outcome = async () => {
      const result = await preview.documentPreviewPdf(step.document ? join(dir, step.document) : source, options);
      const inCache = result.path.startsWith(cacheRoot);
      return {
        ok: true,
        format: result.format,
        size: result.size,
        cached: result.cached,
        location: inCache ? 'cache' : 'scratch',
        pdf: existsSync(result.path) ? readFileSync(result.path, 'utf8') : null,
        pdfName: basename(result.path),
      };
    };
    const attempt = () =>
      outcome().catch((error) => ({ ok: false, code: error.code ?? null, name: error.name, message: shown(error.message) }));
    if (step.rewrite) writeFileSync(source, Buffer.from(step.rewrite, 'base64'));
    if (step.remove) rmSync(join(dir, step.remove), { recursive: true, force: true });
    if (step.makeDirectory) mkdirSync(join(dir, step.makeDirectory), { recursive: true });
    const results = step.concurrent ? await Promise.all([attempt(), attempt()]) : [await attempt()];
    recorded.push({
      step,
      results,
      calls: structuredClone(calls),
      cache: listing(cacheRoot),
      documentDirectories: directories(join(cacheRoot, 'document-previews')),
      scratchLeft: scratchSeen.filter((directory) => existsSync(directory)).length,
      newTracked: preview.trackedPreviewScratch().filter((directory) => !before.has(directory)).length,
    });
    for (const list of Object.values(calls)) list.length = 0;
  }
  cases.push({ name, document: document ?? null, fileName, spec, steps: recorded });
  // What the case left tracked is removed with the process in production; the recorder does it between cases.
  preview.removeTrackedPreviewScratchSync();
}

const everything = ['docx', 'xlsx', 'pptx'];
await record('office renders a private read-only copy without LibreOffice', 'source-bytes', 'review.xlsx', { installed: everything }, [{}, {}]);
await record('concurrent opens share one render', 'source-bytes', 'review.xlsx', { installed: everything }, [{ concurrent: true }]);
await record('a failed office render leaves no entry', 'source-bytes', 'review.xlsx', { installed: everything, office: 'fail' }, [{}]);
await record('the host reports a protected document', 'source-bytes', 'review.xlsx', { installed: everything, office: 'protected' }, [{}]);
await record('the host reports a failure without a message', 'source-bytes', 'review.xlsx', { installed: everything, office: 'no-error' }, [{}]);
await record('an encrypted ppt is refused before Office', 'ppt-locked', 'old.ppt', { installed: everything }, [{}, { password: PASSWORD }]);
await record('an encrypted ppt fails fast with LibreOffice', 'ppt-locked', 'old.ppt', { libreOffice: true }, [{}]);
await record('an unsupported encryption fails fast', 'ooxml-unsupported', 'secret.docx', { libreOffice: true }, [{}, { password: PASSWORD }]);
await record('a plain zip docx converts', 'zip-bytes', 'plain.docx', { libreOffice: true }, [{}]);
await record('a legacy container renamed docx converts', 'legacy-cfb', 'plain.docx', { libreOffice: true }, [{}]);
for (const name of ['ppt-open', 'ppt-stray-bytes', 'ppt-stray-stream']) {
  await record(`an open binary presentation renders through office (${name})`, name, 'old.ppt', { installed: everything }, [{}]);
}
await record('neither engine is installed', 'source-bytes', 'review.xlsx', { installed: [] }, [{}]);
await record('office installed for another format only', 'source-bytes', 'deck.pptx', { installed: ['xlsx'] }, [{}]);
await record('libreoffice present', 'source-bytes', 'review.xlsx', { libreOffice: true, installed: everything }, [{}, {}]);
await record('no preview for the type', 'source-bytes', 'notes.txt', { libreOffice: true }, [{}]);
await record('storage unavailable', 'source-bytes', 'review.xlsx', { libreOffice: true }, [{ noCacheRoot: true }]);
await record('a missing file', null, 'missing.docx', { libreOffice: true }, [{}]);
await record('a directory is no file', null, 'folder.docx', { libreOffice: true }, [{ makeDirectory: 'folder.docx' }]);
for (const scheme of ['agile', 'standard']) {
  await record(`${scheme}: no password asks for one`, scheme, 'secret.docx', { libreOffice: true }, [{}]);
  await record(`${scheme}: a wrong password`, scheme, 'secret.xlsx', { libreOffice: true }, [{ password: `${PASSWORD}x` }]);
  await record(`${scheme}: the right password renders the decrypted package`, scheme, 'secret.docx', { libreOffice: true }, [{ password: PASSWORD }]);
}
await record('an unlocked document serves later requests without the password', 'agile', 'deck.pptx', { libreOffice: true }, [
  { password: PASSWORD },
  {},
  { rewrite: b64(documents.agile) },
  {},
]);
await record('the decrypted package goes to office, which never gets the password', 'agile', 'secret.xlsx', { installed: everything }, [{ password: PASSWORD }]);
for (const hashAlgorithm of ['SHA-1', 'SHA1', 'SHA256', 'SHA384']) {
  await record(`an agile descriptor hashed with ${hashAlgorithm}`, `agile-${hashAlgorithm}`, 'secret.docx', { libreOffice: true }, [{ password: PASSWORD }]);
}
await record('an agile descriptor without integrity data', 'agile-no-integrity', 'plain-agile.docx', { libreOffice: true }, [{ password: PASSWORD }]);
for (const name of ['tampered-byte', 'tampered-size']) {
  await record(`a tampered package is corrupt (${name})`, name, 'secret.docx', { libreOffice: true }, [
    { password: PASSWORD },
    { password: `${PASSWORD}x` },
  ]);
}
for (const name of Object.keys(broken)) {
  await record(`malformed integrity data (${name})`, `integrity-${name}`, 'secret.docx', { libreOffice: true }, [{}, { password: PASSWORD }]);
}
for (const name of Object.keys(documents).filter((key) => key.startsWith('salts-'))) {
  await record(`integrity salts (${name})`, name, 'secret.docx', { libreOffice: true }, [{ password: PASSWORD }]);
}
await record('an encrypted doc without Word needs office', 'word-encrypted', 'old.doc', { libreOffice: true, installed: [] }, [{}, { password: PASSWORD }]);
await record('an encrypted doc asks for its password, then Word opens it', 'word-encrypted', 'old.doc', { libreOffice: true, installed: everything }, [
  {},
  { password: PASSWORD },
]);
await record('Word reports an incorrect password', 'word-encrypted', 'old.doc', { libreOffice: true, installed: everything, office: 'wrong-password' }, [
  { password: PASSWORD },
]);
await record('engine text never carries the password', 'word-encrypted', 'old.doc', { libreOffice: true, installed: everything, office: 'echo-password' }, [
  { password: PASSWORD },
]);
await record('an unencrypted doc converts with LibreOffice', 'word-plain', 'plain.doc', { libreOffice: true, installed: everything }, [{}]);
const manyDocuments = Array.from({ length: 26 }, (_, index) => ({ rewrite: b64(Buffer.from('x'.repeat(index + 1))) }));
await record('the cache keeps 24 documents', 'source-bytes', 'review.xlsx', { libreOffice: true }, manyDocuments);

// ---- pages -------------------------------------------------------------------------------------------------------------
const pageCases = [];
async function recordPages(name, steps) {
  const dir = join(work, `pages-${pageCases.length}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, 'a.pdf');
  writeFileSync(pdf, 'rev1');
  const cacheRoot = join(dir, 'cache');
  const calls = [];
  const renderPages = async (_path, { pages, maxWidth }) => {
    calls.push({ pages: [...pages], maxWidth });
    return {
      pageCount: 5,
      images: pages.map((page) => ({ page, width: maxWidth, height: 10, mimeType: 'image/png', data: `px-${calls.length}-${page}` })),
    };
  };
  const recorded = [];
  for (const step of steps) {
    if (step.rewrite) writeFileSync(pdf, step.rewrite);
    const options = { cacheRoot: step.noCacheRoot ? '' : cacheRoot, renderPages };
    if (step.pages) options.pages = step.pages;
    if (step.maxWidth) options.maxWidth = step.maxWidth;
    const before = calls.length;
    const reply = await preview.documentPreviewPages(pdf, options);
    recorded.push({ step, reply, calls: calls.slice(before), files: listing(cacheRoot) });
  }
  pageCases.push({ name, steps: recorded });
}
await recordPages('a repeated page request is served from the cache', [
  { pages: [1], maxWidth: 800 },
  { pages: [1], maxWidth: 800 },
  { pages: [1, 2], maxWidth: 800 },
  { pages: [1], maxWidth: 400 },
]);
await recordPages('no pages is page 1, the default width is 1200', [{}, { pages: [] }]);
await recordPages('memory only without a cache root', [
  { pages: [2], maxWidth: 640, noCacheRoot: true },
  { pages: [2], maxWidth: 640, noCacheRoot: true },
]);
await recordPages('a changed PDF is rasterised again and older revisions are pruned', [
  { pages: [1], maxWidth: 800 },
  { rewrite: 'revision two is longer', pages: [1], maxWidth: 800 },
]);
await recordPages('pages come back in the order asked, repeats included', [{ pages: [3, 1, 3], maxWidth: 500 }]);

// The memory cache holds 32 pages: the disk cache serves the page that was pushed out of it.
await recordPages('the disk cache serves a memory miss', [
  { pages: [3], maxWidth: 640 },
  ...Array.from({ length: 40 }, (_, index) => ({ pages: [1], maxWidth: 321 + index })),
  { pages: [3], maxWidth: 640 },
]);

writeJson(join(stage, 'golden.json'), {
  password: PASSWORD,
  plainSha256: sha(PLAIN),
  documents: Object.fromEntries(Object.entries(documents).map(([name, bytes]) => [name, b64(bytes)])),
  cases,
  pages: pageCases,
});
rmSync(work, { recursive: true, force: true });
writeSetManifest(stage, { set: 'office-preview', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
