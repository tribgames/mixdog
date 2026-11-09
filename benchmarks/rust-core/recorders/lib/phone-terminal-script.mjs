// The phone's terminal and folder-watch script. One list of ops, played against Node's remote methods (the recorder) and against the
// phone's protocol adapter over a real mixdogd (the replay); `play` returns the trace both must produce.
//
// A trace holds what the page can tell apart: each call's answer or its error text, and, per push kind, the events its listeners got,
// in order. Pushes of different kinds race each other on a real shell, so each kind keeps its own list; every wait is on an event the
// product itself produces (`until`), never on a clock.
//
// What a shell prints (the prompt, the echo) is the shell's, not the product's: the script compares `output`/`replay` only through the
// facts it controls (the command's marker text arrived, no integration marker leaked).
import { join } from 'node:path';

export const TAB = 'term_ph2a';
export const MARK = 'MIXDOG_PH2_DONE';
/** The agent's reveal as the desktop holds it (ack id and paths included), and what a paired phone is pushed. */
const RUN = {
  sessionId: 's1',
  terminalId: 'session-terminal:s1:2',
  tabs: [{ id: 'session-terminal:s1:2', tab: 2, cwd: '/work' }],
  requestId: 'req-1',
};
const RUN_PUSH = { sessionId: 's1', terminalId: 'session-terminal:s1:2', tabs: [{ id: 'session-terminal:s1:2', tab: 2 }] };

/** `root` is a directory both sides use, so paths in answers and errors are the same text. */
export function terminalScript(root) {
  const cwd = join(root, 'cwd');
  const watched = join(root, 'watched');
  const missing = join(root, 'missing');
  return {
    cwd,
    watched,
    missing,
    ops: [
      { op: 'call', name: 'termProfiles', params: [] },
      // Arguments Node refused before it touched a terminal, with its texts.
      { op: 'call', name: 'termAttach', params: [5] },
      { op: 'call', name: 'termAttach', params: ['   '] },
      { op: 'call', name: 'termAttach', params: ['x'.repeat(129)] },
      { op: 'call', name: 'termDispose', params: [null] },
      { op: 'call', name: 'termFocus', params: [undefined, true] },
      { op: 'call', name: 'folderWatch', params: [1] },
      { op: 'call', name: 'folderWatch', params: [''] },
      { op: 'call', name: 'folderWatch', params: ['x'.repeat(16385)] },
      { op: 'call', name: 'folderWatch', params: ['/a\u0000b'] },
      { op: 'call', name: 'folderWatch', params: ['relative/dir'] },
      { op: 'call', name: 'folderUnwatch', params: ['relative/dir'] },
      { op: 'call', name: 'folderWatch', params: [missing, false] },
      { op: 'call', name: 'folderUnwatch', params: [missing, false] },
      // Nothing runs yet.
      { op: 'call', name: 'termAttach', params: [TAB] },
      { op: 'call', name: 'termActivity', params: [] },
      { op: 'call', name: 'termDispose', params: [TAB] },
      { op: 'lane', lane: 'terminal', on: true },
      { op: 'lane', lane: 'files', on: true },
      // A new terminal: its id and an empty replay; the shell's first prompt makes it idle.
      { op: 'call', name: 'termEnsure', params: [TAB, cwd, null] },
      { op: 'until', kind: 'activity', event: { id: TAB, state: 'idle' } },
      { op: 'call', name: 'termActivity', params: [] },
      // A command: running, then finished (no view has the tab focused).
      { op: 'fire', name: 'termWrite', params: [TAB, `Write-Output ${MARK}\r`] },
      { op: 'until', kind: 'activity', event: { id: TAB, state: 'finished' } },
      { op: 'until', kind: 'output', text: MARK },
      { op: 'call', name: 'termActivity', params: [] },
      // Focusing the finished tab clears it.
      { op: 'call', name: 'termFocus', params: [TAB, true] },
      { op: 'until', kind: 'activity', event: { id: TAB, state: 'idle' }, count: 2 },
      { op: 'call', name: 'termFocus', params: [TAB, false] },
      { op: 'call', name: 'termActivity', params: [] },
      // Size ownership: a claim owns, a plain resize is ignored, the owner's size comes with ensure and attach, a release frees it.
      { op: 'fire', name: 'termResize', params: [TAB, 100, 30, true] },
      { op: 'until', kind: 'sizeOwner', event: { id: TAB, cols: 100, rows: 30, own: true } },
      { op: 'fire', name: 'termResize', params: [TAB, 60, 20, false] },
      { op: 'call', name: 'termEnsure', params: [TAB, cwd, null] },
      { op: 'call', name: 'termAttach', params: [TAB] },
      { op: 'fire', name: 'termResize', params: [TAB, 1, 900, true] },
      { op: 'until', kind: 'sizeOwner', event: { id: TAB, cols: 2, rows: 200, own: true } },
      { op: 'fire', name: 'termResize', params: [TAB, 0, 0, true] },
      { op: 'until', kind: 'sizeOwner', event: { id: TAB, cols: 0, rows: 0, own: false } },
      { op: 'call', name: 'termAttach', params: [TAB] },
      // A folder watched twice reports a change once; the second unwatch ends it.
      { op: 'call', name: 'folderWatch', params: [watched, true] },
      { op: 'call', name: 'folderWatch', params: [watched, true] },
      { op: 'touch', file: join(watched, 'a.txt') },
      { op: 'until', kind: 'folder', event: watched },
      { op: 'call', name: 'folderUnwatch', params: [watched, true] },
      { op: 'touch', file: join(watched, 'b.txt') },
      { op: 'until', kind: 'folder', event: watched, count: 2 },
      { op: 'call', name: 'folderUnwatch', params: [watched, true] },
      { op: 'call', name: 'folderUnwatch', params: [watched, true] },
      // The tab goes: the activity ends, and nothing is left to attach.
      { op: 'call', name: 'termDispose', params: [TAB] },
      { op: 'until', kind: 'activity', event: { id: TAB, state: null } },
      { op: 'call', name: 'termDispose', params: [TAB] },
      { op: 'call', name: 'termAttach', params: [TAB] },
      { op: 'call', name: 'termActivity', params: [] },
      // Off the lanes, nothing is pushed any more; a reveal of the agent's terminal is not a lane push and still arrives, without the
      // ack id and the paths. The core delivers an app-feed event again after a reconnect (`redeliver`): the page hears it once.
      { op: 'lane', lane: 'terminal', on: false },
      { op: 'lane', lane: 'files', on: false },
      { op: 'run', request: RUN },
      { op: 'until', kind: 'run', event: RUN_PUSH },
      { op: 'run', request: RUN, redeliver: true },
      { op: 'run', request: { sessionId: 's2', requestId: 'req-2', tabs: [{ id: 3, tab: 'x' }] } },
      { op: 'until', kind: 'run', event: { sessionId: 's2' } },
    ],
  };
}

/**
 * The size-claim cases, on one timeline: five tabs, each case on its own tab, claims by the phone and by a second connection
 * (`from: 'other'`). `advance` moves time on: Node's recording moves a virtual clock, a real core has none and waits that long.
 * Every checkpoint sits 3 s or more from a lease edge, and every lapse is awaited on its event, so only the order is compared.
 *
 *   L1 lapse     the phone claims at 0 s and never renews: the claim lapses at 30 s.
 *   L2 renewal   claims at 1 s, renews at 10 s and 20 s: still held at 37 s, lapses at 50 s (30 s after the last renewal).
 *   L4 close     the other connection claims at 2 s and closes at 12 s: Node does nothing at close, the lease lapses it at 32 s.
 *   L5 release   a claim with a zero size frees the size at once.
 *   L6 two       the phone claims at 4 s, the other connection at 5 s and owns; its zero size at 10 s hands the size back to the phone,
 *                whose claim lapses at 34 s.
 */
export function sizeClaimScript(root) {
  const cwd = join(root, 'cwd');
  const [L1, L2, L4, L5, L6] = ['term_ph2_l1', 'term_ph2_l2', 'term_ph2_l4', 'term_ph2_l5', 'term_ph2_l6'];
  const tabs = [L1, L2, L4, L5, L6];
  const claim = (tab, cols, rows, from) => ({ op: 'fire', name: 'termResize', params: [tab, cols, rows, true], ...(from ? { from } : {}) });
  const owner = (id, cols, rows, own, count) => ({ op: 'until', kind: 'sizeOwner', event: { id, cols, rows, own }, ...(count ? { count } : {}) });
  const attachAll = (list) => list.map((tab) => ({ op: 'call', name: 'termAttach', params: [tab] }));
  return {
    cwd,
    ops: [
      { op: 'lane', lane: 'terminal', on: true },
      ...tabs.map((tab) => ({ op: 'call', name: 'termEnsure', params: [tab, cwd, null] })),
      // From here the leases are timed.
      { op: 'clock' },
      claim(L1, 100, 30),
      owner(L1, 100, 30, true),
      { op: 'advance', ms: 1000 },
      claim(L2, 101, 31),
      owner(L2, 101, 31, true),
      { op: 'advance', ms: 1000 },
      claim(L4, 102, 32, 'other'),
      owner(L4, 102, 32, false),
      { op: 'advance', ms: 1000 },
      claim(L5, 104, 34),
      owner(L5, 104, 34, true),
      claim(L5, 0, 0),
      owner(L5, 0, 0, false),
      { op: 'advance', ms: 1000 },
      claim(L6, 103, 33),
      owner(L6, 103, 33, true),
      { op: 'advance', ms: 1000 },
      claim(L6, 83, 24, 'other'),
      owner(L6, 83, 24, false),
      { op: 'advance', ms: 5000 },
      claim(L2, 101, 31),
      claim(L6, 0, 0, 'other'),
      owner(L6, 103, 33, true, 2),
      { op: 'call', name: 'termAttach', params: [L2] },
      { op: 'advance', ms: 2000 },
      { op: 'close', who: 'other' },
      { op: 'advance', ms: 8000 },
      claim(L2, 101, 31),
      { op: 'call', name: 'termAttach', params: [L2] },
      { op: 'advance', ms: 5000 },
      // 25 s: every claim still stands except the released one.
      ...attachAll(tabs),
      { op: 'advance', ms: 12000 },
      owner(L1, 0, 0, false),
      owner(L4, 0, 0, false),
      owner(L6, 0, 0, false),
      // 37 s: L1, L4 and L6 lapsed; L2's last renewal was at 20 s.
      ...attachAll(tabs),
      { op: 'advance', ms: 18000 },
      owner(L2, 0, 0, false),
      // 55 s.
      ...attachAll(tabs),
      ...tabs.map((tab) => ({ op: 'call', name: 'termDispose', params: [tab] })),
      { op: 'lane', lane: 'terminal', on: false },
    ],
  };
}

/** What a terminal reply says without the shell's own text: the reply with `replay` reduced to the facts the script controls. */
export function replayFacts(replay) {
  return { hasMark: replay.includes(MARK), leakedMarker: replay.includes(']697;') };
}

const reduce = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) && typeof value.replay === 'string' ? { ...value, replay: replayFacts(value.replay) } : value;

/**
 * Plays the ops against a driver and returns the trace.
 * driver: call(name, params) -> value (throws the error), fire(name, params), lane(lane, on), touch(file), run(request, redeliver),
 *         waitFor(test) -> Promise (resolves once `test(events)` holds), events() ->
 *         { activity: [], sizeOwner: [], folder: [], run: [], output: string }.
 */
export async function play(script, driver) {
  const steps = [];
  const matches = (list, wanted) => list.filter((event) => JSON.stringify(event) === JSON.stringify(wanted)).length;
  for (const op of script.ops) {
    if (op.op === 'call') {
      try {
        steps.push({ call: op.name, params: op.params, value: reduce(await driver.call(op.name, op.params)) ?? null });
      } catch (error) {
        steps.push({ call: op.name, params: op.params, error: error instanceof Error ? error.message : String(error) });
      }
    } else if (op.op === 'fire') {
      driver.fire(op.name, op.params, op.from);
      steps.push({ fire: op.name });
    } else if (op.op === 'clock') {
      driver.clock();
    } else if (op.op === 'advance') {
      await driver.advance(op.ms);
    } else if (op.op === 'close') {
      driver.close(op.who);
    } else if (op.op === 'lane') {
      driver.lane(op.lane, op.on);
      steps.push({ lane: op.lane, on: op.on });
    } else if (op.op === 'run') {
      driver.run(op.request, op.redeliver === true);
    } else if (op.op === 'touch') {
      driver.touch(op.file);
    } else if (op.op === 'until') {
      await driver.waitFor((events) =>
        op.kind === 'output' ? events.output.includes(op.text) : matches(events[op.kind], op.event) >= (op.count ?? 1)
      );
    }
  }
  const events = driver.events();
  return {
    steps,
    activity: events.activity,
    sizeOwner: events.sizeOwner,
    folder: events.folder,
    run: events.run,
    output: replayFacts(events.output),
  };
}
