#!/usr/bin/env node
// Recording of the session transport's call lanes (b6f10295a): src/standalone/session-transport/call-lanes.mjs createCallLanes (the
// three owner-fair schedulers of src/runtime/shared/fair-call-scheduler.mjs, run on the real setImmediate) driven the way
// session-transport/call-route.mjs drives it (`lanes.dispatch(ownerKey, run, { lane: callLane(name, args) })`, no abort signal).
// Each case enqueues calls in one event-loop turn and records, in order, every call's start, every refusal (message and statusCode)
// and the lanes' snapshot counters read right after the enqueue.
//
//   node benchmarks/rust-core/recorders/record-session-call-lanes.mjs --tree D:\mixdog-build\tmp\b6f-tree
import { openSet } from './lib/case-set.mjs';

const set = openSet('session-call-lanes', import.meta.url);
const { createCallLanes, callLane } = await set.load('src/standalone/session-transport/call-lanes.mjs');

const counters = (lanes) => {
  const s = lanes.snapshot();
  const pick = ({ active, queued, queueMax }) => ({ active, queued, queueMax });
  return { critical: pick(s.critical), interactive: pick(s.interactive), normal: pick(s.normal) };
};

/** Dispatches `calls` ([owner, call name, label]) in this turn; every call starts, returns its label and is settled at once. */
async function burst(calls, { close = null } = {}) {
  const lanes = createCallLanes();
  const events = [];
  const refused = [];
  const settled = calls.map(([owner, name, label]) =>
    lanes
      .dispatch(owner, () => { events.push(label); return label; }, { lane: callLane(name, {}) })
      .catch((error) => { refused.push({ call: label, message: error.message, statusCode: error.statusCode ?? null }); }));
  const afterEnqueue = counters(lanes);
  if (close) lanes.close(close);
  await Promise.all(settled);
  return { calls, afterEnqueue, started: events, refused, afterSettled: counters(lanes) };
}

const many = (owner, name, prefix, count) => Array.from({ length: count }, (_, n) => [owner, name, `${prefix}${n}`]);

await set.run('callLane classifies every call name the transport routes', () => {
  const calls = [
    ['session.abort', {}], ['session.approve', {}], ['session.unsubscribe', {}], ['desktop.control', {}], ['desktop.ready', {}], ['desktop.unsubscribe', {}],
    ['session.create', {}], ['session.read', {}], ['session.subscribe', {}], ['session.submit', {}], ['session.configure', {}], ['project.list', {}],
    ['project.inspect', {}], ['project.add', {}], ['project.touch', {}], ['project.rename', {}], ['project.remove', {}], ['project.ensureDirectory', {}], ['desktop.init', {}],
    ['desktop.invoke', { method: 'termEnsure' }], ['desktop.invoke', { method: 'termWrite' }], ['desktop.invoke', { method: 'termResize' }], ['desktop.invoke', { method: 'termDispose' }],
    ['desktop.invoke', { method: 'termProfiles' }], ['desktop.invoke', { method: 'invokeDesktopOperation', args: ['termResize'] }],
    ['desktop.invoke', { method: 'invokeDesktopOperation', args: ['openExternal'] }], ['desktop.invoke', { method: 'openExternal' }],
    ['session.list', {}], ['session.close', {}], ['unknown.call', {}],
  ];
  return calls.map(([name, args]) => ({ name, args, lane: callLane(name, args) }));
});

await set.run('the normal lane refuses past its 1024 queue for one owner', () =>
  burst(many('session:A', 'session.list', 'a', 1025)));

await set.run('a second owner takes a seat in a full normal lane from the largest borrower', () =>
  burst([...many('session:A', 'session.list', 'a', 1024), ...many('session:B', 'session.list', 'b', 3)]));

await set.run('an owner past its fair share while another waits is refused with the client queue message', () =>
  burst([...many('session:A', 'session.list', 'a', 100), ...many('session:B', 'session.list', 'b', 600)]));

await set.run('owners take turns in the order the fair scheduler picks them', () =>
  burst([...many('session:A', 'session.list', 'a', 6), ...many('session:B', 'session.list', 'b', 6), ...many('session:C', 'session.list', 'c', 3)]));

await set.run('an abort and an approval start at once ahead of the reads queued before them', () =>
  burst([
    ...many('session:A', 'session.list', 'read', 50),
    ['session:A', 'session.abort', 'abort'],
    ['session:A', 'session.approve', 'approve'],
    ['session:B', 'session.read', 'interactive-read'],
    ['session:A', 'session.unsubscribe', 'unsubscribe'],
  ]));

// The attach calls (`session.subscribe`, the desktop's `desktop.init`) are interactive: they wait behind the interactive calls their owner
// made before them and start in their lane's turn, while an abort or an approval made after them starts at once. (A phone's feed opens
// are not calls: the relay's `setRemoteLanes` never reaches these lanes.)
await set.run('an attach queues in the interactive lane behind the calls made before it', () =>
  burst([
    ...many('session:A', 'session.read', 'read', 3),
    ['session:A', 'session.subscribe', 'subscribe'],
    ['client:desktop', 'desktop.init', 'desktop-init'],
    ['session:A', 'session.list', 'list'],
    ['session:A', 'session.abort', 'abort'],
    ['session:B', 'session.subscribe', 'other-subscribe'],
  ]));

await set.run('the critical lane queues nothing, even past 256 calls', () =>
  burst(many('session:A', 'session.abort', 'abort', 300)));

await set.run('the interactive lane refuses past its 512 queue for one owner', () =>
  burst(many('session:A', 'session.read', 'read', 513)));

await set.run('a call queued by an owner that has gone away still starts (the route passes no abort signal)', () =>
  burst([...many('client:gone', 'session.list', 'gone', 3), ...many('client:other', 'session.list', 'other', 3)]));

await set.run('closing the lanes refuses every queued call and any later one', async () => {
  const lanes = createCallLanes();
  const events = [];
  const refused = [];
  const calls = [...many('session:A', 'session.list', 'n', 4), ...many('session:A', 'session.read', 'i', 2)];
  const queued = calls.map(([owner, name, label]) =>
    lanes.dispatch(owner, () => { events.push(label); }, { lane: callLane(name, {}) }).catch((error) => { refused.push({ call: label, message: error.message, statusCode: error.statusCode ?? null }); }));
  lanes.close('session service transport is closed');
  await Promise.all(queued);
  const later = await lanes.dispatch('session:A', () => 'late', { lane: 'normal' }).then(() => 'started', (error) => ({ message: error.message, statusCode: error.statusCode ?? null }));
  return { calls, closeReason: 'session service transport is closed', started: events, refused, later };
});

await set.finish({
  entry: {
    runs: 'createCallLanes and callLane of src/standalone/session-transport/call-lanes.mjs over the real fair-call-scheduler (setImmediate dispatch, owner groups); every observation is the order of the calls it started, the refusals it raised and the lanes snapshot',
    notRun: 'the HTTP route and the client registry: call-route.mjs ownerKeyFor (session:<id>, pid:<leadPid>, client:<token>) only names the owners the cases use; its callId cache and 200 {error} envelope are not part of the lanes',
  },
  replay: { entry: 'mixdog-app-server call lanes (lanes.rs): the same enqueues, the starts in order, the refusals (message, status) and the counters; Node status codes are not on the wire (the route answers {error: message}), so the replay compares them on the scheduler and the message on the wire', normalised: {} },
});
process.exit(0);
