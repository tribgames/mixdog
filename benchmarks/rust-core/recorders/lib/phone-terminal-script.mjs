// The phone's terminal and folder-watch script. One list of ops, played against Node's remote methods (the recorder) and against the
// phone's protocol adapter over a real mixdogd (the replay); `play` returns the trace both must produce.
//
// A trace holds what the page can tell apart: each call's answer or its error text, and, per push kind, the events its listeners got,
// in order. Pushes of different kinds race each other on a real shell, so each kind keeps its own list; every wait is on an event the
// product itself produces (`until`), never on a clock.
//
// The terminal text is compared exactly: every reply's `replay` and the streamed `output` are what Node's real ConPTY and shell produced.
// Two Node recordings of this script differ in the shell's echo of the typed command (PSReadLine redraws the line as it is typed: one
// recording held the line in one frame, the next redrew it per character with colour and cursor moves), so that echo, and only that, is
// recorded as `[echo]` in `output`. ConPTY re-renders the screen after a resize, in a
// number of frames and a form (blank fill by spaces or by ESC[K) that differ from one Node recording to the next, and when it arrives
// relative to the script's calls is not something a step awaits. So, and only so:
//   - `output`: the text up to ConPTY's first resize report (`ESC[8;`) is exact, but for that echo; what follows is recorded as `reRendered: true` only;
//   - the answers to calls made after that resize (`RESIZED`) and the size-claim script's attach answers (`only`) keep `id` and
//     `sizeOwner`, not `replay`: with the loop turned between calls, three Node recordings held 235, 553 and 957 characters of `replay`
//     at the same step; the size-claim script's attach answers differed in 23 of 52 in two recordings.
// Everything else, the terminal text of every other answer and push included, is compared as it came.
import { join } from 'node:path';

export const TAB = 'term_ph2a';
export const MARK = 'MIXDOG_PH2_DONE';
/** What ConPTY prints when the size changes: a report of the new size, then a re-render of the screen. */
const RESIZE_REPORT = '\x1b[8;';
/** The answers kept for calls made after the tab was resized (see the header). */
const RESIZED = ['id', 'sizeOwner'];
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
      // The command's own output line (the echo before it holds MARK too, never followed by a line end and the prompt) and the prompt
      // the shell prints after it, so the resize below follows the whole result.
      { op: 'until', kind: 'output', text: `${MARK}\r\nPS ${cwd}> ` },
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
      { op: 'call', name: 'termEnsure', params: [TAB, cwd, null], only: RESIZED },
      { op: 'call', name: 'termAttach', params: [TAB], only: RESIZED },
      { op: 'fire', name: 'termResize', params: [TAB, 1, 900, true] },
      { op: 'until', kind: 'sizeOwner', event: { id: TAB, cols: 2, rows: 200, own: true } },
      { op: 'fire', name: 'termResize', params: [TAB, 0, 0, true] },
      { op: 'until', kind: 'sizeOwner', event: { id: TAB, cols: 0, rows: 0, own: false } },
      { op: 'call', name: 'termAttach', params: [TAB], only: RESIZED },
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
  const claim = (tab, cols, rows, from) => ({ op: 'fire', name: 'termResize', params: [tab, cols, rows, true], ...(from ? { from } : {}) });
  const owner = (id, cols, rows, own, count) => ({ op: 'until', kind: 'sizeOwner', event: { id, cols, rows, own }, ...(count ? { count } : {}) });
  const attachAll = (list) => list.map((tab) => ({ op: 'call', name: 'termAttach', params: [tab], only: ['id', 'sizeOwner'] }));
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
      ...tabs.map((tab) => ({ op: 'call', name: 'termDispose', params: [tab] })),
      { op: 'lane', lane: 'terminal', on: false },
    ],
  };
}

/**
 * The streamed text up to ConPTY's first resize report, exactly, but for the shell's echo of the typed command; after the report only
 * that a re-render came (see the header). The echo is the text between the first prompt and the command's result line: PSReadLine
 * redraws the line as it is typed (syntax colouring, cursor moves), in a number of frames that differs between Node recordings.
 */
function streamed(output, cwd) {
  const at = output.indexOf(RESIZE_REPORT);
  const head = at < 0 ? output : output.slice(0, at);
  const prompt = `PS ${cwd}> `;
  const echoFrom = head.indexOf(prompt) + prompt.length;
  const echoTo = head.indexOf(`${MARK}\r\n${prompt}`);
  const text = echoFrom >= prompt.length && echoTo >= echoFrom ? `${head.slice(0, echoFrom)}[echo]${head.slice(echoTo)}` : head;
  return { text, reRendered: at >= 0 };
}

/**
 * Plays the ops against a driver and returns the trace.
 * An op with `only` keeps just those fields of the call's answer.
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
        const value = (await driver.call(op.name, op.params)) ?? null;
        steps.push({ call: op.name, params: op.params, value: op.only ? Object.fromEntries(op.only.filter((key) => key in value).map((key) => [key, value[key]])) : value });
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
    output: streamed(events.output, script.cwd),
  };
}
