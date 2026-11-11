// The replay of record-desktop-visibility-restart-cases.mjs on K1. Node shared one desktop service between desktop processes
// (DesktopServiceRegistry) and filtered its session frames by each process's versioned `setVisibleSessions`. In K1 each desktop
// process is its own connection to the core: its service route (apps/desktop/src/main/protocol/service-route.ts) turns
// `setVisibleSessions(ids, version)` into `thread/resume` / `thread/unsubscribe` on that connection, fencing a version older than
// or equal to the newest it sent, and a process that ends closes its connection, which drops its subscriptions. Run by
// mixdog-core-session client_chain_replay_tests.rs, which answers the core's half (lib/core-bridge.mjs).
//
// What a user sees, compared at each recorded step:
//  - `visible`: the conversations the desktops have open now (Node: the newest registration of the shared host);
//  - `rows`: each conversation row delivered since the step's frames were cleared, as `[conversation, text]` in order (Node: the
//    session-state frames, one per published row; K1: the rows' `item/completed` on the connections that follow it);
//  - the outcome of a late registration (rejected) and the acceptance of a restarted desktop's first one.
// The agent pool frame of case 1 is not compared: it reaches every connection over the app feed, whatever conversations it shows.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { fromExact } from './lib/exact.mjs';
import { coreBridge } from './lib/core-bridge.mjs';
import { createServiceLane } from '../../../apps/desktop/src/main/protocol/service-route.ts';

const golden = fromExact(JSON.parse(readFileSync(new URL('../../../native/core/fixtures/desktop-visibility-restart-cases/golden.json', import.meta.url), 'utf8')));
const core = coreBridge();
const failures = [];
/** Connections are the core's: numbered across the cases, as one core serves them all. */
let connections = 0;

/** A Node session-state frame as the row it delivered: `[session, text]`. */
function nodeRow(frame) {
  const wire = frame.wire ?? {};
  const appended = wire.__itemsPatch?.append ?? wire.items ?? [];
  return [frame.sessionId, appended.at(-1)?.text];
}

/** One case's world: conversations by Node name, desktop processes by client token. */
function world() {
  const threads = new Map();
  const names = new Map();
  const desktops = new Map();
  let rows = [];
  const marks = [];
  /** The conversations the live desktops' connections follow in the core now. */
  const visible = async () => {
    const ids = [];
    for (const desktop of desktops.values()) if (!desktop.closed) ids.push(...(await core.call('subscribed', { conn: desktop.conn })));
    return [...new Set(ids.map((id) => names.get(id)))].sort();
  };
  const threadOf = async (name) => {
    if (!threads.has(name)) {
      const { threadId } = await core.call('thread');
      threads.set(name, threadId);
      names.set(threadId, name);
    }
    return threads.get(name);
  };
  /** The rows every live desktop received since it last looked. */
  const collect = async () => {
    for (const desktop of desktops.values()) {
      if (desktop.closed) continue;
      for (const frame of await core.call('frames', { conn: desktop.conn })) {
        if (frame.method === 'item/completed') rows.push([names.get(frame.threadId), frame.params.item.content?.[0]?.text]);
      }
    }
  };
  return {
    /** A desktop process connects (Node: `registry.init`); the same client opening again is the same process. */
    open(token) {
      if (!desktops.has(token)) {
        const conn = ++connections;
        const desktop = { conn, closed: false };
        const protocol = {
          call: async (method, params) => {
            if (method === 'thread/resume') return core.call('resume', { conn, threadId: await threadOf(params.threadId), window: params.window });
            if (method === 'thread/unsubscribe') return core.call('unsubscribe', { conn, threadId: await threadOf(params.threadId) });
            throw new Error(`unexpected ${method}`);
          },
          notify() {},
        };
        desktop.lane = createServiceLane({ protocol, snapshot: () => null });
        desktops.set(token, desktop);
      }
    },
    /** `setVisibleSessions(ids, version)` of the desktop with `token` (the route names a conversation as Node did; the bridge's
     *  protocol resolves it to its thread). A process that ended sends nothing. */
    async show(token, ids, version) {
      const desktop = desktops.get(token);
      if (desktop.closed) throw new Error('the desktop process has ended');
      return desktop.lane.call('setVisibleSessions', version === undefined ? [ids] : [ids, version]);
    },
    /** The process with `token` ended (Node: `releaseClient` / `unsubscribe`). */
    async end(token) {
      const desktop = desktops.get(token);
      await collect();
      desktop.closed = true;
      await core.call('close', { conn: desktop.conn });
    },
    async publish(name, text) {
      await core.call('append', { threadId: await threadOf(name), messages: [{ role: 'user', content: text, meta: { transcript: { clientSubmissionId: text } } }] });
      await collect();
    },
    clear: async () => {
      await collect();
      rows = [];
    },
    async mark(step, extra = {}) {
      await collect();
      marks.push({ step, visible: await visible(), rows: [...rows], ...extra });
    },
    marks,
  };
}

async function replay(name, script) {
  const node = golden.cases.find((c) => c.case === name).observed;
  try {
    const w = world();
    await script(w);
    const expected = node.trace.map((t) => ({
      step: t.step,
      visible: [...(t.registrations.at(-1) ?? [])].sort(),
      rows: t.frames.filter((f) => f.kind === 'session-state').map(nodeRow),
    }));
    const actual = w.marks.map(({ step, visible, rows }) => ({ step, visible, rows }));
    if (!isDeepStrictEqual(actual, expected)) failures.push({ case: name, actual, expected });
    return { node, marks: w.marks };
  } catch (error) {
    failures.push({ case: name, error: String(error?.stack ?? error) });
    return null;
  }
}

const rejected = async (promise) => {
  try {
    return { resolved: await promise };
  } catch (error) {
    return { rejected: error };
  }
};

let outcome = await replay('a restarted desktop can register version one on the retained service and receive live conversation rows', async (f) => {
  f.open('old-client');
  await f.show('old-client', ['old_session'], 5);
  await f.end('old-client');
  f.open('replacement-client');
  const accepted = await f.show('replacement-client', ['current_session'], 1);
  await f.mark('restarted desktop registers version 1', { accepted });
  await f.clear();
  for (const text of ['sent message', 'working progress', 'completed answer']) await f.publish('current_session', text);
  await f.mark('three live rows');
  await f.mark('agent pool row');
});
if (outcome && outcome.marks[0]?.accepted !== outcome.node.trace[0].accepted) failures.push({ case: 1, what: 'accepted', actual: outcome.marks[0]?.accepted });

outcome = await replay('late registrations from a previous desktop cannot replace the current conversation filter', async (f) => {
  f.open('old-client');
  await f.show('old-client', ['old_session'], 40);
  f.open('current-client');
  await f.show('current-client', ['current_session'], 1);
  await f.end('old-client');
  const late = await rejected(f.show('old-client', ['old_session'], 41));
  await f.clear();
  await f.publish('old_session', 'must stay hidden');
  await f.publish('current_session', 'must stay live');
  await f.mark('after the late registration', { late: 'rejected' in late });
});
// Node's refusal named its service client ("desktop service client is not initialized"); in K1 the late call has no connection.
if (outcome && outcome.marks[0]?.late !== ('rejected' in outcome.node.trace[0].late)) failures.push({ case: 2, what: 'late', actual: outcome.marks[0]?.late });

await replay('out-of-order and equal registrations stay fenced within one desktop connection', async (f) => {
  f.open('current-client');
  await f.show('current-client', ['current_session'], 2);
  await f.show('current-client', ['old_session'], 1);
  await f.show('current-client', ['old_session'], 2);
  await f.mark('versions 2, 1, 2');
  await f.clear();
  await f.publish('old_session', 'must stay hidden');
  await f.publish('current_session', 'must stay live');
  await f.mark('rows published');
});

await replay('unversioned legacy registrations remain supported', async (f) => {
  f.open('desktop');
  await f.show('desktop', ['old_session'], 5);
  await f.show('desktop', ['current_session']);
  await f.clear();
  await f.publish('current_session', 'legacy live update');
  await f.mark('legacy');
});

await replay('concurrent desktops keep independent counters and the survivor stays live after the newer one disconnects', async (f) => {
  f.open('desktop-a');
  await f.show('desktop-a', ['a_session'], 1);
  f.open('desktop-b');
  await f.show('desktop-b', ['b_session'], 1);
  f.open('desktop-a');
  await f.show('desktop-a', ['a_current'], 100);
  await f.mark('a version 100');
  await f.clear();
  await f.publish('a_current', 'a is live');
  await f.publish('b_session', 'b is live');
  await f.mark('both live');
  await f.end('desktop-b');
  await f.mark('b released');
  await f.show('desktop-a', ['a_next'], 101);
  await f.mark('a version 101');
  await f.clear();
  await f.publish('a_next', 'a stays live');
  await f.publish('b_session', 'b is disconnected');
  await f.mark('after');
});

await replay('unsubscribing one desktop retains shared conversations until their last observer leaves', async (f) => {
  f.open('desktop-a');
  await f.show('desktop-a', ['shared_session'], 1);
  f.open('desktop-b');
  await f.show('desktop-b', ['shared_session'], 1);
  await f.end('desktop-a');
  await f.mark('a unsubscribed');
  await f.clear();
  await f.publish('shared_session', 'still observed');
  await f.mark('shared row');
  await f.end('desktop-b');
  await f.mark('b unsubscribed');
  await f.clear();
  await f.publish('shared_session', 'no observers');
  await f.mark('after the last observer');
});

core.done(failures);
