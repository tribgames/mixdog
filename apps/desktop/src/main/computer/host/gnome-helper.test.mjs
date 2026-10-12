import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  gnomeShellScreenshot,
  gnomeShellSourceId,
  gnomeWindowHandle,
  isStopSignalLine,
  parseGnomeShellSourceId,
  usesGnomeHelper,
  watchGnomeStopSignal,
} from './gnome-helper.ts';

const GNOME_WAYLAND = { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' };

test('only GNOME on Wayland uses the helper; X11, KDE, sway and other platforms keep Electron', () => {
  assert.equal(usesGnomeHelper(GNOME_WAYLAND, 'linux'), true);
  assert.equal(usesGnomeHelper(GNOME_WAYLAND, 'win32'), false);
  assert.equal(usesGnomeHelper(GNOME_WAYLAND, 'darwin'), false);
  assert.equal(usesGnomeHelper({ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'GNOME' }, 'linux'), false);
  assert.equal(usesGnomeHelper({ ...GNOME_WAYLAND, XDG_CURRENT_DESKTOP: 'KDE' }, 'linux'), false);
  assert.equal(usesGnomeHelper({ ...GNOME_WAYLAND, SWAYSOCK: '/run/sway' }, 'linux'), false);
});

function shotDeps({ fail } = {}) {
  const calls = { run: [], removed: [] };
  const deps = {
    run: async (args) => {
      calls.run.push(args);
      if (fail) throw new Error(fail);
      return "('/run/user/1000/x.png',)\n";
    },
    runtimeDir: '/run/user/1000',
    newId: () => 'abc',
    read: (path) => Buffer.from(`png:${path}`),
    remove: (path) => calls.removed.push(path),
  };
  return { deps, calls };
}

test('a screenshot is one D-Bus call to our own interface, written under XDG_RUNTIME_DIR and removed after reading', async () => {
  const { deps, calls } = shotDeps();
  const png = await gnomeShellScreenshot({ kind: 'stage' }, deps);
  assert.equal(String(png), 'png:/run/user/1000/mixdog-shot-abc.png');
  assert.deepEqual(calls.run, [
    [
      'call', '--session', '--timeout', '10', '--dest', 'org.gnome.Shell', '--object-path', '/io/mixdog/Windows',
      '--method', 'io.mixdog.Windows.Screenshot', '--',
      "'stage'", '0', '0', '0', '0', '0', "'/run/user/1000/mixdog-shot-abc.png'",
    ],
  ]);
  assert.deepEqual(calls.removed, ['/run/user/1000/mixdog-shot-abc.png']);
});

test('areas pass their (possibly negative) rectangle and windows their 64-bit id; nothing prompts through a portal', async () => {
  const area = shotDeps();
  await gnomeShellScreenshot({ kind: 'area', x: -1920, y: 0, width: 1920, height: 1080 }, area.deps);
  assert.deepEqual(area.calls.run[0].slice(-7), ["'area'", '0', '-1920', '0', '1920', '1080', "'/run/user/1000/mixdog-shot-abc.png'"]);
  const window = shotDeps();
  await gnomeShellScreenshot({ kind: 'window', id: 18446744073709551615n }, window.deps);
  assert.deepEqual(window.calls.run[0].slice(-7, -4), ["'window'", '18446744073709551615', '0']);
  // The only program ever run is gdbus's argv: no portal, no shell string.
  for (const call of [...area.calls.run, ...window.calls.run]) assert.ok(!call.join(' ').includes('portal'));
});

test('a failed call or a missing runtime dir reports the reason and still removes the file', async () => {
  const failing = shotDeps({ fail: 'GDBus.Error:io.mixdog.Windows.Error: window could not be painted' });
  await assert.rejects(gnomeShellScreenshot({ kind: 'stage' }, failing.deps), /window could not be painted/);
  assert.deepEqual(failing.calls.removed, ['/run/user/1000/mixdog-shot-abc.png']);
  const { deps } = shotDeps();
  await assert.rejects(gnomeShellScreenshot({ kind: 'stage' }, { ...deps, runtimeDir: undefined }), /XDG_RUNTIME_DIR/);
});

test('window ids and capture source ids round-trip', () => {
  assert.equal(gnomeWindowHandle('hwnd:0xDF2A8F66'), 0xdf2a8f66n);
  assert.equal(gnomeWindowHandle('hwnd:zz'), null);
  const window = { kind: 'window', handle: 3752752537n };
  assert.equal(gnomeShellSourceId(window), 'gnome-shell:window:3752752537');
  assert.deepEqual(parseGnomeShellSourceId('gnome-shell:window:3752752537'), window);
  assert.deepEqual(parseGnomeShellSourceId('gnome-shell:screen:2528732444'), { kind: 'screen', displayId: '2528732444' });
  assert.equal(parseGnomeShellSourceId('screen:0:0'), null);
  assert.equal(parseGnomeShellSourceId('gnome-shell:window:abc'), null);
});

function watchHarness() {
  const state = { spawned: [], timers: [], stops: 0 };
  const deps = {
    spawnMonitor() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.kill = () => {
        child.killed = true;
      };
      state.spawned.push(child);
      return child;
    },
    setTimer(callback, ms) {
      const timer = { callback, ms, cleared: false };
      state.timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
  };
  return { state, deps };
}

test('the Stop signal calls the stop path once per signal, however the output is chunked', () => {
  const { state, deps } = watchHarness();
  let stops = 0;
  const stop = watchGnomeStopSignal(() => (stops += 1), deps);
  const [monitor] = state.spawned;
  monitor.stdout.emit('data', Buffer.from('Monitoring signals on object /io/mixdog/Windows owned by org.gnome.Shell\n'));
  monitor.stdout.emit('data', '/io/mixdog/Windows: io.mixdog.Win');
  assert.equal(stops, 0);
  monitor.stdout.emit('data', 'dows.StopRequested ()\n/io/mixdog/Windows: org.freedesktop.DBus.Properties.PropertiesChanged ()\n');
  assert.equal(stops, 1);
  monitor.stdout.emit('data', '/io/mixdog/Windows: io.mixdog.Windows.StopRequested ()\n');
  assert.equal(stops, 2);
  assert.equal(isStopSignalLine('/io/mixdog/Windows: io.mixdog.Windows.StopRequested ()'), true);
  assert.equal(isStopSignalLine('/other: io.example.StopRequested ()'), false);
  stop();
  assert.equal(monitor.killed, true);
});

test('a monitor that exits (the shell restarted) is restarted with a growing delay until stopped', () => {
  const { state, deps } = watchHarness();
  const stop = watchGnomeStopSignal(() => {}, deps);
  state.spawned[0].emit('exit');
  state.spawned[0].emit('error');
  assert.equal(state.timers.length, 1, 'one restart however many events the dying child emits');
  assert.equal(state.timers[0].ms, 1000);
  state.timers[0].callback();
  assert.equal(state.spawned.length, 2);
  state.spawned[1].emit('exit');
  assert.equal(state.timers[1].ms, 3000);
  state.timers[1].callback();
  state.spawned[2].emit('exit');
  assert.equal(state.timers[2].ms, 10000);
  // A monitor that spoke before dying is healthy again.
  state.timers[2].callback();
  state.spawned[3].stdout.emit('data', 'Monitoring signals\n');
  state.spawned[3].emit('exit');
  assert.equal(state.timers[3].ms, 1000);
  stop();
  assert.equal(state.timers[3].cleared, true);
  state.timers[3].callback();
  assert.equal(state.spawned.length, 4, 'no restart after stop');
});

test('the indicator is one SetIndicator call with the spec as a GVariant string, quotes and backslashes escaped', async () => {
  const { gnomeSetIndicator, gvariantString } = await import('./gnome-helper.ts');
  assert.equal(gvariantString(`it's a \\ path`), `'it\\'s a \\\\ path'`);
  const calls = [];
  await gnomeSetIndicator({ visible: true, title: '컴퓨터 사용 중', hint: "Stop Ctrl+Alt+Esc" }, async (args) => (calls.push(args), ''));
  assert.deepEqual(calls[0].slice(0, 10), [
    'call', '--session', '--timeout', '5', '--dest', 'org.gnome.Shell', '--object-path', '/io/mixdog/Windows',
    '--method', 'io.mixdog.Windows.SetIndicator',
  ]);
  assert.equal(calls[0][10], '--');
  assert.deepEqual(JSON.parse(calls[0][11].slice(1, -1)), { visible: true, title: '컴퓨터 사용 중', hint: 'Stop Ctrl+Alt+Esc' });
});

test('every screenshot gets its own file and is read only after the shell call has finished writing it', async () => {
  const events = [];
  let id = 0;
  const deps = {
    run: async (args) => {
      events.push(`run ${args.at(-1)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push('written');
      return '';
    },
    runtimeDir: '/run/user/1000',
    newId: () => `id${++id}`,
    read: (path) => (events.push(`read ${path}`), Buffer.from(path)),
    remove: (path) => events.push(`remove ${path}`),
  };
  const first = await gnomeShellScreenshot({ kind: 'stage' }, deps);
  const second = await gnomeShellScreenshot({ kind: 'stage' }, deps);
  assert.notEqual(String(first), String(second), 'a later shot can never be served from an earlier shot\'s file');
  assert.deepEqual(events.filter((event) => !event.startsWith('run ')), [
    'written', 'read /run/user/1000/mixdog-shot-id1.png', 'remove /run/user/1000/mixdog-shot-id1.png',
    'written', 'read /run/user/1000/mixdog-shot-id2.png', 'remove /run/user/1000/mixdog-shot-id2.png',
  ]);
});
