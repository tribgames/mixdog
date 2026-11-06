#!/usr/bin/env node
// Golden twin of the desktop's media-asset download (`apps/desktop/src/main/file-downloads.ts`:
// `requiredFileDownloadRequest` for the asset id, `authorizeMediaAsset` over `openRegularFile`,
// then the grant's `sanitizedFileName`): the file name, MIME type and size a device is offered,
// and the exact refusal for every way the asset cannot be served. Node's real service runs over
// real temp files with a stub host that answers `resolveMediaFile` with each case's record.
// Rust `media::transfer_source::MediaAssetSource` must offer and refuse the same.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-media-download.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { createFileDownloadService, requiredFileDownloadRequest } = await importFrom(tree, 'apps/desktop/src/main/file-downloads.ts');
const MAX = 256 * 1024 * 1024;
const dir = mkdtempSync(join(tmpdir(), 'mixdog-media-download-'));
const at = (rel) => `{DIR}/${rel}`;
const real = (text) => (typeof text === 'string' ? text.replace('{DIR}', dir.replace(/\\/g, '/')) : text);

const host = {
  listSessions: async () => [{ id: 's1' }],
  invokeCapability: async (_name, [assetId]) => ({ value: current.media === undefined ? null : current.media && { ...current.media, path: real(current.media.path) } }),
};
const service = createFileDownloadService({ host });
let current = null;

const kinds = (e) => (e?.reason ? e.reason : e?.name === 'TypeError' ? 'invalid' : `other:${e?.name}`);
const run = async (c) => {
  current = c;
  const wire = { source: { kind: 'media', sessionId: 's1', ...('assetId' in c ? { assetId: c.assetId } : {}) }, purpose: 'save' };
  try {
    const request = requiredFileDownloadRequest(wire);
    const grant = await service.authorize({ deviceId: 'd' }, request);
    await service.abort({ deviceId: 'd' }, grant.grantId);
    return { ok: { name: grant.name, mime: grant.mime, size: grant.size } };
  } catch (e) {
    return { error: { reason: kinds(e), message: e.message } };
  }
};

for (const d of ['folder']) mkdirSync(join(dir, d));
const files = [
  ['a.png', 3], ['b', 2], ['.hidden.png', 1], ['--dash.txt', 1], ['x.PNG', 1], ['plain.unknownext', 1], ['trailing.', 1],
  ['é ü.json', 4], [`${'n'.repeat(130)}.txt`, 1], ['exact.bin', MAX], ['over.bin', MAX + 1], ['caps.MD', 1], ['constructor', 1], ['dots.tar.gz', 1],
];
for (const [name, size] of files) {
  writeFileSync(join(dir, name), '');
  truncateSync(join(dir, name), size);
  if (size <= 3) writeFileSync(join(dir, name), Buffer.alloc(size, 1));
}
const media = (rel, mime) => ({ path: at(rel), mime, available: true });
const cases = [
  // the asset id
  { name: 'id: absent', media: media('a.png', 'image/png'), omit: true },
  { name: 'id: number', assetId: 5, media: media('a.png', 'image/png') },
  { name: 'id: null', assetId: null, media: media('a.png', 'image/png') },
  { name: 'id: empty', assetId: '', media: media('a.png', 'image/png') },
  { name: 'id: blanks', assetId: ' \u00a0\t ', media: media('a.png', 'image/png') },
  { name: 'id: 128 chars', assetId: 'a'.repeat(128), media: media('a.png', 'image/png') },
  { name: 'id: 129 chars', assetId: 'a'.repeat(129), media: media('a.png', 'image/png') },
  { name: 'id: padded is trimmed', assetId: '  abc_-9  ', media: media('a.png', 'image/png') },
  { name: 'id: padded to 129 raw, 128 trimmed', assetId: ` ${'b'.repeat(128)}`, media: media('a.png', 'image/png') },
  { name: 'id: NUL', assetId: 'ab\u0000c', media: media('a.png', 'image/png') },
  { name: 'id: slash', assetId: 'a/b', media: media('a.png', 'image/png') },
  { name: 'id: dot', assetId: 'a.b', media: media('a.png', 'image/png') },
  { name: 'id: non-ascii', assetId: 'é', media: media('a.png', 'image/png') },
  { name: 'id: inner space', assetId: 'a b', media: media('a.png', 'image/png') },
  // what the host answers
  { name: 'unknown asset', assetId: 'x1', media: null },
  { name: 'unavailable', assetId: 'x1', media: { path: at('a.png'), mime: 'image/png', available: false } },
  { name: 'path missing', assetId: 'x1', media: { mime: 'image/png', available: true } },
  { name: 'path not a string', assetId: 'x1', media: { path: 5, mime: 'image/png', available: true } },
  { name: 'relative path', assetId: 'x1', media: { path: 'a.png', mime: 'image/png', available: true } },
  { name: 'unc path', assetId: 'x1', media: { path: '//host/share/a.png', mime: 'image/png', available: true } },
  { name: 'unc path, backslashes', assetId: 'x1', media: { path: '\\\\host\\share\\a.png', mime: 'image/png', available: true } },
  // the file
  { name: 'file is gone', assetId: 'x1', media: media('gone.png', 'image/png') },
  { name: 'file in a missing folder', assetId: 'x1', media: media('nowhere/gone.png', 'image/png') },
  { name: 'a folder', assetId: 'x1', media: media('folder', 'image/png') },
  { name: 'a file used as a folder', assetId: 'x1', media: media('a.png/inner.png', 'image/png') },
  { name: 'exactly 256 MiB', assetId: 'x1', media: media('exact.bin', 'application/octet-stream') },
  { name: 'one byte over 256 MiB', assetId: 'x1', media: media('over.bin', 'application/octet-stream') },
  // name and type
  { name: 'stored mime wins', assetId: 'x1', media: media('a.png', 'image/webp') },
  { name: 'mime from the extension when empty', assetId: 'x1', media: media('a.png', '') },
  { name: 'mime from the extension when absent', assetId: 'x1', media: { path: at('a.png'), available: true } },
  { name: 'mime from the extension when not a string', assetId: 'x1', media: media('a.png', 7) },
  { name: 'no extension', assetId: 'x1', media: media('b', null) },
  { name: 'hidden name is all extension', assetId: 'x1', media: media('.hidden.png', null) },
  { name: 'leading dashes are stripped', assetId: 'x1', media: media('--dash.txt', null) },
  { name: 'upper-case extension', assetId: 'x1', media: media('x.PNG', null) },
  { name: 'upper-case markdown', assetId: 'x1', media: media('caps.MD', null) },
  { name: 'unknown extension', assetId: 'x1', media: media('plain.unknownext', null) },
  { name: 'trailing dot', assetId: 'x1', media: media('trailing.', null) },
  { name: 'object-prototype name', assetId: 'x1', media: media('constructor', null) },
  { name: 'double extension', assetId: 'x1', media: media('dots.tar.gz', null) },
  { name: 'non-ascii name', assetId: 'x1', media: media('é ü.json', null) },
  { name: 'name cut at 120 units', assetId: 'x1', media: media(`${'n'.repeat(130)}.txt`, null) },
];

const recorded = [];
for (const c of cases) {
  const outcome = await run(c);
  recorded.push({ name: c.name, ...('omit' in c ? {} : { assetId: c.assetId }), media: c.media, files: undefined, outcome });
}
rmSync(dir, { recursive: true, force: true });

writeJson(join(FIXTURES_ROOT, 'services', 'media-download-twin.json'), {
  domain: 'media-download-twin',
  recorder: 'benchmarks/rust-core/recorders/record-media-download.mjs',
  maxBytes: MAX,
  files: files.map(([name, size]) => ({ name, size })),
  folders: ['folder'],
  cases: recorded.map(({ files: _drop, ...rest }) => rest),
});
console.log(`recorded ${recorded.length} media downloads`);
process.exit(0);
