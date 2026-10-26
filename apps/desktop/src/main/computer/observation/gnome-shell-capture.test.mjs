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
        // The ScreenCast portal (and its "Share Screen" prompt) sits behind this call.
        export const desktopCapturer = { getSources: async () => { globalThis.portalCalls += 1; return []; } };
        export const nativeImage = { createFromBuffer: (buffer) => globalThis.decode(buffer) };
        export const screen = { getAllDisplays: () => globalThis.displays };
      `),
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});

globalThis.portalCalls = 0;
globalThis.displays = [
  { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  { id: 2, bounds: { x: -1280, y: 0, width: 1280, height: 800 } },
];
globalThis.decode = (buffer) => {
  const [width, height] = String(buffer).split('x').map(Number);
  const image = { width, height, getSize: () => ({ width: image.width, height: image.height }), isEmpty: () => !width };
  image.resize = ({ width: w, height: h }) => ({
    ...image,
    width: w,
    height: h,
    getSize: () => ({ width: w, height: h }),
    resized: true,
  });
  return image;
};

const { captureGnomeShellSource } = await import('./gnome-shell-capture.ts');
const { buildCapturePlan } = await import('./capture-source-plan.ts');

function shooter(png) {
  const targets = [];
  return {
    targets,
    shoot: async (target) => {
      targets.push(target);
      return Buffer.from(png);
    },
  };
}

test("a screen is the display's own area of the shell (negative origins included), scaled to the asked size", async () => {
  const { targets, shoot } = shooter('1920x1080');
  const image = await captureGnomeShellSource({ kind: 'screen', displayId: '2' }, { width: 960, height: 540 }, shoot);
  assert.deepEqual(targets, [{ kind: 'area', x: -1280, y: 0, width: 1280, height: 800 }]);
  assert.deepEqual(image.getSize(), { width: 960, height: 540 });
  assert.equal(image.resized, true);
  // Already the asked size: untouched.
  const same = await captureGnomeShellSource(
    { kind: 'screen', displayId: '1' },
    { width: 1920, height: 1080 },
    shooter('1920x1080').shoot
  );
  assert.equal(same.resized, undefined);
});

test('no display id is the whole stage; an unknown one and an empty frame are capture_source_unavailable', async () => {
  const stage = shooter('2560x1080');
  await captureGnomeShellSource({ kind: 'screen', displayId: '' }, { width: 2560, height: 1080 }, stage.shoot);
  assert.deepEqual(stage.targets, [{ kind: 'stage' }]);
  await assert.rejects(
    captureGnomeShellSource({ kind: 'screen', displayId: '9' }, { width: 1, height: 1 }, shooter('1x1').shoot),
    /^Error: capture_source_unavailable: exact screen source/
  );
  await assert.rejects(
    captureGnomeShellSource({ kind: 'window', handle: 5n }, { width: 1, height: 1 }, async () => Buffer.from('0x0')),
    /capture_source_unavailable: the Mixdog GNOME helper returned an empty image/
  );
});

test('a window is its shell id; a helper failure names the cause and a sign-out hint, never a portal', async () => {
  const window = shooter('1024x768');
  await captureGnomeShellSource({ kind: 'window', handle: 3752752537n }, { width: 1024, height: 768 }, window.shoot);
  assert.deepEqual(window.targets, [{ kind: 'window', id: 3752752537n }]);
  await assert.rejects(
    captureGnomeShellSource({ kind: 'window', handle: 1n }, { width: 1, height: 1 }, async () => {
      throw new Error('GDBus.Error:io.mixdog.Windows.Error: no window with id 1');
    }),
    /^Error: capture_source_unavailable: .*no window with id 1.*sign out and in once/
  );
  assert.equal(globalThis.portalCalls, 0);
});

test('on GNOME Wayland the composited backend never reaches desktopCapturer; elsewhere it still does', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const env = { ...process.env };
  const request = {
    command: { action: 'capture' },
    sourceType: 'screen',
    sourceTitle: '',
    windowId: '',
    displayId: '1',
    width: 1920,
    height: 1080,
    clientWidth: 0,
    clientHeight: 0,
    maxWidth: 1280,
    attempts: [],
  };
  const composited = () =>
    buildCapturePlan({ nativeSurfaceBackends: [] }, request).find((entry) => entry.backend === 'composited');
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.assign(process.env, {
      WAYLAND_DISPLAY: 'wayland-0',
      XDG_SESSION_TYPE: 'wayland',
      XDG_CURRENT_DESKTOP: 'ubuntu:GNOME',
      XDG_RUNTIME_DIR: '',
    });
    // No runtime dir: the helper call fails before anything else, and the portal is untouched.
    await assert.rejects(composited().acquire(), /capture_source_unavailable: .*XDG_RUNTIME_DIR/);
    assert.equal(globalThis.portalCalls, 0, 'GNOME Wayland must not use the portal');
    // X11 (or any non-GNOME session) keeps Electron's capture.
    Object.assign(process.env, { XDG_SESSION_TYPE: 'x11' });
    delete process.env.WAYLAND_DISPLAY;
    await assert.rejects(composited().acquire(), /capture_source_unavailable: exact screen source is unavailable/);
    assert.equal(globalThis.portalCalls, 1);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
