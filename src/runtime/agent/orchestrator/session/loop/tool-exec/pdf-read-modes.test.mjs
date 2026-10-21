// How read returns a PDF to the session's model: native PDF support decides
// whole-document blocks only; whether the model sees images decides how a
// scanned page arrives (page image, or OCR text for a text-only model).
import assert from 'node:assert/strict';
import test from 'node:test';

import { pdfReadModes } from './dispatch.mjs';

const lookups = ({ nativePdf, takesImages, vision }) => ({
  nativePdf: () => nativePdf,
  readsImages: () => takesImages,
  catalogRow: () => (vision === undefined ? null : { supportsVision: vision }),
});
const session = { provider: 'p', model: 'm' };

test('a model that reads PDFs natively: document blocks and page images (unchanged)', () => {
  assert.deepEqual(pdfReadModes(session, lookups({ nativePdf: true, takesImages: true })), {
    pdfPageMode: 'image',
    pdfNativeDocument: true,
  });
});

test('a vision model without native PDFs: scanned pages as page images, no document block', () => {
  assert.deepEqual(pdfReadModes(session, lookups({ nativePdf: false, takesImages: true, vision: true })), {
    pdfPageMode: 'image',
    pdfNativeDocument: false,
  });
  // A catalog silent on vision keeps the provider's answer: images are sent.
  assert.equal(pdfReadModes(session, lookups({ nativePdf: false, takesImages: true })).pdfPageMode, 'image');
});

test('a text-only model: OCR text', () => {
  assert.deepEqual(pdfReadModes(session, lookups({ nativePdf: false, takesImages: false })), {
    pdfPageMode: 'ocr',
    pdfNativeDocument: false,
  });
  assert.equal(
    pdfReadModes(session, lookups({ nativePdf: false, takesImages: true, vision: false })).pdfPageMode,
    'ocr',
    'the catalog says the model has no image input'
  );
});

test('the local runtime is the text-only provider', async () => {
  const { MixdogLocalProvider } = await import('../../../providers/mixdog-local.mjs');
  assert.equal(new MixdogLocalProvider().takesImages, false);
});
