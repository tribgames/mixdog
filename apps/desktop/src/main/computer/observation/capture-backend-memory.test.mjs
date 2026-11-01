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
        export const BrowserWindow = { getAllWindows: () => [] };
        export const desktopCapturer = { getSources: async (options) => globalThis.backendFixture.composited(options) };
        export const nativeImage = { createFromBuffer: (buffer) => globalThis.backendFixture.decode(buffer) };
        export const screen = { getDisplayMatching: () => ({ scaleFactor: 1 }) };
      `),
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { createCaptureSources } = await import('./capture-sources.ts');
const { createCaptureBackendMemory, captureBackendKey } = await import('./capture-backend-memory.ts');
const { buildCapturePlan } = await import('./capture-source-plan.ts');
const { createCaptureSessionStores } = await import('./capture-session-stores.ts');

function image(kind) {
  const pixel = kind === 'black' ? 0 : 128;
  return {
    getSize: () => ({ width: 800, height: 600 }),
    isEmpty: () => false,
    toBitmap: () => Buffer.alloc(800 * 600 * 4, pixel),
  };
}

/** `behavior[backend]` is 'ok', 'black' (a blank frame) or 'fail'. */
function fixture(behavior, { sessionId = 'a' } = {}) {
  const calls = [];
  globalThis.backendFixture = {
    decode: (buffer) => image(buffer.toString()),
    composited: async () => {
      calls.push('composited');
      if (behavior.composited === 'fail') return [];
      return [{ id: 'window:1:0', name: 'fixture', thumbnail: image(behavior.composited) }];
    },
  };
  const host = {
    sessionIdFor: (command) => command.session_id || sessionId,
    assertExecutionNotAborted() {},
    nativeSurfaceBackends: ['print_window', 'wgc'],
    readPermissions: () => ({ screen_capture: 'not_required_on_windows' }),
    async callPowerShell(request) {
      calls.push(request.capture_backend);
      const how = behavior[request.capture_backend];
      if (how === 'fail') return { ok: false, error: 'capture_source_unavailable|fixture failure' };
      return {
        ok: true,
        result: {
          window_id: request.window_id,
          capture_source: 'window_surface',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          image_base64: Buffer.from(how).toString('base64'),
        },
      };
    },
  };
  const memory = createCaptureBackendMemory();
  const sources = createCaptureSources(host, memory);
  const select = (windowId = 'hwnd:0x1', command = { action: 'screenshot' }) => {
    const attempts = [];
    calls.length = 0;
    return sources
      .select({
        command,
        sourceType: 'window',
        sourceTitle: 'fixture',
        windowId,
        displayId: '',
        width: 800,
        height: 600,
        clientWidth: 800,
        clientHeight: 600,
        client: { x: 0, y: 0, width: 800, height: 600 },
        maxWidth: 1568,
        attempts,
      })
      .then((selected) => ({ ...selected, attempts, tried: [...calls] }));
  };
  return { select, memory, sources, behavior };
}

const tried = (selected) => selected.attempts.map(({ backend, status }) => `${backend}:${status}`);

test('a Windows window is read through its own surface before the compositor', async () => {
  const f = fixture({ print_window: 'fail', wgc: 'fail', composited: 'fail' });
  const selected = await f.select();
  assert.deepEqual(selected.tried, ['print_window', 'wgc', 'composited']);
  assert.equal(selected.surface, undefined);

  const win = fixture({ print_window: 'ok', wgc: 'ok', composited: 'ok' });
  const hit = await win.select();
  assert.deepEqual(hit.tried, ['print_window'], 'the compositor is never enumerated when PrintWindow works');
  assert.equal(hit.surface.route, 'window_surface');
});

test('the last working backend is tried first for the same session and window', async () => {
  const f = fixture({ print_window: 'black', wgc: 'ok', composited: 'ok' });
  const first = await f.select();
  assert.deepEqual(tried(first), ['print_window:unavailable', 'wgc:captured']);
  assert.equal(f.memory.recall(captureBackendKey('a', 'hwnd:0x1')), 'wgc');

  const second = await f.select();
  assert.deepEqual(second.tried, ['wgc'], 'straight to the remembered backend');
  assert.deepEqual(tried(second), ['wgc:captured']);
});

test('another window or session starts from the full order', async () => {
  const f = fixture({ print_window: 'black', wgc: 'ok', composited: 'ok' });
  await f.select('hwnd:0x1');
  assert.deepEqual((await f.select('hwnd:0x2')).tried, ['print_window', 'wgc']);
  assert.deepEqual((await f.select('hwnd:0x1', { action: 'screenshot', session_id: 'b' })).tried, [
    'print_window',
    'wgc',
  ]);
});

test('a remembered backend that fails or returns a blank frame falls back to the full order and is forgotten', async () => {
  for (const failure of ['fail', 'black']) {
    const f = fixture({ print_window: 'black', wgc: 'ok', composited: 'ok' });
    await f.select();
    f.behavior.wgc = failure;
    const fallback = await f.select();
    // The failed preference is not retried; the rest keeps its default order.
    assert.deepEqual(fallback.tried, ['wgc', 'print_window', 'composited'], failure);
    assert.equal(fallback.surface.route, 'composited');
    assert.equal(f.memory.recall(captureBackendKey('a', 'hwnd:0x1')), 'composited');
    assert.deepEqual(tried(fallback)[0], failure === 'black' ? 'wgc:unavailable' : 'wgc:failed');
  }
});

test('a remembered backend never skips the frame checks of the full order', async () => {
  const f = fixture({ print_window: 'ok', wgc: 'ok', composited: 'ok' });
  await f.select();
  assert.equal(f.memory.recall(captureBackendKey('a', 'hwnd:0x1')), 'print_window');
  f.behavior.print_window = 'black';
  const selected = await f.select();
  assert.equal(selected.surface.nativeBackend, 'wgc', 'a black frame from the preference is rejected');
  assert.equal(f.memory.recall(captureBackendKey('a', 'hwnd:0x1')), 'wgc');

  // Every backend failing leaves nothing remembered.
  f.behavior.print_window = f.behavior.wgc = f.behavior.composited = 'fail';
  assert.equal((await f.select()).surface, undefined);
  assert.equal(f.memory.recall(captureBackendKey('a', 'hwnd:0x1')), undefined);
});

test('a frame the engine rejects after selection is forgotten', async () => {
  const f = fixture({ print_window: 'ok', wgc: 'ok', composited: 'ok' });
  await f.select();
  f.sources.forgetBackend({ action: 'screenshot' }, 'hwnd:0x1');
  assert.deepEqual((await f.select()).tried, ['print_window']);
  assert.equal(f.memory.recall(captureBackendKey('a', 'hwnd:0x1')), 'print_window');
  f.memory.forget(captureBackendKey('a', 'hwnd:0x1'));
  assert.equal(f.memory.recall(captureBackendKey('a', 'hwnd:0x1')), undefined);
});

test('a screen has no window to remember', () => {
  const memory = createCaptureBackendMemory();
  assert.equal(captureBackendKey('a', ''), '');
  memory.remember(captureBackendKey('a', ''), 'composited');
  assert.equal(memory.recall(''), undefined);
});

test('memory entries expire, are bounded and are released with their session', () => {
  let now = 1_000;
  const memory = createCaptureBackendMemory(2, 100, () => now);
  memory.remember('s\u0000w1', 'wgc');
  assert.equal(memory.recall('s\u0000w1'), 'wgc');
  now += 101;
  assert.equal(memory.recall('s\u0000w1'), undefined, 'a reused window handle is not trusted forever');

  memory.remember('s\u0000w1', 'wgc');
  memory.remember('s\u0000w2', 'wgc');
  memory.remember('s\u0000w3', 'print_window');
  assert.equal(memory.recall('s\u0000w1'), undefined, 'the oldest entry is evicted');
  assert.equal(memory.recall('s\u0000w3'), 'print_window');

  memory.releasePrefix('s\u0000');
  assert.equal(memory.recall('s\u0000w3'), undefined);

  const stores = createCaptureSessionStores();
  stores.backendMemory.remember(captureBackendKey('a', 'hwnd:0x1'), 'wgc');
  stores.backendMemory.remember(captureBackendKey('b', 'hwnd:0x1'), 'wgc');
  stores.releaseCaptureSession('a');
  assert.equal(stores.backendMemory.recall(captureBackendKey('a', 'hwnd:0x1')), undefined);
  assert.equal(stores.backendMemory.recall(captureBackendKey('b', 'hwnd:0x1')), 'wgc');
});

test('a preferred backend moves to the front of the plan without dropping or repeating any', () => {
  const host = { nativeSurfaceBackends: ['print_window', 'wgc'] };
  const request = {
    command: { action: 'screenshot' },
    sourceType: 'window',
    sourceTitle: '',
    windowId: 'hwnd:0x1',
    displayId: '',
    width: 800,
    height: 600,
    clientWidth: 0,
    clientHeight: 0,
    maxWidth: 1568,
    attempts: [],
  };
  const order = (preferred) => buildCapturePlan(host, request, preferred).map((entry) => entry.backend);
  assert.deepEqual(order(), ['print_window', 'wgc', 'composited']);
  assert.deepEqual(order('composited'), ['composited', 'print_window', 'wgc']);
  assert.deepEqual(order('wgc'), ['wgc', 'print_window', 'composited']);
  assert.deepEqual(order('app_owned'), ['print_window', 'wgc', 'composited'], 'a backend outside the plan is ignored');
  assert.deepEqual(
    buildCapturePlan({ nativeSurfaceBackends: [] }, request, 'wgc').map((entry) => entry.backend),
    ['composited']
  );
});
