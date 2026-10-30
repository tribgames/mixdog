import assert from 'node:assert/strict';
import test from 'node:test';

import { makeTempDirSync } from '../../../../scripts/lib/scoped-temp.mjs';

// The attachment store resolves its directory per call from this variable, so
// the blobs below never touch the real ~/.mixdog data.
process.env.MIXDOG_DATA_DIR = makeTempDirSync('remote-attachment-thumbnail');

const { attachmentStoreCacheStats, storeInlineDocumentPart } = await import(
  '../../../../src/runtime/attachments/store.mjs'
);
const { SessionHost } = await import('./session-host.ts');
const { sessionRemoteMethods } = await import('./remote-session-methods.ts');
const { REMOTE_ORIGINAL_MAX_BYTES } = await import('./attachment-thumbnail.ts');

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function storeImage(totalBytes) {
  const bytes = Buffer.alloc(totalBytes, 7);
  Buffer.from(PNG_HEADER).copy(bytes);
  const part = storeInlineDocumentPart({ type: 'file', data: bytes.toString('base64'), mimeType: 'image/png' });
  return { ref: part.attachmentRef, bytes };
}

// readAttachmentImage keeps no per-instance state.
const host = { readAttachmentImage: (ref, maxBytes) => SessionHost.prototype.readAttachmentImage.call(null, ref, maxBytes) };
const phoneThumbnail = (ref) => sessionRemoteMethods(host, undefined, undefined).readAttachmentThumbnail([ref]);
const storeReads = () => {
  const { hits, misses } = attachmentStoreCacheStats();
  return hits + misses;
};

test('phone thumbnail of an over-cap image is null and the blob is never read', async () => {
  const { ref } = storeImage(REMOTE_ORIGINAL_MAX_BYTES + 1);
  const before = storeReads();
  assert.equal(await phoneThumbnail(ref), null);
  assert.equal(storeReads(), before);
});

test('phone thumbnail of an image within the cap is unchanged', async () => {
  const { ref, bytes } = storeImage(REMOTE_ORIGINAL_MAX_BYTES);
  assert.equal(await phoneThumbnail(ref), `data:image/png;base64,${bytes.toString('base64')}`);
});

test('readAttachmentImage without a bound still returns an over-cap blob', async () => {
  const { ref, bytes } = storeImage(REMOTE_ORIGINAL_MAX_BYTES + 2);
  assert.equal(await host.readAttachmentImage(ref), bytes.toString('base64'));
});
