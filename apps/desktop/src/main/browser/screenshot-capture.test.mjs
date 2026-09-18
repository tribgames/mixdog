import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url:
            'data:text/javascript,' +
            encodeURIComponent(`
        export const BrowserWindow = { fromWebContents: guest => guest.owner };
        export const nativeImage = { createFromBuffer: () => globalThis.screenshotFixtureImage };
      `),
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { createBrowserScreenshotService } = await import('./screenshot.ts');
const { FULL_PAGE_LAYOUT_PREPARE, FULL_PAGE_LAYOUT_RESTORE } = await import('./screenshot-policy.ts');

const bytes = Buffer.from([255, 216, 1, 2, 255, 217]);
const image = {
  getSize: () => ({ width: 800, height: 600 }),
  toJPEG: () => bytes,
  toPNG: () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  crop: (rect) => ({
    getSize: () => ({ width: rect.width, height: rect.height }),
    toJPEG: () => bytes,
    toPNG: () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  }),
};

function fixture({ cdpCapture, nativeCapture, layout, layoutMetrics, resize } = {}) {
  globalThis.screenshotFixtureImage = image;
  const calls = [];
  const captureParams = [];
  let size = [320, 240];
  const guest = {
    invalidate() {},
    getZoomFactor: () => 1,
    owner: {
      isDestroyed: () => false,
      getContentSize: () => size,
      setContentSize: (width, height) => {
        calls.push(`resize:${width}x${height}`);
        resize?.(width, height);
        size = [width, height];
      },
    },
    capturePage: async () => {
      calls.push('native');
      return nativeCapture ? nativeCapture() : image;
    },
  };
  const cdp = {
    call: async (_guest, method, params) => {
      if (method === 'Page.captureScreenshot') {
        calls.push('CDP');
        captureParams.push(params);
        return cdpCapture ? cdpCapture() : { data: bytes.toString('base64') };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssContentSize: layoutMetrics || { width: 800, height: 600 } };
      }
      assert.equal(method, 'Runtime.evaluate');
      const phase = params.expression === FULL_PAGE_LAYOUT_PREPARE ? 'prepare' : 'restore';
      assert.ok([FULL_PAGE_LAYOUT_PREPARE, FULL_PAGE_LAYOUT_RESTORE].includes(params.expression));
      calls.push(phase);
      return layout ? layout(phase) : {};
    },
  };
  return { guest, calls, captureParams, size: () => size, service: createBrowserScreenshotService(cdp, 100, 100) };
}

test('an element inside the window is cropped out of one viewport capture', async () => {
  const f = fixture();
  const shot = await f.service.captureElement(
    f.guest,
    false,
    {},
    { x: 100, y: 50, width: 100, height: 50 },
    { viewport: { width: 320, height: 240 }, scroll: { x: 0, y: 0 } }
  );
  assert.equal(shot.partial, false);
  // The image is 2.5x the CSS viewport, so the crop is scaled with it.
  assert.deepEqual({ width: shot.width, height: shot.height }, { width: 250, height: 125 });
  assert.deepEqual(f.calls, ['CDP']);
  assert.equal(f.captureParams[0].clip, undefined);
});

test('an element taller than the window is cut out of the document capture, not the fold', async () => {
  const f = fixture();
  const shot = await f.service.captureElement(
    f.guest,
    false,
    {},
    { x: 40, y: -100, width: 700, height: 500 },
    { viewport: { width: 320, height: 240 }, scroll: { x: 0, y: 150 } }
  );
  assert.equal(shot.partial, false);
  // The element sits at document y=50, so the whole 700x500 box is in frame.
  assert.deepEqual({ width: shot.width, height: shot.height }, { width: 700, height: 500 });
  assert.deepEqual(f.calls, ['prepare', 'CDP', 'restore']);
  assert.deepEqual(f.captureParams[0].clip, { x: 0, y: 0, width: 800, height: 600, scale: 1 });
});

test('an element crop keeps the requested lossless format', async () => {
  const f = fixture();
  const shot = await f.service.captureElement(
    f.guest,
    false,
    { format: 'png' },
    { x: 0, y: 0, width: 80, height: 40 },
    { viewport: { width: 320, height: 240 }, scroll: { x: 0, y: 0 } }
  );
  assert.equal(shot.mimeType, 'image/png');
  assert.equal(shot.partial, false);
  assert.deepEqual({ width: shot.width, height: shot.height }, { width: 200, height: 100 });
});

test('an element larger than the document is clipped to what the page actually holds', async () => {
  const f = fixture();
  const shot = await f.service.captureElement(
    f.guest,
    false,
    {},
    { x: 0, y: 0, width: 40_000, height: 40_000 },
    { viewport: { width: 320, height: 240 }, scroll: { x: 0, y: 0 } }
  );
  assert.equal(shot.partial, true);
  assert.deepEqual({ width: shot.width, height: shot.height }, { width: 800, height: 600 });
});

test('an uncapturable document leaves the cropped viewport image as the answer', async () => {
  const f = fixture({ layoutMetrics: { width: 40_000, height: 40_000 } });
  const shot = await f.service.captureElement(
    f.guest,
    false,
    {},
    { x: 0, y: 0, width: 700, height: 500 },
    { viewport: { width: 320, height: 240 }, scroll: { x: 0, y: 0 } }
  );
  assert.equal(shot.partial, true);
  assert.deepEqual({ width: shot.width, height: shot.height }, { width: 800, height: 600 });
});

test('screenshot fallback keeps both engine failure reasons, without hiding them as empty captures', async () => {
  const f = fixture({
    cdpCapture: () => {
      throw new Error('CDP transport failed');
    },
    nativeCapture: () => {
      throw new Error('native surface failed');
    },
  });
  await assert.rejects(f.service.capture(f.guest, false), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /CDP: CDP transport failed/);
    assert.match(error.message, /native: native surface failed/);
    assert.equal(error.errors.length, 2);
    return true;
  });
  assert.deepEqual(f.calls, ['CDP', 'native']);
});

test('screenshot fallback preserves foreground and background preferences and accepts valid recovery', async () => {
  for (const background of [false, true]) {
    const f = fixture(
      background
        ? {
            nativeCapture: () => {
              throw new Error('native unavailable');
            },
          }
        : {
            cdpCapture: () => {
              throw new Error('CDP unavailable');
            },
          }
    );
    assert.equal((await f.service.capture(f.guest, background)).data, bytes.toString('base64'));
    assert.deepEqual(f.calls, background ? ['native', 'CDP'] : ['CDP', 'native']);
  }
  const invalid = fixture({ cdpCapture: () => ({ data: '' }) });
  assert.equal((await invalid.service.capture(invalid.guest, false)).data, bytes.toString('base64'));
  assert.deepEqual(invalid.calls, ['CDP', 'native']);
});

test('screenshot cancellation never starts a fallback engine', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled screenshot');
  const f = fixture({
    cdpCapture: () => {
      controller.abort(reason);
      throw reason;
    },
  });
  await assert.rejects(f.service.capture(f.guest, false, {}, controller.signal), (error) => error === reason);
  assert.deepEqual(f.calls, ['CDP']);
  const cancelledBeforeStart = fixture();
  await assert.rejects(
    cancelledBeforeStart.service.capture(cancelledBeforeStart.guest, false, { fullPage: true }, controller.signal),
    (error) => error === reason
  );
  assert.deepEqual(cancelledBeforeStart.calls, [], 'a pre-cancelled capture must not prepare or restore layout');
});

test('full-page layout preparation failures stop capture and still attempt restoration', async () => {
  for (const inBand of [false, true]) {
    const f = fixture({
      layout: (phase) => {
        if (phase !== 'prepare') return {};
        if (inBand)
          return { exceptionDetails: { text: 'Uncaught', exception: { description: 'layout script failed' } } };
        throw new Error('layout transport failed');
      },
    });
    await assert.rejects(f.service.capture(f.guest, false, { fullPage: true }), /layout (script|transport) failed/);
    assert.deepEqual(f.calls, ['prepare', 'restore']);
  }
});

test('full-page restoration errors are reported even after capture success, preserving prior failures', async () => {
  for (const failCapture of [false, true]) {
    const f = fixture({
      cdpCapture: () => {
        if (failCapture) throw new Error('CDP capture failed');
        return { data: bytes.toString('base64') };
      },
      layout: (phase) => {
        if (phase === 'restore') throw new Error('layout restore failed');
        return {};
      },
    });
    await assert.rejects(f.service.capture(f.guest, false, { fullPage: true }), (error) => {
      assert.match(error.message, /layout restoration failed/);
      assert.match(error.message, /layout restore failed/);
      if (failCapture) assert.match(error.message, /CDP capture failed/);
      assert.equal(error.errors.length, failCapture ? 2 : 1);
      return true;
    });
    assert.deepEqual(f.calls, ['prepare', 'CDP', 'restore']);
  }
});

test('viewport restoration failure is terminal and preserves a failed capture instead of falling back', async () => {
  for (const failCapture of [false, true]) {
    const f = fixture({
      nativeCapture: () => {
        if (failCapture) throw new Error('native capture failed');
        return image;
      },
      resize: (width) => {
        if (width === 320) throw new Error('viewport reset failed');
      },
    });
    await assert.rejects(f.service.capture(f.guest, true, { fullPage: true }), (error) => {
      assert.match(error.message, /viewport restoration failed.*viewport reset failed/);
      if (failCapture) assert.match(error.message, /native capture failed/);
      assert.equal(error.errors.length, failCapture ? 2 : 1);
      return true;
    });
    assert.deepEqual(f.calls, ['prepare', 'resize:800x600', 'native', 'resize:320x240', 'restore']);
    assert.deepEqual(f.size(), [800, 600], 'failed restoration must not be reported as successful recovery');
  }
});

test('native capture failure permits a fallback only after the original viewport is restored', async () => {
  const f = fixture({
    nativeCapture: () => {
      throw new Error('native capture failed');
    },
    cdpCapture: () => {
      assert.deepEqual(f.size(), [320, 240]);
      return { data: bytes.toString('base64') };
    },
  });
  assert.equal((await f.service.capture(f.guest, true, { fullPage: true })).data, bytes.toString('base64'));
  assert.deepEqual(f.calls, ['prepare', 'resize:800x600', 'native', 'resize:320x240', 'CDP', 'restore']);
  assert.deepEqual(f.size(), [320, 240]);
});

test('full-page cancellation restores the viewport without dispatching a late capture or fallback', async () => {
  for (const phase of ['resize', 'capture']) {
    const controller = new AbortController();
    const reason = new Error(`cancel during ${phase}`);
    const f = fixture({
      resize: (width) => {
        if (phase === 'resize' && width === 800) controller.abort(reason);
      },
      nativeCapture: () => {
        controller.abort(reason);
        throw reason;
      },
    });
    await assert.rejects(
      f.service.capture(f.guest, true, { fullPage: true }, controller.signal),
      (error) => error === reason
    );
    assert.deepEqual(f.size(), [320, 240]);
    assert.deepEqual(f.calls, [
      'prepare',
      'resize:800x600',
      ...(phase === 'capture' ? ['native'] : []),
      'resize:320x240',
      'restore',
    ]);
  }
});

test('simultaneous viewport and layout restoration failures retain the original capture error', async () => {
  const f = fixture({
    nativeCapture: () => {
      throw new Error('native capture failed');
    },
    resize: (width) => {
      if (width === 320) throw new Error('viewport reset failed');
    },
    layout: (phase) => {
      if (phase === 'restore') throw new Error('layout reset failed');
      return {};
    },
  });
  await assert.rejects(f.service.capture(f.guest, true, { fullPage: true }), (error) => {
    assert.match(error.message, /native capture failed/);
    assert.match(error.message, /viewport reset failed/);
    assert.match(error.message, /layout reset failed/);
    return true;
  });
  assert.deepEqual(f.calls, ['prepare', 'resize:800x600', 'native', 'resize:320x240', 'restore']);
});
