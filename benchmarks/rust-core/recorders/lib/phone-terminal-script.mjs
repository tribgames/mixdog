// The phone's terminal and folder-watch script. One list of ops, played against Node's remote methods (the recorder) and against the
// phone's protocol adapter over a real mixdogd (the replay); `play` returns the trace both must produce.
//
// A trace is one ordered list for the phone's connection: each call's answer or its error text, each push the page's listeners got
// (activity, size owner, folder, run) and each fire, lane switch and screen checkpoint, in the order the page saw them. Node publishes a
// disposed tab's activity end, forwards it, and only then answers the dispose; an event that moves across an answer is a different trace.
// Three Node recordings agreed on the whole order, so nothing is compared as an unordered group. Every wait is on an event the
// product itself produces (`until`), never on a clock.
//
// Terminal text is compared as the screen the user sees (lib/phone-screen.mjs: the rows' text and attributes and the cursor, as xterm.js
// draws the stream). The bytes of a real ConPTY and shell vary from one run to the next (PSReadLine redraws the typed line per
// keystroke or in one frame; ConPTY re-renders after a resize in a varying number of frames, and when those frames arrive relative to
// a call is a race), the screen does not once the shell has settled. So the checkpoints (`snap`, `screen`) hold screens; replies and
// output frames are kept as sent, and the comparison leaves out only the places where Node's runs differ. A `settle` is the barrier that
// makes a screen well-defined: it has the shell run a marker command and waits until the marker's result and the next prompt are on the
// screen, which is after everything the shell and ConPTY had written for earlier resizes.
import { join } from 'node:path';import { linesOf, screenOf } from './phone-screen.mjs';

export const TAB = 'term_ph2a';
const CLAMP = 'term_ph2b';
/** A tab of the `cmd` profile (Command Prompt), which a phone names in `termEnsure` as the desktop's own picker does (Node: remote-methods.ts
 *  termEnsure -> desktop-operations.ts termEnsure -> shell-profiles.ts resolveShellProfileSpawn, the detected `cmd` profile). cmd has no
 *  line editor redrawing what is typed, so its output is the same bytes run after run: compared byte for byte. */
export const CMD = 'term_ph2c';
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
  // The same folder as a path without its drive, spelled with /: Node (a Windows host, its working directory on the root's drive)
  // resolved it onto that drive; the spelling says nothing about the host's platform.
  const rooted = (path) => path.slice(2).replace(/\\/g, '/');
  const nowhere = rooted(join(root, 'nowhere'));
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
      // Each class of path argument: not absolute (drive-relative), rooted without a drive (on the working directory's), drive-absolute with
      // a trailing separator, and the device namespaces. A folder that does not exist fails with the text of s.watch, which has the
      // resolved path in it.
      { op: 'call', name: 'folderWatch', params: ['C:nowhere'] },
      { op: 'call', name: 'folderWatch', params: ['C:'] },
      { op: 'call', name: 'folderWatch', params: [nowhere + '/'] },
      { op: 'call', name: 'folderWatch', params: [nowhere.replace(/\//g, '\\') + '\\x\\..'] },
      { op: 'call', name: 'folderWatch', params: [join(root, 'nowhere') + '\\'] },
      { op: 'call', name: 'folderWatch', params: ['\\\\?\\' + join(root, 'nowhere')] },
      { op: 'call', name: 'folderWatch', params: ['\\\\.\\' + join(root, 'nowhere')] },
      { op: 'call', name: 'folderUnwatch', params: [nowhere] },
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
      // The killed shell's last output and the exit line reach the phone after the dispose; the script waits for the line (the exit code is the
      // shell's own and is not compared as text: the screen wait takes the line's start).
      { op: 'until', kind: 'exitLine', tab: CLAMP },
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
      // Node resolved a path and folded its case in the registry key: `<dir>\sub\..`, `<DIR>` and `<dir>` are one watch, the change is
      // reported under the resolved path the first caller gave, and each unwatch (by any of the spellings) takes one count off it.
      { op: 'call', name: 'folderWatch', params: [`${watched}\\sub\\..`, true] },
      { op: 'call', name: 'folderWatch', params: [watched.toUpperCase(), true] },
      { op: 'call', name: 'folderWatch', params: [rooted(watched).replace(/watched/, 'Watched') + '/', true] },
      { op: 'touch', file: join(watched, 'c.txt') },
      { op: 'until', kind: 'folder', event: watched, count: 3 },
      { op: 'call', name: 'folderUnwatch', params: [watched, true] },
      { op: 'touch', file: join(watched, 'd.txt') },
      { op: 'until', kind: 'folder', event: watched, count: 4 },
      { op: 'call', name: 'folderUnwatch', params: [watched.toLowerCase(), true] },
      { op: 'call', name: 'folderUnwatch', params: [rooted(watched).replace(/\//g, '\\').toUpperCase(), true] },
      // The tab goes: the activity ends, and nothing is left to attach.
      { op: 'snap', name: 'end', tabs: [TAB] },
      { op: 'call', name: 'termDispose', params: [TAB] },
      { op: 'until', kind: 'activity', event: { id: TAB, state: null } },
      { op: 'until', kind: 'exitLine', tab: TAB },
      { op: 'call', name: 'termDispose', params: [TAB] },
      { op: 'call', name: 'termAttach', params: [TAB] },
      { op: 'call', name: 'termActivity', params: [] },
      // The Command Prompt, by its profile id: its banner and prompt, a command run (cmd reports only its prompt, so a submitted line is
      // what starts it), the command's line and the next prompt after a blank line, then its end.
      { op: 'call', name: 'termEnsure', params: [CMD, cwd, 'cmd'] },
      { op: 'until', kind: 'activity', event: { id: CMD, state: 'idle' } },
      { op: 'fire', name: 'termWrite', params: [CMD, `echo ${MARK}\r`] },
      { op: 'until', kind: 'activity', event: { id: CMD, state: 'finished' } },
      { op: 'until', kind: 'screen', tab: CMD, after: MARK, prompt: `${cwd}>`, gap: 1 },
      { op: 'snap', name: 'cmd result', tabs: [CMD] },
      { op: 'call', name: 'termDispose', params: [CMD] },
      { op: 'until', kind: 'activity', event: { id: CMD, state: null } },
      { op: 'until', kind: 'exitLine', tab: CMD },
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
  // An id that no tab ever has.
  const NONE = 'term_ph2_none';
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
  // A claim's resize is a fire: the re-render ConPTY sends for it has no answer to order it against, so it is on the screen (settled)
  // before the next step. Where it would land among later calls is the calls' latency (Node's recorder calls in-process, a phone and the
  // replay cross a socket), not a property of either product.
  const settleClaims = () => [...resized].flatMap((tab) => barrier(tab));
  return {
    cwd,
    ops: [
      { op: 'lane', lane: 'terminal', on: true },
      // One tab at a time, each one's first prompt (it is idle) before the next: the five shells come up in an order of their own when
      // started together, and the activity events are compared in the order they came. Every shell is up before the leases are timed.
      ...tabs.flatMap((tab) => [
        { op: 'call', name: 'termEnsure', params: [tab, cwd, null] },
        { op: 'until', kind: 'activity', event: { id: tab, state: 'idle' } },
        // The prompt is drawn before the next step: where it lands among the next calls, and whether a claim's resize comes before it,
        // would otherwise be a race with the calls' own latency (Node's are in-process, the core's cross a socket).
        { op: 'until', kind: 'text', tab, text: `${prompt} ` },
      ]),
      // From here the leases are timed.
      { op: 'clock' },
      // Claims belong to the id, not to a running tab: Node announces them with no PTY there, and disposing an id that has no tab
      // forgets nothing (terminal-manager.ts:536 returns first). Released before the first lease is timed.
      { op: 'fire', name: 'termResize', params: [NONE, 90, 28, true] },
      owner(NONE, 90, 28, true),
      { op: 'call', name: 'termDispose', params: [NONE] },
      { op: 'fire', name: 'termResize', params: [NONE, 91, 29, true], from: 'other' },
      owner(NONE, 91, 29, false),
      { op: 'fire', name: 'termResize', params: [NONE, 0, 0, true], from: 'other' },
      owner(NONE, 90, 28, true, 2),
      { op: 'fire', name: 'termResize', params: [NONE, 0, 0, true] },
      owner(NONE, 0, 0, false),
      claim(L1, 100, 30),
      owner(L1, 100, 30, true),
      ...settleClaims(),
      { op: 'advance', ms: 1000 },
      claim(L2, 101, 31),
      owner(L2, 101, 31, true),
      ...settleClaims(),
      { op: 'advance', ms: 1000 },
      claim(L4, 102, 32, 'other'),
      owner(L4, 102, 32, false),
      ...settleClaims(),
      { op: 'advance', ms: 1000 },
      claim(L5, 104, 34),
      owner(L5, 104, 34, true),
      ...settleClaims(),
      claim(L5, 0, 0),
      owner(L5, 0, 0, false),
      ...settleClaims(),
      { op: 'advance', ms: 1000 },
      claim(L6, 103, 33),
      owner(L6, 103, 33, true),
      ...settleClaims(),
      { op: 'advance', ms: 1000 },
      claim(L6, 83, 24, 'other'),
      owner(L6, 83, 24, false),
      ...settleClaims(),
      { op: 'advance', ms: 5000 },
      claim(L2, 101, 31),
      claim(L6, 0, 0, 'other'),
      owner(L6, 103, 33, true, 2),
      ...settleClaims(),
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
      // A claim and then the dispose of its tab: Node runs the claim wholly (its owner pushed) before the dispose (the tab's end, the
      // answer), never between them (terminal-manager.ts:455, :536). The dispose of an id with no tab leaving a later claim standing is
      // the `term_ph2_none` case above.
      claim(L5, 99, 29),
      owner(L5, 99, 29, true),
      // The re-render ConPTY sends for the new size is on the screen before the tabs are disposed: where it lands among the disposals
      // would otherwise be a race with the calls' own latency (Node's calls are in-process, the core's cross a socket).
      ...barrier(L5),
      // One disposal at a time, each tab's last output and exit line before the next dispose: a tab's closing output has no answer to
      // order it against the next tab's dispose (the call's latency again); against its own dispose answer it is ordered (the hold).
      ...tabs.flatMap((tab) => [
        { op: 'call', name: 'termDispose', params: [tab] },
        { op: 'until', kind: 'exitLine', tab },
      ]),
      { op: 'lane', lane: 'terminal', on: false },
    ],
  };
}

/**
 * The sequences whose order an answer defines, run with no wait in between: an ensure's answer before the new shell's first output, and a
 * dispose's answer before the killed shell's last output and its exit line (Node answered in-process before its PTY reported either; the
 * core holds the tab's feed until the answer is queued). Output that no answered call causes is waited out before the next call (see
 * `settle` and the comparison's header): its place among later calls is the calls' latency, which the in-process recorder lacks.
 */
export function immediateScript(root) {
  const cwd = join(root, 'cwd');
  const prompt = `PS ${cwd}> `;
  const [I1, I2] = ['term_ph2_i1', 'term_ph2_i2'];
  return {
    cwd,
    ops: [
      { op: 'lane', lane: 'terminal', on: true },
      { op: 'call', name: 'termEnsure', params: [I1, cwd, null] },
      { op: 'until', kind: 'activity', event: { id: I1, state: 'idle' } },
      { op: 'until', kind: 'text', tab: I1, text: prompt },
      { op: 'call', name: 'termEnsure', params: [I2, cwd, null] },
      { op: 'until', kind: 'activity', event: { id: I2, state: 'idle' } },
      { op: 'until', kind: 'text', tab: I2, text: prompt },
      { op: 'call', name: 'termDispose', params: [I1] },
      { op: 'until', kind: 'exitLine', tab: I1 },
      { op: 'call', name: 'termDispose', params: [I2] },
      { op: 'until', kind: 'exitLine', tab: I2 },
      { op: 'lane', lane: 'terminal', on: false },
    ],
  };
}

/** A call's entry in the trace: its answer as sent (a replay is its string) or its error text. */
export const callEntry = (name, params, { value, error }) => (error !== undefined ? { call: name, params, error } : { call: name, params, value });

/** The marker's own line is on the screen with the prompt right after it (after `gap` blank lines: cmd leaves one after a command's
 *  output): what the shell wrote for the command is complete. */
const onScreen = (text, { after, prompt, gap = 0 }) => {
  const lines = linesOf(text).map((line) => line.trimEnd());
  const at = lines.lastIndexOf(after);
  return at >= 0 && lines.slice(at + 1, at + 1 + gap).every((line) => line === '') && lines[at + 1 + gap] === prompt;
};

/**
 * Plays the ops against a driver and returns the trace.
 * A reply is recorded as sent; a `snap` records the screen each named tab's streamed output draws.
 * driver: call(name, params) -> value (throws the error), fire(name, params), lane(lane, on), touch(file), run(request, redeliver),
 *         waitFor(test, what) -> Promise (resolves once `test(events)` holds; rejects, naming what, if it never does), events() ->
 *         { activity: [], sizeOwner: [], folder: [], run: [], output: { [tabId]: string } }.
 */
export async function play(script, driver) {
  // The one ordered trace of the phone connection: each call's answer, each lane's push (`record`, called by the driver as the page's
  // listener gets it) and each fire, lane switch and snapshot, in the order the page saw them.
  const { order } = driver.events();
  const steps = order;
  const matches = (list, wanted) => list.filter((event) => JSON.stringify(event) === JSON.stringify(wanted)).length;
  for (const op of script.ops) {
    if (op.op === 'call') {
      // A driver that records replies (Node's) has them in the order they were sent; the replay's has them as the call returns.
      try {
        const value = (await driver.call(op.name, op.params)) ?? null;
        if (!driver.recordsReplies) steps.push(callEntry(op.name, op.params, { value }));
      } catch (error) {
        if (!driver.recordsReplies) steps.push(callEntry(op.name, op.params, { error: error instanceof Error ? error.message : String(error) }));
      }
    } else if (op.op === 'fire') {
      // The fire is the page's act, so it precedes the pushes it causes (Node's handler publishes inside the call).
      steps.push({ fire: op.name });
      driver.fire(op.name, op.params, op.from);
    } else if (op.op === 'clock') {
      driver.clock();
    } else if (op.op === 'advance') {
      // The lease moments are entries of the trace: where a lease lapses is compared, not assumed from the script both sides share.
      steps.push({ advance: op.ms });
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
    } else if (op.op === 'until') {
      if (op.kind === 'exitLine') {
        await driver.waitFor((events) => /\[process exited with code -?\d+\]/.test(events.output[op.tab] ?? ''), `the exit line of ${op.tab}`);
        continue;
      }
      if (op.kind === 'text') {
        await driver.waitFor((events) => (events.output[op.tab] ?? '').includes(op.text), `${JSON.stringify(op.text)} in the output of ${op.tab}`);
        continue;
      }
      const what =
        op.kind === 'screen' ? `the screen of ${op.tab} to show ${JSON.stringify(op)}` : `${op.count ?? 1} x ${op.kind} event ${JSON.stringify(op.event)}`;
      // A screen wait is a checkpoint of the trace: the screen the output drew at the moment the wait held.
      let reached = null;
      await driver.waitFor((events) => {
        if (op.kind !== 'screen') return matches(events[op.kind], op.event) >= (op.count ?? 1);
        const output = events.output[op.tab] ?? '';
        if (!onScreen(output, op)) return false;
        reached = screenOf(output);
        return true;
      }, what);
      if (op.kind === 'screen') steps.push({ screen: op.tab, after: op.after, view: reached });
    }
  }
  return { order: steps };
}

/** A push as the page's listener got it: kept by kind (what `until` reads) and in the connection's one order. */
export function record(events, kind, event) {
  events[kind].push(event);
  events.order.push({ push: kind, event });
}
