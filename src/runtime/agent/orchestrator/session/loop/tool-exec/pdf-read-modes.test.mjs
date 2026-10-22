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

test("a custom model's own image-input setting beats the catalog, both ways; unset falls through", () => {
  const withOverride = (override, vision) => ({
    ...lookups({ nativePdf: false, takesImages: true, vision }),
    visionOverride: () => override,
  });
  assert.equal(pdfReadModes(session, withOverride(false, true)).pdfPageMode, 'ocr');
  assert.equal(pdfReadModes(session, withOverride(true, false)).pdfPageMode, 'image');
  assert.equal(pdfReadModes(session, withOverride(undefined, false)).pdfPageMode, 'ocr');
  assert.equal(pdfReadModes(session, withOverride(undefined, true)).pdfPageMode, 'image');
});

test('providerModelVisionOverride reads the loaded custom provider config', async () => {
  const { providerModelVisionOverride, _withRegisteredProviderForTest } = await import(
    '../../../providers/registry.mjs'
  );
  const instance = {
    customConfig: { modelOverrides: { 'x-build': { supportsVision: false }, y: { supportsVision: true }, z: {} } },
  };
  _withRegisteredProviderForTest('custom-vision-test', instance, () => {
    assert.equal(providerModelVisionOverride('custom-vision-test', 'x-build'), false);
    assert.equal(providerModelVisionOverride('custom-vision-test', 'y'), true);
    assert.equal(providerModelVisionOverride('custom-vision-test', 'z'), undefined);
    assert.equal(providerModelVisionOverride('custom-vision-test', 'missing'), undefined);
    assert.equal(providerModelVisionOverride('custom-vision-test', '__proto__'), undefined);
  });
  assert.equal(providerModelVisionOverride('custom-vision-test', 'y'), undefined);
});

test('a slash-containing model id is looked up whole, never by its last segment', async () => {
  const { providerModelVisionOverride, _withRegisteredProviderForTest } = await import(
    '../../../providers/registry.mjs'
  );
  const instance = {
    customConfig: {
      modelOverrides: { 'vendor/x-build': { supportsVision: false }, 'x-build': { supportsVision: true } },
    },
  };
  _withRegisteredProviderForTest('custom-vision-slash', instance, () => {
    assert.equal(providerModelVisionOverride('custom-vision-slash', 'vendor/x-build'), false);
    assert.equal(providerModelVisionOverride('custom-vision-slash', 'x-build'), true);
    assert.equal(providerModelVisionOverride('custom-vision-slash', 'other/x-build'), undefined);
  });
});

test('an edited override takes effect on provider reinit; no stale value stays behind', async () => {
  const { initProviders, getProvider, providerModelVisionOverride } = await import('../../../providers/registry.mjs');
  const id = 'custom-vision-reinit';
  const config = (modelOverrides) => ({
    [id]: {
      type: 'custom',
      schemaVersion: 2,
      name: 'Gateway',
      protocol: 'openai-chat',
      baseURL: 'https://gw.example.com/v1',
      auth: 'none',
      enabled: true,
      preconnect: false,
      modelOverrides,
    },
  });
  await initProviders(config({ 'gemini-4-argon-build': { manual: true, supportsVision: false } }));
  assert.ok(getProvider(id));
  assert.equal(providerModelVisionOverride(id, 'gemini-4-argon-build'), false);
  assert.equal(pdfReadModes({ provider: id, model: 'gemini-4-argon-build' }).pdfPageMode, 'ocr');

  await initProviders(config({ 'gemini-4-argon-build': { manual: true, supportsVision: true } }));
  assert.equal(providerModelVisionOverride(id, 'gemini-4-argon-build'), true);

  await initProviders(config({ 'gemini-4-argon-build': { manual: true } }));
  assert.equal(providerModelVisionOverride(id, 'gemini-4-argon-build'), undefined);
  assert.equal(pdfReadModes({ provider: id, model: 'gemini-4-argon-build' }).pdfPageMode, 'image');
});

test('the local runtime is the text-only provider', async () => {
  const { MixdogLocalProvider } = await import('../../../providers/mixdog-local.mjs');
  assert.equal(new MixdogLocalProvider().takesImages, false);
});
