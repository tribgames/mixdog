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
        export const BrowserWindow = { getAllWindows: () => globalThis.captureFixture?.windows || [] };
        export const desktopCapturer = { getSources: async () => globalThis.captureFixture.sources() };
        export const nativeImage = { createFromBuffer: (buffer) => globalThis.captureFixture.decode(buffer) };
        export const screen = {};
      `),
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { createCaptureEngine } = await import('./capture.ts');
const { createSessionState } = await import('../session/state.ts');
const { createExecutionState } = await import('../host/execution-state.ts');
const { createInputDispatch } = await import('../host/input-dispatch.ts');
const { createComputerExecutionPolicy } = await import('../host/execution-policy.ts');
const { createCommandRouter } = await import('../host/command-router.ts');
const { createWindowReads } = await import('../host/window-reads.ts');
const { createWindowTargeting } = await import('../input/targeting.ts');

function image(width, height, crops = []) {
  return {
    getSize: () => ({ width, height }),
    isEmpty: () => false,
    toBitmap: () => Buffer.alloc(width * height * 4, 128),
    toJPEG: () => Buffer.from('fixture pixels'),
    toPNG: () => Buffer.from(`lossless ${width}x${height}`),
    resize: ({ width: next, height: nextHeight }) =>
      image(next, nextHeight ?? Math.round((height * next) / width), crops),
    crop: (region) => {
      crops.push(region);
      return image(region.width, region.height, crops);
    },
  };
}

function fixture(overrides = {}) {
  const bounds = {
    window_id: 'hwnd:0x1',
    x: -8,
    y: -31,
    width: 816,
    height: 631,
    client_x: 0,
    client_y: 0,
    client_width: 800,
    client_height: 600,
    related_window_ids: ['hwnd:0x1'],
  };
  const requests = [];
  const callPowerShell = async (request) => {
    requests.push(request);
    const supplied = await overrides.native?.(request);
    if (supplied) return supplied;
    if (request.action === 'input_idle_state')
      return {
        ok: true,
        result: { observer_ready: true, monitor: 'worker-a', sequence: 3 },
      };
    if (request.action === 'window_bounds') return { ok: true, result: bounds };
    if (request.action === 'snapshot')
      return {
        ok: true,
        result: { window_id: 'hwnd:0x1', elements: [], total_elements: 0 },
      };
    if (request.action === 'ocr_image') return { ok: true, result: { words: [], lines: [], total_words: 0 } };
    throw new Error(`unexpected fixture request: ${request.action}`);
  };
  const state = createSessionState({ callPowerShell });
  const execution = createExecutionState();
  const active = { sessionId: 'a', aborted: false };
  execution.activeExecutionsBySession.set('a', active);
  const host = { ...state, ...execution, callPowerShell, ...overrides.host };
  const capture = createCaptureEngine(host);
  globalThis.captureFixture = {
    sources: async () => [{ id: 'window:1:0', name: 'fixture', thumbnail: image(800, 600) }],
  };
  const run = (operation) => execution.executionContext.run(active, operation);
  return { state, execution, active, host, capture, run, requests, bounds };
}

test('a timed-out provider stays an error while later captures use fresh pixels without repeated worker restarts', async (t) => {
  let now = 10_000;
  t.mock.method(Date, 'now', () => now);
  let snapshots = 0;
  const failure = 'computer_command_timeout: snapshot exceeded 2500ms';
  const f = fixture({
    native: (request) => {
      if (request.action !== 'snapshot') return;
      snapshots++;
      throw new Error(failure);
    },
  });
  const command = { action: 'capture', window_id: 'hwnd:0x1', session_id: 'a', mode: 'state' };
  for (let index = 0; index < 3; index++) {
    const result = await f.run(() => f.capture.captureComputer(command));
    assert.equal(result.payload.accessibility_status, 'error');
    assert.equal(result.payload.accessibility_error, failure);
    assert.equal(result.payload.accessibility_cache, 'timed_out_provider');
    assert.equal(result.payload.accessibility_retry_after_ms, 30_000);
    assert.equal(result.payload.pixel_status, 'available');
    assert.equal(result.payload.foreground_input_ready, true);
  }
  assert.equal(snapshots, 1);
  await assert.rejects(
    f.run(() => f.capture.captureComputer({ ...command, mode: 'ax' })),
    /computer_command_timeout/
  );
  assert.equal(snapshots, 2, 'explicit semantic inspection is never replaced by cached absence');
  now += 30_001;
  await f.run(() => f.capture.captureComputer(command));
  assert.equal(snapshots, 3, 'the provider may recover after the bounded retry delay');
});

test('the observation after an action takes the cached stall instead of spending the timeout again', async (t) => {
  let now = 10_000;
  t.mock.method(Date, 'now', () => now);
  let snapshots = 0;
  const f = fixture({
    native: (request) => {
      if (request.action !== 'snapshot') return;
      snapshots++;
      throw new Error('computer_command_timeout: snapshot exceeded 2500ms');
    },
  });
  const observation = { action: 'capture', mode: 'ax', window_id: 'hwnd:0x1', session_id: 'a', observation_after: true };
  await assert.rejects(f.run(() => f.capture.captureComputer(observation)), /computer_command_timeout/);
  assert.equal(snapshots, 1);
  const cached = await f.run(() => f.capture.captureComputer(observation));
  assert.equal(cached.payload.ok, true);
  assert.equal(cached.payload.accessibility_cache, 'timed_out_provider');
  assert.equal(cached.payload.returned_elements, 0);
  assert.equal(snapshots, 1, 'the post-action observation never restarts the stalled provider');
  // An explicit ax capture keeps its escape hatch.
  await assert.rejects(
    f.run(() => f.capture.captureComputer({ ...observation, observation_after: false })),
    /computer_command_timeout/
  );
  assert.equal(snapshots, 2);
});

test('a provider that keeps timing out is retried on a doubling delay, and one good read clears it', async (t) => {
  let now = 10_000;
  t.mock.method(Date, 'now', () => now);
  let stalled = true;
  const f = fixture({
    native: (request) => {
      if (request.action !== 'snapshot') return;
      if (stalled) throw new Error('computer_command_timeout: snapshot exceeded 2500ms');
      return { ok: true, result: { elements: [], total_elements: 0, window_id: 'hwnd:0x1' } };
    },
  });
  const command = { action: 'capture', window_id: 'hwnd:0x1', session_id: 'a', mode: 'state' };
  for (const expected of [30_000, 60_000, 120_000, 120_000]) {
    const result = await f.run(() => f.capture.captureComputer(command));
    assert.equal(result.payload.accessibility_retry_after_ms, expected);
    now += expected + 1;
  }
  stalled = false;
  const recovered = await f.run(() => f.capture.captureComputer(command));
  assert.equal(recovered.payload.accessibility_cache, undefined);
  stalled = true;
  const relapsed = await f.run(() => f.capture.captureComputer(command));
  assert.equal(relapsed.payload.accessibility_retry_after_ms, 30_000, 'recovery resets the escalation');
});

test('state capture retains lossless source pixels for OCR while keeping the model image compact', async () => {
  const f = fixture();
  Object.assign(f.bounds, {
    width: 2000,
    height: 1000,
    client_width: 2000,
    client_height: 1000,
  });
  globalThis.captureFixture.sources = async () => [{ id: 'window:1:0', name: 'fixture', thumbnail: image(2000, 1000) }];
  const result = await f.run(() =>
    f.capture.captureComputer({
      action: 'capture',
      window_id: 'hwnd:0x1',
      session_id: 'a',
      mode: 'state',
    })
  );
  const ocr = f.requests.find((request) => request.action === 'ocr_image');
  assert.equal(Buffer.from(ocr.image_base64, 'base64').toString(), 'lossless 2000x1000');
  assert.ok(result.payload.width < 2000);
  assert.equal(result.image.mimeType, 'image/jpeg');
  assert.equal(result.payload.ocrImage, undefined);
});

test('missing compositor sources use an exact window-owned surface, including zoom', async () => {
  const nativeBounds = { x: -8, y: -31, width: 816, height: 631 };
  const crops = [];
  const f = fixture({
    native: (request) =>
      request.action === 'window_capture'
        ? {
            ok: true,
            result: {
              window_id: 'hwnd:0x1',
              capture_source: 'window_surface',
              ...nativeBounds,
              image_base64: Buffer.from('native fixture').toString('base64'),
            },
          }
        : undefined,
  });
  globalThis.captureFixture.sources = async () => [];
  globalThis.captureFixture.decode = () => image(816, 631, crops);
  const shot = await f.run(() =>
    f.capture.captureScreenshot({
      action: 'screenshot',
      window_id: 'hwnd:0x1',
      session_id: 'a',
    })
  );
  assert.equal(shot.route, 'window_surface');
  assert.deepEqual(
    [shot.frame.originX, shot.frame.originY, shot.frame.physicalWidth, shot.frame.physicalHeight],
    [-8, -31, 816, 631]
  );
  const zoom = await f.run(() =>
    f.capture.captureZoom({
      action: 'zoom',
      frame_id: shot.frameId,
      region: [10, 20, 110, 120],
      session_id: 'a',
    })
  );
  assert.ok(zoom.image);
  assert.deepEqual(crops, [{ x: 10, y: 20, width: 100, height: 100 }]);
  assert.equal(f.requests.filter((request) => request.action === 'window_capture').length, 2);
});

test('native fallback rejects screen crops and another window before publishing pixels', async () => {
  for (const result of [
    { window_id: 'hwnd:0x2', capture_source: 'window_surface' },
    { window_id: 'hwnd:0x1', capture_source: 'screen_region' },
  ]) {
    const f = fixture({
      native: (request) =>
        request.action === 'window_capture'
          ? { ok: true, result: { ...result, x: 0, y: 0, width: 800, height: 600, image_base64: 'fixture' } }
          : undefined,
    });
    globalThis.captureFixture.sources = async () => [];
    globalThis.captureFixture.decode = () => {
      throw new Error('foreign pixels must not be decoded');
    };
    const shot = await f.run(() =>
      f.capture.captureScreenshot({ action: 'screenshot', window_id: 'hwnd:0x1', session_id: 'a' })
    );
    assert.equal(shot.image, undefined);
    assert.equal(shot.pixelUnavailable.code, 'pixel_unavailable');
    assert.equal(f.state.framesBySession.get('a')?.size || 0, 0);
  }
});

test('unusable PrintWindow pixels fall through to WGC and zoom retains that exact backend', async () => {
  const crops = [];
  const f = fixture({
    native: (request) =>
      request.action === 'window_capture'
        ? {
            ok: true,
            result: {
              window_id: 'hwnd:0x1',
              capture_source: 'window_surface',
              x: 0,
              y: 0,
              width: 800,
              height: 600,
              image_base64: Buffer.from(request.capture_backend).toString('base64'),
            },
          }
        : undefined,
  });
  globalThis.captureFixture.sources = async () => [];
  globalThis.captureFixture.decode = (buffer) => {
    const pixels = image(800, 600, crops);
    if (buffer.toString() === 'print_window') pixels.toBitmap = () => Buffer.alloc(800 * 600 * 4);
    return pixels;
  };
  const shot = await f.run(() =>
    f.capture.captureScreenshot({
      action: 'screenshot',
      window_id: 'hwnd:0x1',
      session_id: 'a',
    })
  );
  assert.equal(shot.route, 'window_surface');
  assert.equal(shot.frame.sourceId, 'window-surface:wgc:hwnd:0x1');
  assert.equal(shot.frame.nativeBackend, 'wgc');
  assert.deepEqual(
    shot.captureAttempts.map(({ backend, status, code }) => [backend, status, code]),
    [
      ['composited', 'failed', 'capture_source_unavailable'],
      ['print_window', 'unavailable', 'blank_black_frame'],
      ['wgc', 'captured', undefined],
    ]
  );
  const zoom = await f.run(() =>
    f.capture.captureZoom({
      action: 'zoom',
      frame_id: shot.frameId,
      region: [10, 20, 110, 120],
      session_id: 'a',
    })
  );
  assert.ok(zoom.image);
  assert.deepEqual(crops, [{ x: 10, y: 20, width: 100, height: 100 }]);
  assert.deepEqual(
    f.requests.filter((request) => request.action === 'window_capture').map((request) => request.capture_backend),
    ['print_window', 'wgc', 'wgc']
  );
});

test('native capture denial, geometry changes and minimized targets do not switch backend or owner', async () => {
  for (const code of ['capture_denied', 'capture_geometry_changed', 'capture_minimized', 'capture_cloaked']) {
    const f = fixture({
      native: (request) =>
        request.action === 'window_capture' ? { ok: false, error: `${code}|fixture failure` } : undefined,
    });
    f.bounds.owner_id = 'hwnd:0x2';
    globalThis.captureFixture.sources = async () => [];
    const shot = await f.run(() =>
      f.capture.captureScreenshot({
        action: 'screenshot',
        window_id: 'hwnd:0x1',
        session_id: 'a',
      })
    );
    assert.equal(shot.image, undefined);
    assert.match(shot.pixelUnavailable.message, new RegExp(code));
    // A hidden window says how to bring it back; recapturing cannot.
    const hidden = code === 'capture_minimized' || code === 'capture_cloaked';
    assert.equal(shot.pixelUnavailable.reason, hidden ? 'window_hidden' : 'capture_source_unavailable');
    if (hidden) assert.match(shot.pixelUnavailable.message, /window focus/);
    assert.deepEqual(
      f.requests.filter((request) => request.action === 'window_capture').map((request) => request.capture_backend),
      ['print_window']
    );
    assert.ok(f.requests.every((request) => !request.window_id || request.window_id === 'hwnd:0x1'));
  }
});

test('cancellation after PrintWindow failure prevents WGC capture', async () => {
  const f = fixture({
    native: (request) => {
      if (request.action !== 'window_capture') return;
      f.active.aborted = true;
      return { ok: false, error: 'capture_source_unavailable|fixture failure' };
    },
  });
  globalThis.captureFixture.sources = async () => [];
  await assert.rejects(
    f.run(() =>
      f.capture.captureScreenshot({
        action: 'screenshot',
        window_id: 'hwnd:0x1',
        session_id: 'a',
      })
    ),
    /computer_session_aborted/
  );
  assert.equal(f.requests.filter((request) => request.action === 'window_capture').length, 1);
  assert.equal(f.state.framesBySession.get('a')?.size || 0, 0);
});

test('native cleanup failure remains separate from the primary failure and stops owner fallback', async () => {
  const f = fixture({
    native: (request) =>
      request.action === 'window_capture'
        ? {
            ok: false,
            error: 'capture_wgc_unavailable|private provider detail',
            result: { capture_cleanup: { status: 'failed', text: 'private cleanup detail' } },
          }
        : undefined,
  });
  f.bounds.owner_id = 'hwnd:0x2';
  globalThis.captureFixture.sources = async () => [];
  const shot = await f.run(() =>
    f.capture.captureScreenshot({
      action: 'screenshot',
      window_id: 'hwnd:0x1',
      session_id: 'a',
    })
  );
  assert.equal(shot.image, undefined);
  assert.equal(shot.captureAttempts.at(-1).code, 'capture_wgc_unavailable');
  assert.deepEqual(shot.captureAttempts.at(-1).cleanup, { status: 'failed' });
  assert.equal(f.requests.filter((request) => request.action === 'window_capture').length, 1);
  assert.equal(JSON.stringify(shot).includes('private'), false);
});

test('capture payload retains earlier failures after successful fallback', async () => {
  const f = fixture({
    native: (request) =>
      request.action === 'window_capture'
        ? {
            ok: true,
            result: {
              window_id: 'hwnd:0x1',
              capture_source: 'window_surface',
              x: 0,
              y: 0,
              width: 800,
              height: 600,
              image_base64: 'fixture',
              capture_cleanup: { status: 'confirmed' },
            },
          }
        : undefined,
  });
  globalThis.captureFixture.sources = async () => [];
  globalThis.captureFixture.decode = () => image(800, 600);
  const capture = await f.run(() =>
    f.capture.captureComputer({
      action: 'capture',
      mode: 'vision',
      window_id: 'hwnd:0x1',
      session_id: 'a',
    })
  );
  assert.deepEqual(
    capture.payload.capture_attempts.map((row) => row.backend),
    ['composited', 'print_window']
  );
  assert.equal(capture.payload.capture_attempts[1].cleanup.status, 'confirmed');
});

test('portrait captures register the final bounded image dimensions for coordinate input', async () => {
  const f = fixture();
  Object.assign(f.bounds, { width: 1275, height: 2274, client_width: 1275, client_height: 2274 });
  globalThis.captureFixture.sources = async () => [{ id: 'window:1:0', thumbnail: image(1275, 2274) }];
  const shot = await f.run(() =>
    f.capture.captureScreenshot({ action: 'screenshot', window_id: 'hwnd:0x1', session_id: 'a' })
  );
  assert.ok(shot.frame.captureHeight <= 1568);
  assert.ok(Math.ceil(shot.frame.captureWidth / 28) * Math.ceil(shot.frame.captureHeight / 28) <= 1568);
  assert.equal(shot.frame.physicalWidth, 1275);
  assert.equal(shot.frame.physicalHeight, 2274);
  assert.match(shot.description, new RegExp(`${shot.frame.captureWidth}x${shot.frame.captureHeight}`));
});

test('client origin zero and app-owned zoom retain the observed surface coordinates', async () => {
  const f = fixture();
  const crops = [];
  const owned = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false },
    getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0]),
    capturePage: async () => image(800, 600, crops),
  };
  globalThis.captureFixture.windows = [owned];
  const shot = await f.run(() =>
    f.capture.captureScreenshot({
      action: 'screenshot',
      window_id: 'hwnd:0x1',
      session_id: 'a',
    })
  );
  assert.equal(shot.frame.originX, 0);
  assert.equal(shot.frame.originY, 0);
  const zoom = await f.run(() =>
    f.capture.captureZoom({
      action: 'zoom',
      frame_id: shot.frameId,
      region: [10, 20, 110, 120],
      session_id: 'a',
    })
  );
  assert.deepEqual(crops, [{ x: 10, y: 20, width: 100, height: 100 }]);
  const frame = f.state.framesBySession.get('a').get(zoom.frameId);
  assert.deepEqual([frame.originX, frame.originY, frame.physicalWidth, frame.physicalHeight], [10, 20, 100, 100]);
});

test('cancelled or cross-session-invalidated captures never republish input targets', async () => {
  for (const reason of ['cancelled', 'another-session']) {
    const f = fixture();
    globalThis.captureFixture.sources = async () => {
      if (reason === 'cancelled') {
        f.active.aborted = true;
        f.state.releaseSessionState('a', () => {});
      } else {
        f.execution.invalidateObservationsForWindows(['hwnd:0x1'], 'b');
      }
      return [{ id: 'window:1:0', thumbnail: image(800, 600) }];
    };
    await assert.rejects(
      f.run(() =>
        f.capture.captureComputer({
          action: 'capture',
          mode: 'vision',
          window_id: 'hwnd:0x1',
          session_id: 'a',
        })
      ),
      reason === 'cancelled' ? /computer_session_aborted/ : /stale_frame/
    );
    assert.equal(f.state.framesBySession.get('a')?.size || 0, 0);
    assert.equal(f.state.observedWindowBySession.has('a'), false);
  }
});

test('another session invalidates stored frames, refs and scopes only for its changed window', async () => {
  const f = fixture();
  for (const [sessionId, windowId] of [
    ['a', 'hwnd:0x1'],
    ['b', 'hwnd:0x1'],
    ['c', 'hwnd:0x2'],
  ]) {
    f.state.rememberFrame({
      id: 'frame',
      sessionId,
      windowId,
      relatedWindowIds: [windowId],
      capturedAt: performance.now(),
    });
    f.state.rememberObservedWindowScope({ session_id: sessionId }, windowId);
    f.state.elementTargetsBySession.set(sessionId, new Map([['ref', { windowId }]]));
  }
  f.state.invalidateWindowTargets(['HWND:0X1'], 'b');
  await assert.rejects(f.state.requireValidFrame({ frame_id: 'frame', session_id: 'a' }), /stale_frame/);
  assert.equal(f.state.elementTargetsBySession.has('a'), false);
  assert.equal(f.state.observedWindowBySession.has('a'), false);
  for (const unaffected of ['b', 'c']) {
    assert.equal(f.state.framesBySession.get(unaffected).has('frame'), true);
    assert.equal(f.state.observedWindowBySession.has(unaffected), true);
  }
});

test('external input during capture disables foreground input, while stable captures carry the original watermark', async () => {
  for (const changed of [false, true]) {
    let reads = 0;
    const f = fixture({
      native: (request) => {
        if (request.action !== 'input_idle_state') return undefined;
        const sequence = ++reads > 1 && changed ? 4 : 3;
        return { ok: true, result: { observer_ready: true, monitor: 'worker-a', sequence } };
      },
    });
    const command = { action: 'capture', mode: 'vision', window_id: 'hwnd:0x1', session_id: 'a' };
    const observation = await f.run(() => f.capture.captureComputer(command));
    assert.equal(observation.payload.foreground_input_ready, !changed);
    assert.equal(observation.payload.foreground_input_reason, changed ? 'user_input_during_capture' : undefined);
    let sent;
    const dispatch = createInputDispatch(
      {
        ...f.host,
        isObserveOnly: () => false,
        readWindowIntegrity: async () => ({ known: true, higher: false }),
        callPowerShell: async (request) => {
          sent = request;
          return { ok: true };
        },
      },
      createComputerExecutionPolicy()
    );
    const input = () =>
      dispatch({ action: 'key', keys: '{TAB}', delivery: 'foreground', session_id: 'a' }, 'key', {
        targetWindowId: 'hwnd:0x1',
        allowedWindowIds: ['hwnd:0x1'],
        observedScope: f.state.freshObservedWindowScope(command),
      });
    if (changed) {
      // The user's own input, not a broken host: the refusal names that and
      // still sends nothing.
      await assert.rejects(input(), /foreground_input_not_ready/);
      assert.equal(sent, undefined);
    } else {
      await input();
      assert.equal(sent.observed_input_monitor_id, 'worker-a');
      assert.equal(sent.observed_input_user_sequence, 3);
    }
  }
});

test('unavailable input observers remain distinguishable from user intervention in usable captures', async () => {
  for (const failed of [false, true]) {
    const f = fixture({
      native: (request) => {
        if (request.action !== 'input_idle_state') return;
        if (failed) throw new Error('input observer probe failed');
        return { ok: true, result: { observer_ready: false, monitor: 'worker-a', sequence: 3 } };
      },
    });
    const result = await f.run(() =>
      f.capture.captureComputer({
        action: 'capture',
        mode: 'vision',
        window_id: 'hwnd:0x1',
        session_id: 'a',
      })
    );
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.foreground_input_ready, false);
    assert.equal(result.payload.foreground_input_reason, 'input_observer_unavailable');
  }
});

test('failed accessibility workers permit fresh pixels and OCR without replaying the failed provider', async () => {
  let monitor = 'worker-a';
  const f = fixture({
    native: (request) => {
      if (request.action === 'input_idle_state')
        return {
          ok: true,
          result: { observer_ready: true, monitor, sequence: 0 },
        };
      if (request.action === 'snapshot') {
        monitor = 'worker-b';
        f.state.invalidateWorkerGeneration('a');
        throw new Error('computer_command_timeout: fixture provider stopped');
      }
    },
  });
  const result = await f.run(() =>
    f.capture.captureComputer({
      action: 'capture',
      mode: 'state',
      include_ocr: true,
      window_id: 'hwnd:0x1',
      session_id: 'a',
    })
  );
  assert.equal(result.payload.ok, true);
  assert.ok(result.image);
  assert.equal(result.payload.foreground_input_ready, true);
  assert.equal(f.requests.filter((request) => request.action === 'snapshot').length, 1);
  assert.equal(f.requests.filter((request) => request.action === 'ocr_image').length, 1);
  assert.equal(f.state.freshObservedWindowScope({ session_id: 'a' }).inputObservation.monitor, 'worker-b');
});

test('another session changing a resolved target during preparation still prevents dispatch', {
  skip: process.platform !== 'win32',
}, async () => {
  const f = fixture();
  const command = { action: 'key', keys: '{TAB}', window_id: 'hwnd:0x1', session_id: 'a' };
  f.state.rememberObservedWindowScope(command, command.window_id);
  let dispatched = 0;
  const router = createCommandRouter({
    ...f.host,
    isObserveOnly: () => false,
    resolveInputTarget: async () => ({
      targetWindowId: command.window_id,
      allowedWindowIds: [command.window_id],
      observedScope: f.state.freshObservedWindowScope(command),
    }),
    claimComputerTargets: async () => {},
    readComputerWindows: async () => {
      f.state.invalidateWindowTargets([command.window_id], 'b');
      f.execution.invalidateObservationsForWindows([command.window_id], 'b');
      return [];
    },
    callPowerShell: async () => {
      dispatched++;
      return { ok: true };
    },
  });
  await assert.rejects(
    f.run(() => router.runCommand(command)),
    /stale_frame/
  );
  assert.equal(dispatched, 0);
});

test('bounded zoom derives authorization from its original frame, not an extra window selector', {
  skip: process.platform !== 'win32',
}, async () => {
  const f = fixture();
  const shot = await f.run(() =>
    f.capture.captureScreenshot({
      action: 'screenshot',
      window_id: 'hwnd:0x1',
      session_id: 'a',
    })
  );
  let pid = 100;
  const router = createCommandRouter({
    ...f.host,
    ...f.capture,
    isObserveOnly: () => false,
    policy: createComputerExecutionPolicy({
      version: 1,
      actions: ['capture'],
      windows: [{ id: 'hwnd:0x1', pid: 100 }],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    readComputerWindows: async () => [{ id: 'hwnd:0x1', pid }],
  });
  const command = { action: 'zoom', frame_id: shot.frameId, region: [0, 0, 100, 100], session_id: 'a' };
  pid = 999;
  await assert.rejects(
    f.run(() => router.runCommand(command)),
    /computer_policy_denied/
  );
  pid = 100;
  assert.ok((await f.run(() => router.runCommand(command))).image);
});

test('elevated semantic refs are refused before opening UAC', async () => {
  let launched = 0;
  const dispatch = createInputDispatch(
    {
      sessionIdFor: () => 'a',
      assertExecutionNotAborted() {},
      isObserveOnly: () => false,
      readWindowIntegrity: async () => ({ known: true, higher: true }),
      callPowerShellElevated: async () => {
        launched++;
        return { ok: true };
      },
    },
    createComputerExecutionPolicy()
  );
  await assert.rejects(
    dispatch({ action: 'click', ref: 'r', delivery: 'foreground' }, 'click', {
      targetWindowId: 'hwnd:0x1',
      allowedWindowIds: ['hwnd:0x1'],
      observedScope: { inputObservation: { ready: true, monitor: 'original', sequence: 0 } },
    }),
    /privileged_worker_ref_unsupported/
  );
  assert.equal(launched, 0);
});

test('element normalisation keeps the shortcut an app advertises for a control', () => {
  const { normalizeElementRecords } = createSessionState({ callPowerShell: async () => ({ ok: true }) });
  // The backend reads AcceleratorKey/AccessKey, but only fields named here survive
  // the host boundary: a missing name silently drops the evidence.
  const [element, plain] = normalizeElementRecords([
    { mark: 1, ref: 's1:e0', role: 'Edit', name: 'address bar', accelerator: 'Ctrl+L', access_key: 'Alt+d' },
    { mark: 2, ref: 's1:e1', role: 'Button', name: 'plain' },
  ]);
  assert.equal(element.accelerator, 'Ctrl+L');
  assert.equal(element.access_key, 'Alt+d');
  assert.equal(plain.accelerator, undefined);
  assert.equal(plain.access_key, undefined);
});

test('the compact element view keeps the shortcut it was given', async () => {
  const { frameElements } = await import('./analysis.ts');
  // Compact output names its fields explicitly, so an unnamed one disappears
  // even after the host has normalised it.
  const [withShortcut, without] = frameElements(
    [
      { mark: 1, ref: 's1:e0', role: 'Edit', name: 'address bar', accelerator: 'Ctrl+L', access_key: 'Alt+d' },
      { mark: 2, ref: 's1:e1', role: 'Button', name: 'plain' },
    ],
    undefined,
    true
  );
  assert.equal(withShortcut.accelerator, 'Ctrl+L');
  assert.equal(withShortcut.access_key, 'Alt+d');
  assert.equal(hasOwnProperty.call(without, 'accelerator'), false);
});

test('app listing returns process names from the full native window read', async () => {
  const reads = createWindowReads({
    sessionIdFor: () => 'a',
    callPowerShell: async (request) => ({
      ok: true,
      result: {
        windows: [
          {
            id: 'hwnd:0x1',
            title: 'fixture',
            pid: 100,
            app: request.action === 'list_windows' ? 'notepad' : '',
          },
        ],
      },
    }),
  });
  const targeting = createWindowTargeting(reads);
  const { apps } = JSON.parse((await targeting.listComputerApps({ action: 'list_apps' })).text);
  assert.deepEqual(
    apps.map((app) => [app.name, app.pid]),
    [['notepad', 100]]
  );
});
