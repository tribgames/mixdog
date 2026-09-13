import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopServiceRegistry } from './desktop-service-registry.mjs';

const moduleUrl = new URL('./test-fixtures/lifecycle-desktop-service.mjs', import.meta.url).href;

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function adapter(label, dispose = async () => {}) {
  return { invoke: async () => label, control: async () => {}, dispose };
}

function fixture(t, makeAdapter) {
  const frames = [];
  let clientsChanged = 0;
  const registry = new DesktopServiceRegistry({
    runtime: { makeAdapter },
    onFrame: (frame) => frames.push(frame),
    onExternalClientsChanged: () => { clientsChanged += 1; },
  });
  t.after(() => registry.dispose());
  return { registry, frames, clientsChanged: () => clientsChanged };
}

test('closing during module loading prevents desktop adapter construction', async (t) => {
  let created = 0;
  const { registry } = fixture(t, () => { created += 1; return adapter('late'); });
  const rejected = assert.rejects(
    registry.init({ desktopId: 'desktop_late_import', moduleUrl }),
    /session service is closed/,
  );
  await registry.dispose();
  await rejected;
  assert.equal(created, 0);
});

test('an adapter acquired after shutdown is disposed without becoming addressable', async (t) => {
  const entered = deferred();
  const gate = deferred();
  let disposed = 0;
  const { registry } = fixture(t, async () => {
    entered.resolve();
    await gate.promise;
    return adapter('late', async () => { disposed += 1; });
  });
  const rejected = assert.rejects(
    registry.init({ desktopId: 'desktop_late_factory', moduleUrl }),
    /session service is closed/,
  );
  await entered.promise;
  await registry.dispose();
  gate.resolve();
  await rejected;
  assert.equal(disposed, 1);
  await assert.rejects(registry.invoke({ desktopId: 'desktop_late_factory', method: 'ping' }), /not initialized/);
});

test('pending initialization reserves its desktop id against a different module', async (t) => {
  const entered = deferred();
  const gate = deferred();
  const created = [];
  const { registry } = fixture(t, async ({ options }) => {
    created.push(options.label);
    if (options.label === 'first') { entered.resolve(); await gate.promise; }
    return adapter(options.label);
  });
  const first = registry.init({
    desktopId: 'desktop_shared',
    moduleUrl: `${moduleUrl}?build=first`,
    options: { label: 'first' },
  });
  await entered.promise;
  const rejected = assert.rejects(registry.init({
    desktopId: 'desktop_shared',
    moduleUrl: `${moduleUrl}?build=second`,
    options: { label: 'second' },
  }), /already bound to another service module/);
  gate.resolve();
  await Promise.all([first, rejected]);
  assert.deepEqual(created, ['first']);
  assert.equal(await registry.invoke({ desktopId: 'desktop_shared', method: 'ping' }), 'first');
});

test('module reuse cannot bypass an existing desktop-id binding conflict', async (t) => {
  const { registry } = fixture(t, ({ options }) => adapter(options.label));
  await registry.init({ desktopId: 'desktop_one', moduleUrl: `${moduleUrl}?loaded=one`, options: { label: 'one' } });
  await registry.init({ desktopId: 'desktop_two', moduleUrl: `${moduleUrl}?loaded=two`, options: { label: 'two' } });
  await assert.rejects(
    registry.init({ desktopId: 'desktop_one', moduleUrl: `${moduleUrl}?loaded=two` }),
    /already bound to another service module/,
  );
});

test('invalid desktop adapters are disposed before their initialization error returns', async (t) => {
  let disposed = 0;
  const { registry } = fixture(t, () => ({
    invoke() {},
    async dispose() { disposed += 1; },
  }));
  await assert.rejects(
    registry.init({ desktopId: 'desktop_invalid', moduleUrl }),
    /desktop service adapter is invalid/,
  );
  assert.equal(disposed, 1);
});

test('callbacks from a rejected adapter cannot be attributed to a later owner of its id', async (t) => {
  let emitOld;
  let oldClientChange;
  let created = 0;
  const f = fixture(t, ({ emit, onClientCountChanged }) => {
    if (++created === 1) {
      emitOld = emit;
      oldClientChange = onClientCountChanged;
      return { invoke() {}, dispose() {} };
    }
    return adapter('current');
  });
  await assert.rejects(
    f.registry.init({ desktopId: 'desktop_reused', moduleUrl }),
    /desktop service adapter is invalid/,
  );
  await f.registry.init({ desktopId: 'desktop_reused', moduleUrl });
  emitOld({ kind: 'desktop-event', name: 'late', value: {} });
  oldClientChange();
  assert.deepEqual(f.frames, []);
  assert.equal(f.clientsChanged(), 0);
});

test('concurrent registry disposal calls wait for the same adapter cleanup', async (t) => {
  const entered = deferred();
  const finished = deferred();
  const { registry } = fixture(t, () => adapter('owned', async () => {
    entered.resolve();
    await finished.promise;
  }));
  await registry.init({ desktopId: 'desktop_closing', moduleUrl });
  const first = registry.dispose();
  await entered.promise;
  let secondReturned = false;
  const second = registry.dispose().then(() => { secondReturned = true; });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(secondReturned, false);
  } finally {
    finished.resolve();
    await Promise.all([first, second]);
  }
});

test('the registered adapter keeps publishing its own events and client-count changes', async (t) => {
  let emit;
  let clientChanged;
  const f = fixture(t, (params) => {
    emit = params.emit;
    clientChanged = params.onClientCountChanged;
    return adapter('owned');
  });
  await f.registry.init({ desktopId: 'desktop_events', moduleUrl }, { clientToken: 'viewer' });
  const message = { kind: 'desktop-event', name: 'ready', value: {} };
  emit(message);
  clientChanged();
  assert.equal(f.frames.length, 1);
  assert.deepEqual(f.frames[0].message, message);
  assert.equal(f.clientsChanged(), 1);
});
