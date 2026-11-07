// Records what Node's attachment store (src/runtime/attachments/store.mjs) answers, for the Rust
// attachment ports (run_host/attachment_store.rs): `readAttachmentTextWithin` (Blobs),
// `readAttachmentBuffer` + `isPermanentAttachmentError` (AttachmentReader), `attachmentBlobSize`
// (AttachmentFacts), `storeInlineDocumentPart` and `namedAttachmentFile` + `attachmentFileName`
// (AttachmentFiles). Every blob is planted on disk first, so a missing, empty or tampered blob is
// a real file state, not a mock.
//
// Run: node benchmarks/rust-core/recorders/record-attachment-store.mjs --tree <Node tree with node_modules>
// Output: native/core/crates/mixdog-core/src/run_host/golden/attachment_store.json
//
// The store reads MIXDOG_DATA_DIR; the rest of the environment is isolated too, so nothing of the
// recording PC's own data or home is read or written.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const treeAt = argv.indexOf('--tree');
if (treeAt < 0 || !argv[treeAt + 1]) throw new Error('pass --tree <Node tree with node_modules>');
const tree = resolve(argv[treeAt + 1]);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const temp = mkdtempSync(join(tmpdir(), 'attachment-store-'));
const dataDir = join(temp, 'data');
mkdirSync(dataDir, { recursive: true });
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dataDir,
  MIXDOG_HOME: join(temp, 'home'),
  HOME: join(temp, 'home'),
  USERPROFILE: join(temp, 'home'),
  APPDATA: join(temp, 'appdata'),
  LOCALAPPDATA: join(temp, 'localappdata'),
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  TZ: 'UTC',
});

const load = (rel) => import(pathToFileURL(join(tree, rel)).href);
const store = await load('src/runtime/attachments/store.mjs');
const { attachmentFileName } = await load('src/runtime/attachments/attachment-file-name.mjs');

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const text = (s) => Buffer.from(s, 'utf8');
const blobPath = (ref) => join(dataDir, 'prompt-attachments', 'sha256', ref.slice(0, 2), ref);
const relative = (path) => path.slice(dataDir.length + 1).split(sep).join('/');
const attempt = (fn) => {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: error.code ?? error.name };
  }
};

// ---- attachmentFileName ----------------------------------------------------------------------
const nameCases = [
  ['KakaoTalk_20261103_195007703.jpg', 'image/jpeg'],
  ['image', 'image/jpeg'],
  ['photo.heic', 'image/jpeg'],
  ['계약서 사본', 'application/pdf'],
  ['main.py', 'text/plain'],
  ['..\\..\\evil:name?.png', 'image/png'],
  ['nul', 'text/plain'],
  ['', 'image/png', 'image'],
  [`x.${'a'.repeat(190)}`, ''],
  [`${'b'.repeat(200)}.${'a'.repeat(190)}`, 'image/png'],
  [`${'a'.repeat(300)}.pdf`, 'application/pdf'],
  [null, ''],
  [undefined, 'image/png'],
  ['  .hidden.  ', ''],
  ['.bashrc', 'text/plain'],
  ['a.PDF', 'application/pdf'],
  ['a.JPG', 'image/jpeg'],
  ['a.jpeg', 'image/jpeg'],
  ['a.txt', 'image/png'],
  ['com1.txt', 'text/plain'],
  ['LPT9', ''],
  ['aux.', ''],
  ['con.tar.gz', ''],
  ['COM0', ''],
  ['..', ''],
  ['...', 'image/png'],
  ['.png', 'image/png'],
  ['a<b>c|d?e*f', ''],
  ['tab\there\u0001end', 'text/plain'],
  ['name', 'text/plain; charset=utf-8'],
  ['NAME', 'TEXT/PLAIN'],
  ['x', 'application/octet-stream'],
  ['doc.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['doc.doc', 'application/msword'],
  ['sheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['folder/sub/file.PNG', 'image/png'],
  ['C:\\dir\\f.txt', 'text/plain'],
  [`${'x'.repeat(130)}.json`, 'application/json'],
  [`${'😀'.repeat(70)}.png`, 'image/png'],
  [`${'é'.repeat(130)}`, 'text/markdown'],
  ['\u00a0spaced\u00a0', 'text/csv'],
  ['a. b', ''],
  [' ', 'text/plain', 'fallback-name'],
  ['archive.zip', 'application/zip'],
  ['archive', 'application/zip'],
  ['photo', 'image/heic'],
  ['photo.png', 'image/heic'],
  ['x.y.z.PNG', 'image/svg+xml'],
];
const fileNames = nameCases.map(([name, mime, fallback]) => ({
  name,
  mime,
  fallback: fallback ?? null,
  want: fallback === undefined ? attachmentFileName(name, mime) : attachmentFileName(name, mime, fallback),
}));

// ---- blobs on disk: Blobs, AttachmentReader, AttachmentFacts ---------------------------------
const stored = (id, bytes) => ({ id, ref: sha(bytes), file: bytes });
const blobs = [
  stored('ascii', text('hello')),
  stored('multibyte', text('héllo 한글 😀')),
  stored('invalid-utf8', Buffer.from([0x61, 0xff, 0xfe, 0x62, 0xc3])),
  stored('bom', Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])),
  stored('empty-file', Buffer.alloc(0)),
  { id: 'tampered', ref: sha(text('original')), file: text('modified') },
  { id: 'tampered-longer', ref: sha(text('short')), file: text('short plus extra') },
  { id: 'missing', ref: sha(text('never stored')), file: null },
  { id: 'invalid-ref', ref: 'not-a-ref', file: null },
  { id: 'upper-ref', ref: 'A'.repeat(64), file: null },
];
for (const blob of blobs) {
  if (blob.file === null || blob.ref.length !== 64) continue;
  mkdirSync(dirname(blobPath(blob.ref)), { recursive: true });
  writeFileSync(blobPath(blob.ref), blob.file);
}
const blobGolden = blobs.map((blob) => {
  const size = blob.file === null ? 0 : blob.file.length;
  const limits = [...new Set([0, 1, Math.max(size - 1, 0), size, size + 1, 1 << 20])];
  const textWithin = limits.map((max) => {
    const got = attempt(() => store.readAttachmentTextWithin(blob.ref, max));
    return { max, want: 'error' in got ? { error: got.error } : got.value === null ? { none: true } : { text: got.value } };
  });
  store.clearAttachmentBufferCache();
  const read = (() => {
    try {
      return { bytes: b64(store.readAttachmentBuffer(blob.ref)) };
    } catch (error) {
      return { error: error.code ?? error.name, permanent: store.isPermanentAttachmentError(error) };
    }
  })();
  const blobSize = attempt(() => store.attachmentBlobSize(blob.ref, 0));
  return {
    id: blob.id,
    ref: blob.ref,
    file: blob.file === null ? null : b64(blob.file),
    textWithin,
    read,
    size: 'error' in blobSize ? { error: blobSize.error } : { bytes: blobSize.value },
  };
});

// ---- storeInlineDocumentPart -----------------------------------------------------------------
const inlineData = [
  'aGVsbG8=',
  '',
  'aGVsbG8',
  'aGVs bG8=',
  'aGVsbG8=\n',
  'aGVsbG9=',
  '-_8=',
  '+/8=',
  b64(text('%PDF-1.7\nbody')),
  'AA==',
  'AA',
  'A',
  '====',
  b64(Buffer.alloc(3000, 7)),
];
const inline = inlineData.map((data) => {
  const part = store.storeInlineDocumentPart({ type: 'file', data, mimeType: 'application/pdf' });
  return { data, want: part === null ? null : { ref: part.attachmentRef, size: part.sizeBytes } };
});

// ---- namedAttachmentFile ---------------------------------------------------------------------
const JPEG = Buffer.from('\xff\xd8\xff\xe0 photo of a lease', 'latin1');
const named = [
  { bytes: JPEG, store: true },
  { bytes: Buffer.concat([JPEG, text(' full-resolution original '.repeat(40))]), store: true },
  { bytes: text('%PDF-1.7\nbody'), store: true },
  { bytes: text('plain notes'), store: true },
  { bytes: Buffer.concat([JPEG, text(' second photo')]), store: true },
  { bytes: text('a blob that was never stored'), store: false },
].map((blob) => ({ ...blob, ref: sha(blob.bytes) }));
for (const blob of named) if (blob.store) store.storeAttachmentBuffer(blob.bytes);
const refOf = (blob) => (typeof blob === 'number' ? named[blob].ref : blob);
const copyPath = (blob, name) => `prompt-attachments/files/${refOf(blob)}/${name}`;
const stepInputs = [
  { blob: 0, filename: 'KakaoTalk_1.jpg', mime: 'image/jpeg' },
  { blob: 0, filename: 'KakaoTalk_1.jpg', mime: 'image/jpeg' },
  { blob: 0, filename: '', mime: 'image/jpeg' },
  { blob: 2, filename: '', mime: 'application/pdf' },
  { blob: 4, filename: '', mime: 'image/png' },
  { blob: 0, filename: 'IMG_0042.heic', mime: 'image/webp', original: { blob: 1, mime: 'image/heic' } },
  { blob: 4, filename: 'IMG_0042.heic', mime: 'image/webp', original: { blob: 5, mime: 'image/heic' } },
  { blob: 4, filename: 'IMG_0043.heic', mime: 'image/png', original: { blob: 1, mime: '' } },
  { blob: 5, filename: 'gone.jpg', mime: 'image/jpeg' },
  { blob: 'zz', filename: 'bad.jpg', mime: 'image/jpeg' },
  { blob: 3, filename: 'notes', mime: 'text/plain' },
  { blob: 3, filename: 'notes', mime: 'text/plain', overwrite: { path: copyPath(3, 'notes.txt'), content: b64(text('edited by the user')) } },
  { blob: 3, filename: 'other.txt', mime: 'text/plain' },
  { blob: 2, filename: 'C:\\x\\Report: Q1?.pdf', mime: 'application/pdf' },
];
const steps = stepInputs.map((input) => {
  if (input.overwrite) writeFileSync(join(dataDir, input.overwrite.path), Buffer.from(input.overwrite.content, 'base64'));
  const original = input.original ? { attachmentRef: refOf(input.original.blob), mimeType: input.original.mime } : null;
  const got = attempt(() => store.namedAttachmentFile(refOf(input.blob), { filename: input.filename, mimeType: input.mime, original }));
  const want = 'error' in got ? { error: true } : { path: relative(got.value), content: b64(readFileSync(got.value)) };
  return { ...input, want };
});

const golden = {
  fileNames,
  blobs: blobGolden,
  inline,
  named: { blobs: named.map((blob) => ({ bytes: b64(blob.bytes), ref: blob.ref, store: blob.store })), steps },
};
const out = join(repo, 'native', 'core', 'crates', 'mixdog-core', 'src', 'run_host', 'golden', 'attachment_store.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(golden, null, 1)}\n`);
rmSync(temp, { recursive: true, force: true });
process.exit(0);
