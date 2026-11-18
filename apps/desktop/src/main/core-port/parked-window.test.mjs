import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createPortConnector } from '../../renderer/core-direct/port-connector.ts';
import { installCorePort } from '../../preload/core-port.ts';
import { BootReports } from './boot-progress.ts';
import { watchRecovery } from './failure-recovery.ts';
import { CORE_PORT_CHANNEL, CORE_PORT_OPEN_CHANNEL, CorePortRelay } from './relay.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Window A parks on a confirmed failure; the core then comes up some other way (window B's attach, the user, a repaired install).
// Main notices it, and A -- through the real relay, preload bridge and connector -- asks again and attaches.
test('a window parked on a confirmed failure attaches when main observes the core serving, with no attempt of its own', async () => {
  const exited = (path) => Object.assign(new Error('ended'), { coreExit: { code: 2, signal: null, reason: 'exited with code 2', stderrPath: path } });
  const reports = new BootReports();
  reports.attempt().failed(exited('a'));
  reports.attempt().failed(exited('b'));
  assert.ok(reports.confirmed());

  // main: what the core's discovery says, and the directory watch that tells of a change
  let discovery = { state: 'booting', rpcPort: null };
  let changed = () => {};
  let watchers = 0;
  watchRecovery({ ensureRoot() {}, log() {},
    reports,
    runtimeRoot: 'runtime',
    readState: async () => discovery,
    watch: (_dir, onChange) => {
      watchers += 1;
      changed = onChange;
      return { close: () => void (watchers -= 1) };
    },
  });
  await tick();
  assert.equal(watchers, 1, 'a failure stands: main watches for the core');

  // the relay: a core that serves answers with an endpoint, a failure confirmed answers launchFailed
  const relay = new CorePortRelay({
    bootReports: reports,
    endpointFor: async () => {
      const failure = reports.confirmed();
      if (failure) throw Object.assign(new Error(failure.message), { coreLaunchFailed: failure });
      return [{ slot: 'primary', url: 'ws://127.0.0.1:1/rpc', token: 't', target: 'local', role: 'main' }];
    },
    coreWindowScope: async () => 1,
    createSocket: () => {
      const socket = Object.assign(new EventEmitter(), { send() {}, close() {}, terminate() {} });
      queueMicrotask(() => socket.emit('open'));
      return socket;
    },
    createChannel: () => ({ port1: Object.assign(new EventEmitter(), { postMessage() {}, start() {}, close() {} }), port2: { port: 'two' } }),
    log: () => {},
  });

  // the preload, as the window's page sees it
  const ipc = new EventEmitter();
  const host = { listeners: [], addEventListener(_type, listener) { host.listeners.push(listener); } };
  const savedWindow = globalThis.window;
  globalThis.window = { postMessage: (data, _origin, ports) => host.listeners.forEach((listener) => listener({ source: host, data, ports })) };
  const exposed = {};
  const windowA = Object.assign(new EventEmitter(), {
    id: 1,
    isDestroyed: () => false,
    send: (channel, message) => ipc.emit(channel, {}, message),
    postMessage: (channel, message, ports) => ipc.emit(channel, { ports }, message),
  });
  const handlers = { [CORE_PORT_OPEN_CHANNEL]: (options) => relay.open(windowA, options.slot) };
  try {
    installCorePort(
      { on: (channel, listener) => ipc.on(channel, listener), invoke: (channel, ...args) => handlers[channel]?.(...args) },
      { exposeInMainWorld: (name, api) => void (exposed[name] = api) },
    );
    const sink = { frame() {}, closed() {} };
    const connector = createPortConnector(exposed.mixdogCorePort, host, 1_000);
    let writer = null;
    const opening = connector.open({ id: 'core' }, sink).then((w) => (writer = w));
    await tick();
    await tick();
    assert.equal(writer, null, 'A is parked on the failure card');

    // the core comes up some other way; the directory changes; main looks
    discovery = { state: 'serving', rpcPort: 4242 };
    changed();
    await tick();
    assert.equal(reports.confirmed(), null, 'main observed the core serving and superseded the failure');
    assert.equal(watchers, 0, 'and stopped watching');
    await Promise.race([opening, new Promise((_, reject) => setTimeout(() => reject(new Error('window A never attached')), 500))]);
    assert.ok(writer, 'A asked again, got a port and attached');
  } finally {
    globalThis.window = savedWindow;
  }
});
