#!/usr/bin/env node
// Recording of apps/desktop/src/main/desktop-visibility-restart.test.mjs (b6f10295a): the desktop service registry
// (src/standalone/desktop-service-registry.mjs DesktopServiceRegistry) and the desktop's state sync
// (apps/desktop/src/main/desktop-service-state-sync.ts) over a scripted host, driven through the registry's own init / invoke /
// releaseClient / unsubscribe, with the versioned setVisibleSessions registrations of a restarted desktop, a late old client, out-of-order
// versions, legacy unversioned calls, concurrent desktops and shared conversations. Per step: what the host was asked to show
// (registrations) and every frame the registry emitted (kind, session, wire).
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-desktop-visibility-restart-cases.mjs --tree <export of b6f10295a with node_modules>
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { openSet } from './lib/case-set.mjs';

const set = openSet('desktop-visibility-restart-cases', import.meta.url);
const { tree } = set;
const { DesktopServiceRegistry } = await set.load('src/standalone/desktop-service-registry.mjs');
const { createDesktopServiceStateSync } = await set.load('apps/desktop/src/main/desktop-service-state-sync.ts');
const { createSnapshotDeltaDecoder } = await set.load('apps/desktop/src/main/state-delta.ts');
const moduleUrl = pathToFileURL(join(tree, 'src/standalone/test-fixtures/lifecycle-desktop-service.mjs')).href;
const rejected = async (promise) => { try { return { resolved: await promise }; } catch (e) { return { rejected: e }; } };

function fixture() {
  const frames = [];
  const envelopes = [];
  const registrations = [];
  const listeners = new Map();
  let created = 0;
  const subscribe = (kind, listener) => { listeners.set(kind, listener); return () => listeners.delete(kind); };
  const host = {
    getSnapshot: () => null,
    subscribe: (listener) => subscribe('state', listener),
    subscribeSessions: (listener) => subscribe('sessions', listener),
    subscribeAgentPool: (listener) => subscribe('agents', listener),
    subscribeSessionStates: (listener) => subscribe('lane', listener),
    async setVisibleSessions(ids) { registrations.push([...ids]); return true; },
  };
  const registry = new DesktopServiceRegistry({
    runtime: {
      makeAdapter({ emit }) {
        created += 1;
        const sync = createDesktopServiceStateSync({ host, emit });
        return { invoke: (_method, args) => sync.setDeliveryFilter(args), control: (message) => sync.control(message), releaseClient: (epoch) => sync.releaseClient(epoch), dispose: () => sync.dispose() };
      },
    },
    onFrame: (frame) => { envelopes.push(frame); frames.push(frame.message); },
  });
  const open = (desktopId, ctx) => registry.init({ desktopId, moduleUrl }, ctx);
  const show = (desktopId, ids, version, ctx) => registry.invoke({ desktopId, method: 'setVisibleSessions', args: [ids, version] }, ctx);
  const publish = (sessionId, text) => listeners.get('lane')({ sessionId, snapshot: { sessionId, items: [{ id: text, kind: 'user', text }] }, frameSource: 'live' });
  const trace = [];
  const mark = (step, extra = {}) => { trace.push({ step, registrations: registrations.map((r) => [...r]), frames: structuredClone(frames), envelopes: structuredClone(envelopes), ...extra }); };
  return { registry, frames, envelopes, registrations, listeners, open, show, publish, created: () => created, trace, mark, dispose: () => registry.dispose() };
}
async function run(name, fn) { await set.run(name, async () => { const f = fixture(); try { return await fn(f); } finally { f.dispose(); } }); }

await run('a restarted desktop can register version one on the retained service and receive live conversation rows', async (f) => {
  const old = { clientToken: 'old-client' }; const current = { clientToken: 'replacement-client' };
  const first = await f.open('old_desktop', old);
  await f.show(first.desktopId, ['old_session'], 5, old);
  f.registry.releaseClient(old.clientToken);
  const replacement = await f.open('replacement_desktop', current);
  const accepted = await f.show(replacement.desktopId, ['current_session'], 1, current);
  f.mark('restarted desktop registers version 1', { sameServiceId: replacement.desktopId === first.desktopId, adaptersCreated: f.created(), accepted, firstInit: first, replacementInit: replacement });
  f.frames.length = 0; f.envelopes.length = 0;
  const decoder = createSnapshotDeltaDecoder();
  const decoded = [];
  for (const text of ['sent message', 'working progress', 'completed answer']) {
    f.publish('current_session', text);
    const frame = f.frames.at(-1);
    const d = decoder.decode(frame.wire);
    decoded.push(structuredClone({ frame, decoded: d }));
  }
  f.mark('three live rows', { decoded });
  f.listeners.get('agents')([{ id: 'worker', status: 'running' }]);
  f.mark('agent pool row');
  return { trace: f.trace };
});
await run('late registrations from a previous desktop cannot replace the current conversation filter', async (f) => {
  const old = { clientToken: 'old-client' }; const current = { clientToken: 'current-client' };
  const service = await f.open('old_desktop', old);
  await f.show(service.desktopId, ['old_session'], 40, old);
  await f.open('current_desktop', current);
  await f.show(service.desktopId, ['current_session'], 1, current);
  f.registry.releaseClient(old.clientToken);
  const late = await rejected(f.show(service.desktopId, ['old_session'], 41, old));
  f.frames.length = 0; f.envelopes.length = 0;
  f.publish('old_session', 'must stay hidden'); f.publish('current_session', 'must stay live');
  f.mark('after the late registration', { late });
  return { trace: f.trace };
});
await run('out-of-order and equal registrations stay fenced within one desktop connection', async (f) => {
  const current = { clientToken: 'current-client' };
  const service = await f.open('desktop', current);
  await f.show(service.desktopId, ['current_session'], 2, current);
  await f.show(service.desktopId, ['old_session'], 1, current);
  await f.show(service.desktopId, ['old_session'], 2, current);
  f.mark('versions 2, 1, 2');
  f.frames.length = 0; f.envelopes.length = 0;
  f.publish('old_session', 'must stay hidden'); f.publish('current_session', 'must stay live');
  f.mark('rows published');
  return { trace: f.trace };
});
await run('unversioned legacy registrations remain supported', async (f) => {
  const service = await f.open('desktop');
  await f.show(service.desktopId, ['old_session'], 5);
  await f.show(service.desktopId, ['current_session']);
  f.frames.length = 0; f.envelopes.length = 0;
  f.publish('current_session', 'legacy live update');
  f.mark('legacy');
  return { trace: f.trace };
});
await run('concurrent desktops keep independent counters and the survivor stays live after the newer one disconnects', async (f) => {
  const a = { clientToken: 'desktop-a' }; const b = { clientToken: 'desktop-b' };
  const service = await f.open('desktop_a', a);
  await f.show(service.desktopId, ['a_session'], 1, a);
  await f.open('desktop_b', b);
  await f.show(service.desktopId, ['b_session'], 1, b);
  await f.open('desktop_a', a);
  await f.show(service.desktopId, ['a_current'], 100, a);
  f.mark('a version 100');
  f.frames.length = 0; f.envelopes.length = 0;
  f.publish('a_current', 'a is live'); f.publish('b_session', 'b is live');
  f.mark('both live');
  f.registry.releaseClient(b.clientToken);
  f.mark('b released');
  await f.show(service.desktopId, ['a_next'], 101, a);
  f.mark('a version 101');
  f.frames.length = 0; f.envelopes.length = 0;
  f.publish('a_next', 'a stays live'); f.publish('b_session', 'b is disconnected');
  f.mark('after');
  return { trace: f.trace };
});
await run('unsubscribing one desktop retains shared conversations until their last observer leaves', async (f) => {
  const a = { clientToken: 'desktop-a' }; const b = { clientToken: 'desktop-b' };
  const service = await f.open('desktop_a', a);
  await f.show(service.desktopId, ['shared_session'], 1, a);
  await f.open('desktop_b', b);
  await f.show(service.desktopId, ['shared_session'], 1, b);
  await f.registry.unsubscribe({ desktopId: service.desktopId }, a);
  f.mark('a unsubscribed');
  f.frames.length = 0; f.envelopes.length = 0;
  f.publish('shared_session', 'still observed');
  f.mark('shared row');
  await f.registry.unsubscribe({ desktopId: service.desktopId }, b);
  f.mark('b unsubscribed');
  f.frames.length = 0; f.envelopes.length = 0;
  f.publish('shared_session', 'no observers');
  f.mark('after the last observer');
  return { trace: f.trace };
});

await set.finish({
  entry: { hops: "No wire in the Node test: the registry emits frames to a local onFrame; each frame envelope is recorded whole.",
    runs: 'DesktopServiceRegistry (init / invoke setVisibleSessions / releaseClient / unsubscribe) with the real createDesktopServiceStateSync adapter over a scripted host, the lifecycle-desktop-service fixture module, and the real snapshot delta decoder',
    notRun: 'the daemon transport (the registry\'s onFrame is a local array); the host is a scripted object (registrations and published lane rows)',
  },
  replay: { entry: 'mixdog-app-server connection.rs (desktop registration): replay each trace step: the same init/invoke/release/unsubscribe calls and published rows; compare registrations after each step and the frames (kind, sessionId, wire) whole', normalised: {} },
});
process.exit(0);
