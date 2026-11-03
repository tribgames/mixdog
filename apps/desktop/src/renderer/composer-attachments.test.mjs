import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { attachmentFromFile, remoteAttachmentLimitBytes, remoteAttachmentSizeError } from './composer-attachments.ts';

const ORIGINAL_REF = 'a'.repeat(64);

function installBrowserImageHarness({ supportsWebp = true, stage = 'ok' } = {}) {
  const staged = [];
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://mixdog.example/',
  });
  const keys = ['window', 'document', 'navigator', 'FileReader', 'Image', 'URL'];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const drawCalls = [];
  let capabilityCalls = 0;
  const originalCreateElement = dom.window.document.createElement.bind(dom.window.document);

  class TestImage {
    naturalWidth = 4_000;
    naturalHeight = 1_000;

    set src(_value) {
      queueMicrotask(() => this.onload?.());
    }
  }

  Object.defineProperty(dom.window, 'mixdogDesktop', {
    configurable: true,
    value: {
      invokeCapability(request) {
        if (request.capability === 'stageAttachmentOriginal') {
          staged.push(request.args[0]);
          // A link that cannot carry the original refuses the call.
          if (stage === 'refuse') return Promise.reject(new Error('payload too large for the relay'));
          return Promise.resolve({ value: { originalRef: ORIGINAL_REF } });
        }
        capabilityCalls += 1;
        throw new Error('browser attachments must not use resizeImage RPC');
      },
    },
  });
  dom.window.document.createElement = (tagName, options) => {
    if (String(tagName).toLowerCase() !== 'canvas') {
      return originalCreateElement(tagName, options);
    }
    return {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (_image, x, y, width, height) => {
          drawCalls.push({ x, y, width, height });
        },
      }),
      toBlob(callback, mimeType) {
        // A browser without WebP encoding hands back another type instead.
        const type = mimeType === 'image/webp' && !supportsWebp ? 'image/png' : mimeType;
        callback(new dom.window.Blob(['resized'], { type }));
      },
    };
  };

  const objectUrl = {
    createObjectURL: () => 'blob:test-image',
    revokeObjectURL: () => {},
  };
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    navigator: { configurable: true, value: dom.window.navigator },
    FileReader: { configurable: true, value: dom.window.FileReader },
    Image: { configurable: true, value: TestImage },
    URL: { configurable: true, value: objectUrl },
  });

  return {
    dom,
    drawCalls,
    capabilityCalls: () => capabilityCalls,
    staged,
    close() {
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

test('web image attachments resize locally before appearing in the draft', async () => {
  const harness = installBrowserImageHarness();
  try {
    const file = new harness.dom.window.File(['original'], 'mobile.png', {
      type: 'image/png',
    });
    const attachment = await attachmentFromFile(file, { id: 7 });

    assert.deepEqual(harness.drawCalls, [{ x: 0, y: 0, width: 1_568, height: 392 }]);
    assert.equal(harness.capabilityCalls(), 0);
    // Re-encoded as WebP: a lossless PNG screenshot is the largest thing a
    // phone can attach, and WebP keeps alpha at a fraction of the bytes.
    assert.equal(attachment?.mimeType, 'image/webp');
    assert.equal(attachment?.data, 'cmVzaXplZA==');
    assert.equal(
      attachment?.metadataText,
      '[Image: source: mobile.png, 4000x1000, displayed at 1568x392. ' +
        'Multiply coordinates by 2.55 to map to the original image.]'
    );
  } finally {
    harness.close();
  }
});

test('a resized phone image also hands its original bytes to the PC once, for the named file', async () => {
  const harness = installBrowserImageHarness();
  try {
    const file = new harness.dom.window.File(['original'], 'KakaoTalk_1.jpg', { type: 'image/jpeg' });
    const attachment = await attachmentFromFile(file, { id: 7 });
    assert.equal(attachment?.data, 'cmVzaXplZA==', 'the model still gets the resized image');
    assert.deepEqual(harness.staged, [{ data: 'b3JpZ2luYWw=', mimeType: 'image/jpeg' }]);
    assert.equal(attachment?.originalRef, ORIGINAL_REF);
    assert.equal(attachment?.originalMimeType, 'image/jpeg');
  } finally {
    harness.close();
  }
});

test('an original the link cannot carry falls back to the resized copy without failing the attach', async () => {
  const harness = installBrowserImageHarness({ stage: 'refuse' });
  try {
    const file = new harness.dom.window.File(['original'], 'big.jpg', { type: 'image/jpeg' });
    const attachment = await attachmentFromFile(file, { id: 7 });
    assert.equal(attachment?.data, 'cmVzaXplZA==');
    assert.equal('originalRef' in attachment, false);
  } finally {
    harness.close();
  }
});

test('a browser without WebP encoding still attaches a usable image', async () => {
  const harness = installBrowserImageHarness({ supportsWebp: false });
  try {
    const file = new harness.dom.window.File(['original'], 'mobile.png', {
      type: 'image/png',
    });
    const attachment = await attachmentFromFile(file, { id: 7 });
    assert.equal(attachment?.mimeType, 'image/png');
    assert.equal(attachment?.data, 'cmVzaXplZA==');
  } finally {
    harness.close();
  }
});

test('remote attachment limit derives from the learned uplink ceiling', () => {
  assert.equal(remoteAttachmentLimitBytes(null), null);
  assert.equal(remoteAttachmentLimitBytes(8 * 1024 + 4000), 3000);
  assert.equal(remoteAttachmentSizeError('a.pdf', 1000, null), '');
  assert.equal(remoteAttachmentSizeError('a.pdf', 3000, 8 * 1024 + 4000), '');
  assert.match(remoteAttachmentSizeError('a.pdf', 3001, 8 * 1024 + 4000), /^a\.pdf: .*limit per attachment/);
});
