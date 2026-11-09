// The phone's terminal and folder-watch script. One list of ops, played against Node's remote methods (the recorder) and against the
// phone's protocol adapter over a real mixdogd (the replay); `play` returns the trace both must produce.
//
// A trace holds what the page can tell apart: each call's answer or its error text, and, per push kind, the events its listeners got,
// in order. Pushes of different kinds race each other on a real shell, so each kind keeps its own list; every wait is on an event the
// product itself produces (`until`), never on a clock.
//
// Terminal text is compared as the screen the user sees (lib/phone-screen.mjs: the rows' text and attributes and the cursor, as xterm.js
// draws the stream). The bytes of a real ConPTY and shell vary from one run to the next (PSReadLine redraws the typed line per
// keystroke or in one frame; ConPTY re-renders after a resize in a varying number of frames, and when those frames arrive relative to
// a call is a race), the screen does not once the shell has settled. So every terminal text the trace holds is a screen: each reply's
// `replay`, and the output a tab streamed at a `snap`. A `settle` is the barrier that makes a screen well-defined: it has the shell run
// a marker command and waits until the marker's result and the next prompt are on the screen, which is after everything the shell
// and ConPTY had written for earlier resizes. Nothing of a reply or a push is left out of the comparison.
import { join } from 'node:path';import { linesOf, screenOf } from './phone-screen.mjs';

export const TAB = 'term_ph2a';
const CLAMP = 'term_ph2b';
export const MARK ='MIXDOG_PH2_DONE';
/** The marker command a `settle` runs: its result line, the marker alone, is what the wait looks for. */
const SETTLE = (n) => `MIXDOG_PH2_SETTLE_${n}`;
/** The agent's reveal as the desktop holds it (ack id and paths included), and what a paired phone is pushed. */
const RUN = {
  sessionId: 's1',
  terminalId: 'session-terminal:s1:2',
  tabs: [{ id: 'session-terminal:s1:2', tab: 2, cwd: '/work' }],
  requestId: 'req-1',
};
const RUN_PUSH = { sessionId: 's1', terminalId: 'session-terminal:s1:2', tabs: [{ id: 'session-terminal:s1:2', tab: 2 }] };

/**
 * The barrier (see the header): the shell runs the marker command, its `finished` activity (the `finished`th of this tab) comes, and the
 * screen shows the marker's result line followed by the prompt.
 */
const settle = (tab, n, finished, prompt) => [
  { op: 'fire', name: 'termWrite', params: [tab, `Write-Output ${SETTLE(n)}\r`] },
  { op: 'until', kind: 'activity', event: { id: tab, state: 'finished' }, count: finished },
  { op: 'until', kind: 'screen', tab, after: SETTLE(n), prompt },
];

/** `root` is a directory both sides use, so paths in answers and errors are the same text. */
export function terminalScript(root) {
  const cwd = join(root, 'cwd');
  const prompt = `PS ${cwd}>`;
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
      // The command's own output line (the echo before it is a line of its own with the prompt) and the prompt the shell prints after it.
      { op: 'until', kind: 'screen', tab: TAB, after: MARK, prompt },
      { op: 'snap', name: 'result', tabs: [TAB] },
      { op: 'call', name: 'termActivity', params: [] },
      // Focusing the finished tab clears it.
      { op: 'call', name: 'termFocus', params: [TAB, true] },
      { op: 'until', kind: 'activity', event: { id: TAB, state: 'idle' }, count: 2 },
      { op: 'call', name: 'termFocus', params: [TAB, false] },
      { op: 'call', name: 'termActivity', params: [] },
      // Size ownership: a claim owns, a plain resize is ignored, the owner's size comes with ensure and attach, a release frees it.
      { op: 'fire', name: 'termResize', params: [TAB, 100, 30, true] },
      { op: 'until', kind: 'sizeOwner', event: { id: TAB, cols: 100, rows: 30, own: true } },
      ...settle(TAB, 1, 2, prompt),
      { op: 'snap', name: 'resized 100x30', tabs: [TAB] },
      { op: 'fire', name: 'termResize', params: [TAB, 60, 20, false] },
      { op: 'call', name: 'termEnsure', params: [TAB, cwd, null] },
      { op: 'call', name: 'termAttach', params: [TAB] },
      // The clamp to 2..500 x 2..200 on a tab of its own: a shell in a 2-column terminal crashes at a time nothing awaits, so no screen of
      // it is compared; the owner's size, which is what the clamp decides, is.
      { op: 'call', name: 'termEnsure', params: [CLAMP, cwd, null] },
      { op: 'until', kind: 'activity', event: { id: CLAMP, state: 'idle' } },
      { op: 'fire', name: 'termResize', params: [CLAMP, 1, 900, true] },
      { op: 'until', kind: 'sizeOwner', event: { id: CLAMP, cols: 2, rows: 200, own: true } },
      { op: 'call', name: 'termDispose', params: [CLAMP] },
      { op: 'until', kind: 'activity', event: { id: CLAMP, state: null } },
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
      { op: 'snap', name: 'end', tabs: [TAB] },
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
 * (`from: 'other'`). `advance` moves time on by exactly that much: Node's recording ticks its virtual clock, the replay steps the
 * core's manual lease clock (a debug build with MIXDOG_TERMINAL_LEASE_CLOCK set). No wall time passes in either.
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
  const prompt = `PS ${cwd}>`;
  // A tab a claim has resized is settled (see the header) before it is attached, so its replay is a screen and not a race with
  // the re-render ConPTY sends for the new size.
  const resized = new Set();
  const settled = new Map();
  const claim = (tab, cols, rows, from) => {
    resized.add(tab);
    return { op: 'fire', name: 'termResize', params: [tab, cols, rows, true], ...(from ? { from } : {}) };
  };
  const owner = (id, cols, rows, own, count) => ({ op: 'until', kind: 'sizeOwner', event: { id, cols, rows, own }, ...(count ? { count } : {}) });
  const barrier = (tab) => {
    if (!resized.delete(tab)) return [];
    const n = (settled.get(tab) ?? 0) + 1;
    settled.set(tab, n);
    return settle(tab, n, n, prompt);
  };
  const attachAll = (list) => list.flatMap((tab) => [...barrier(tab), { op: 'call', name: 'termAttach', params: [tab] }]);
  return {
    cwd,
    ops: [
      { op: 'lane', lane: 'terminal', on: true },
      ...tabs.map((tab) => ({ op: 'call', name: 'termEnsure', params: [tab, cwd, null] })),
      // Every shell is up (its first prompt made the tab idle) before the leases are timed, so the disposals at the end end live shells.
      ...tabs.map((tab) => ({ op: 'until', kind: 'activity', event: { id: tab, state: 'idle' } })),
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
      ...attachAll([L2]),
      { op: 'advance', ms: 2000 },
      { op: 'close', who: 'other' },
      { op: 'advance', ms: 8000 },
      claim(L2, 101, 31),
      ...attachAll([L2]),
      { op: 'advance', ms: 5000 },
      // 25 s: every claim still stands except the released one. Then time steps to each lease edge: the millisecond before it the
      // claim holds, the edge itself ends it (L1 at 30 s, L4 at 32 s, L6's phone claim at 34 s, L2 at 50 s, 30 s after its renewal at 20 s).
      ...attachAll(tabs),
      { op: 'advance', ms: 4999 },
      ...attachAll(tabs),
      { op: 'advance', ms: 1 },
      owner(L1, 0, 0, false),
      ...attachAll(tabs),
      { op: 'advance', ms: 1999 },
      ...attachAll(tabs),
      { op: 'advance', ms: 1 },
      owner(L4, 0, 0, false),
      ...attachAll(tabs),
      { op: 'advance', ms: 1999 },
      ...attachAll(tabs),
      { op: 'advance', ms: 1 },
      owner(L6, 0, 0, false),
      ...attachAll(tabs),
      { op: 'advance', ms: 15999 },
      ...attachAll(tabs),
      { op: 'advance', ms: 1 },
      owner(L2, 0, 0, false),
      ...attachAll(tabs),
      { op: 'snap', name: 'end', tabs },
      ...tabs.map((tab) => ({ op: 'call', name: 'termDispose', params: [tab] })),
      { op: 'lane', lane: 'terminal', on: false },
    ],
  };
}

/** The marker's own line is on the screen with the prompt right after it: what the shell wrote for the command is complete. */
const onScreen = (text, { after, prompt }) => {
  const lines = linesOf(text).map((line) => line.trimEnd());
  const at = lines.lastIndexOf(after);
  return at >= 0 && lines[at + 1] === prompt;
};

/**
 * Plays the ops against a driver and returns the trace.
 * A reply's `replay` is recorded as the screen it draws; a `snap` records the screen each named tab's streamed output draws.
 * driver: call(name, params) -> value (throws the error), fire(name, params), lane(lane, on), touch(file), run(request, redeliver),
 *         waitFor(test) -> Promise (resolves once `test(events)` holds), events() ->
 *         { activity: [], sizeOwner: [], folder: [], run: [], output: { [tabId]: string } }.
 */
export async function play(script, driver) {
  const steps = [];
  const matches = (list, wanted) => list.filter((event) => JSON.stringify(event) === JSON.stringify(wanted)).length;
  for (const op of script.ops) {
    if (op.op === 'call') {
      try {
        const value = (await driver.call(op.name, op.params)) ?? null;
        steps.push({ call: op.name, params: op.params, value: typeof value?.replay === 'string' ? { ...value, replay: screenOf(value.replay) } : value });
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
    } else if (op.op === 'snap') {
      const { output } = driver.events();
      steps.push({ snap: op.name, screens: Object.fromEntries(op.tabs.map((tab) => [tab, screenOf(output[tab] ?? '')])) });
    } else if (op.op === 'until') {      await driver.waitFor((events) =>
        op.kind === 'screen' ? onScreen(events.output[op.tab] ?? '', op) : matches(events[op.kind], op.event) >= (op.count ?? 1)
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
  };
}
