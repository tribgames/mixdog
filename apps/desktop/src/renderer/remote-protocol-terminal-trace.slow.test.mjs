// The comparison accepts what Node's runs vary and nothing more: each mutation below is a trace no run recorded, and fails. The rule
// compares a command's output by the screen it ends in (decided 2026-11-11), so a few traces no run recorded pass: each is a test of its
// own below, named as passing, with the reason. In the slow lane: rendering Node's 50 runs to screens takes over the fast lane's 120 s.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { checkedRuns, comparedList, compareTraces, loadRuns, nodeView, stateAt, windowsOf } from './remote-protocol-terminal-compare.mjs';

const runs = loadRuns();
const copy = (run = runs[0]) => JSON.parse(JSON.stringify(run));
const isData = (entry) => entry.push === 'termData';
const PARTS = ['order', 'claims.order', 'immediate.order'];
const listOf = (trace, part) => part.split('.').reduce((value, key) => value[key], trace);

/** Per entry of a compared list: the number of entries besides output before it (an output entry's position among them). */
const positionsOf = (kept) => {
  let k = 0;
  return kept.map((entry) => (isData(entry) ? k : k++));
};

/** A copy of run 0 and, in one of its lists, the first output frame that is its tab's last before a position where its screen is compared
 *  (`end`: the end of a command), where every run has the same screen of that tab, and `test` holds: the frame (an object of the copy's
 *  list), its index in the list (`at`) and in the compared list (`ki`), the window it ends (`from`, `end`, the tab's own `changes`) and
 *  Node's screen there. */
async function screenPoint(test, what) {
  for (const part of PARTS) {
    const node = await nodeView(runs, part);
    const { kinds } = node.analyses[0];
    const trace = copy();
    const list = listOf(trace, part);
    const kept = comparedList(list, part);
    const positions = positionsOf(kept);
    for (const [ki, entry] of kept.entries()) {
      if (!isData(entry)) continue;
      const { id } = entry.event;
      const window = windowsOf(kinds, id).find(({ from, end }) => from < positions[ki] && positions[ki] <= end);
      if (kept.some((other, later) => later > ki && isData(other) && other.event.id === id && positions[later] <= window.end)) continue;
      const screens = node.analyses.map((run) => stateAt(run, window.end, id));
      if (!screens.every((screen) => screen !== null && isDeepStrictEqual(screen, screens[0]))) continue;
      const point = { part, node, kinds, trace, list, kept, positions, entry, at: list.indexOf(entry), ki, ...window, screen: screens[0] };
      if (test(point)) return point;
    }
  }
  assert.fail(`the recording has no ${what}`);
}
const printable = (entry) => /[A-Za-z]{3}/.test(entry.event.data.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, ''));
/** Where the screen's cursor is (1-based row and column, for CUP) in Node's state `screen`. */
const cursorOf = (screen) => [screen['normal cursor'][1] - screen['normal viewport'][1] + 1, screen['normal cursor'][0] + 1];
/** A state the writes below leave alone apart from what they mean to change: the normal buffer shown, default attributes in force, the
 *  cursor inside the screen and not on its last row. */
const plain = ({ screen }) => {
  const [row, column] = cursorOf(screen);
  return screen['active buffer'] === 'normal' && screen['current attributes'] === '0.0' && row < screen.size[1] && column <= screen.size[0];
};
/** Writes `text` at the 1-based `row` and `column` and puts the cursor back where Node's state has it, attributes reset. */
const writeAt = (screen, row, column, text) => `\x1b[${row};${column}H${text}\x1b[m\x1b[${cursorOf(screen).join(';')}H`;

test("each of Node's runs passes", async () => {
  for (const run of runs) await compareTraces(copy(run), runs);
});

test('frames re-cut inside an escape sequence pass: the extra cut makes no state of its own', async () => {
  const { trace, list, at, entry } = await screenPoint(({ entry }) => entry.event.data.includes('\x1b['), 'output frame with an escape sequence');
  const { id, data } = entry.event;
  const cut = data.indexOf('\x1b[') + 2;
  list.splice(at, 1, { push: 'termData', event: { id, data: data.slice(0, cut) } }, { push: 'termData', event: { id, data: data.slice(cut) } });
  await compareTraces(trace, runs);
});

test('a wrong character on a screen every run agrees on is a different trace', async () => {
  const { trace, entry, screen } = await screenPoint(plain, 'agreed plain screen');
  entry.event.data += writeAt(screen, 1, 1, 'Z');
  await assert.rejects(compareTraces(trace, runs), /normal line \d+: got/);
});

test('the same character in another colour is a different trace', async () => {
  const { trace, entry, screen } = await screenPoint(({ screen, ...point }) => plain({ screen, ...point }) && /^[A-Za-z]/.test(screen['normal line 0']), 'agreed plain screen starting with a letter');
  entry.event.data += writeAt(screen, 1, 1, `\x1b[31m${screen['normal line 0'][0]}`);
  await assert.rejects(compareTraces(trace, runs), /normal line 0: got "«1\.\d+\.0»/);
});

test('the same character bold and inverse is a different trace', async () => {
  const { trace, entry, screen } = await screenPoint(({ screen, ...point }) => plain({ screen, ...point }) && /^[A-Za-z]/.test(screen['normal line 0']), 'agreed plain screen starting with a letter');
  entry.event.data += writeAt(screen, 1, 1, `\x1b[1;7m${screen['normal line 0'][0]}`);
  await assert.rejects(compareTraces(trace, runs), /normal line 0: got "«1\.\d+\.\d+»/);
});

test('a coloured blank after the end of a line is a different trace', async () => {
  const { trace, entry, screen } = await screenPoint(plain, 'agreed plain screen');
  entry.event.data += writeAt(screen, 1, screen.size[0], '\x1b[41m ');
  await assert.rejects(compareTraces(trace, runs), /normal line \d+: got/);
});

test('a wrong cursor position on a screen every run agrees on is a different trace', async () => {
  const { trace, entry, screen } = await screenPoint(plain, 'agreed plain screen');
  entry.event.data += screen['normal cursor'][0] > 0 ? '\x1b[D' : '\x1b[C';
  await assert.rejects(compareTraces(trace, runs), /normal cursor: got/);
});

test('a hidden cursor where every run shows it is a different trace', async () => {
  const { trace, entry } = await screenPoint(({ screen }) => !screen['cursor hidden'], 'agreed screen with the cursor shown');
  entry.event.data += '\x1b[?25l';
  await assert.rejects(compareTraces(trace, runs), /cursor hidden: got true, Node false/);
});

test('a mode the phone sends input by is a different trace: bracketed paste, application cursor keys', async () => {
  for (const [mode, set] of [['bracketedPasteMode', '\x1b[?2004h'], ['applicationCursorKeys', '\x1b[?1h']]) {
    const { trace, entry } = await screenPoint(({ screen }) => screen[`mode ${mode}`] === false, `agreed screen without ${mode}`);
    entry.event.data += set;
    await assert.rejects(compareTraces(trace, runs), new RegExp(`mode ${mode}: got true, Node false`));
  }
});

test('another window title is a different trace', async () => {
  const { trace, entry } = await screenPoint(() => true, 'agreed screen');
  entry.event.data += '\x1b]0;not the shell\x07';
  await assert.rejects(compareTraces(trace, runs), /title: got "not the shell"/);
});

test('a wrapped line where Node has two lines is a different trace', async () => {
  // Eighty-one characters drawn on a new line at the end of a stretch: Node's runs, each given the frame, break them into two lines; the
  // trace lets the line wrap. The cells and the cursor end the same; only the second line's wrapped flag differs.
  const { part, entry, end } = await screenPoint(({ screen }) => screen.size[0] === 80 && screen['active buffer'] === 'normal', 'agreed 80-column screen');
  const { id } = entry.event;
  const text = 'x'.repeat(80);
  const withFrame = (run, data) => {
    const trace = copy(run);
    const list = listOf(trace, part);
    const kept = comparedList(list, part);
    const next = kept.filter((other) => !isData(other))[end];
    list.splice(next ? list.indexOf(next) : list.length, 0, { push: 'termData', event: { id, data } });
    return trace;
  };
  const broken = runs.map((run) => withFrame(run, `\r\n${text}\r\nx`));
  await compareTraces(copy(broken[0]), broken);
  await assert.rejects(compareTraces(withFrame(runs[0], `\r\n${text}x`), broken), /normal line \d+: got "⏎x␀/);
});

test('a frame missing whose content nothing draws again is a different trace (output lost)', async () => {
  const { trace, list, at } = await screenPoint(({ entry }) => printable(entry), 'agreed drawing frame');
  list.splice(at, 1);
  await assert.rejects(compareTraces(trace, runs), /screen (before entry \d+|at the end)[\s\S]*normal line \d+: got/);
});

test('a frame sent twice is a different trace (output duplicated)', async () => {
  const { trace, list, at, entry } = await screenPoint(({ entry }) => printable(entry) && !entry.event.data.includes('\x1b'), 'agreed drawing frame without escape sequences');
  list.splice(at, 0, { ...entry, event: { ...entry.event } });
  await assert.rejects(compareTraces(trace, runs), /screen (before entry \d+|at the end)[\s\S]*normal (line \d+|cursor): got/);
});

test("a tab's frame sent as another tab's is a different trace (output of another tab)", async () => {
  const { trace, kept, entry } = await screenPoint(
    ({ kept, entry }) => printable(entry) && kept.some((other) => isData(other) && other.event.id !== entry.event.id),
    'agreed drawing frame in a list with another tab',
  );
  entry.event.id = kept.find((other) => isData(other) && other.event.id !== entry.event.id).event.id;
  await assert.rejects(compareTraces(trace, runs), /screen (before entry \d+|at the end)/);
});

test("output after the tab's exit line is a different trace (output after the tab's end)", async () => {
  const trace = copy();
  const at = trace.claims.order.findIndex((entry) => isData(entry) && entry.event.id === 'term_ph2_l1' && /process exited/.test(entry.event.data));
  trace.claims.order.splice(at + 1, 0, { push: 'termData', event: { id: 'term_ph2_l1', data: 'x' } });
  await assert.rejects(compareTraces(trace, runs), /term_ph2_l1's (screen|output does not end with its exit line)/);
});

test('the screen at the end of the recording differing by one cell, or by one attribute of one cell, is a different trace', async () => {
  // A frame of a tab whose final screen every run agrees on, sent after the recording's last message: only that screen changes.
  const node = await nodeView(runs, 'claims.order');
  const end = node.analyses[0].kinds.length;
  const [id, screen] = [...node.analyses[0].before[end].keys()]
    .map((tab) => [tab, stateAt(node.analyses[0], end, tab)])
    .find(([tab, state]) => node.analyses.every((run) => isDeepStrictEqual(stateAt(run, end, tab), state)) && plain({ screen: state }) && /^[A-Za-z]/.test(state[`normal line ${state['normal viewport'][1]}`]));
  const top = screen[`normal line ${screen['normal viewport'][1]}`][0];
  for (const [data, unit] of [[top === 'Z' ? 'Y' : 'Z', /normal line \d+: got "[A-Z]/], [`\x1b[4m${top}`, /normal line \d+: got "«1\.\d+\.[\d.]+»/]]) {
    const trace = copy();
    trace.claims.order.push({ push: 'termData', event: { id, data: writeAt(screen, 1, 1, data) } });
    await assert.rejects(compareTraces(trace, runs), new RegExp(`${id}'s screen at the end\\n  ${unit.source}`));
  }
});

test('garbage drawn and repaired within one command passes: only the screen the command ends in is compared (decided 2026-11-11)', async () => {
  const { trace, list, at, entry, screen } = await screenPoint(
    (point) => plain(point) && point.screen[`normal line ${point.screen['normal viewport'][1] + point.screen.size[1] - 1}`] === '␀'.repeat(point.screen.size[0]),
    'agreed plain screen whose last row is blank',
  );
  const { id } = entry.event;
  const last = screen.size[1];
  list.splice(at + 1, 0, { push: 'termData', event: { id, data: writeAt(screen, last, 1, 'garbage') } }, { push: 'termData', event: { id, data: writeAt(screen, last, 1, '\x1b[2K') } });
  await compareTraces(trace, runs);
});

test('a unit Node\'s runs differ on is a different trace when it is none of their values', async () => {
  for (const part of PARTS) {
    const node = await nodeView(runs, part);
    const { kinds } = node.analyses[0];
    const trace = copy();
    const list = listOf(trace, part);
    const kept = comparedList(list, part);
    const positions = positionsOf(kept);
    for (const [at, entry] of kept.entries()) {
      if (!isData(entry)) continue;
      const { id } = entry.event;
      const { end } = windowsOf(kinds, id).find(({ from, end: last }) => from < positions[at] && positions[at] <= last);
      if (kept.some((other, later) => later > at && isData(other) && other.event.id === id && positions[later] <= end)) continue;
      const cursors = node.analyses.map((run) => stateAt(run, end, id)?.['normal cursor']);
      if (cursors.some((cursor) => cursor === undefined) || cursors.every((cursor) => isDeepStrictEqual(cursor, cursors[0]))) continue;
      const screen = stateAt(node.analyses[0], end, id);
      // The bottom right corner, which no run's cursor is at.
      if (cursors.some((cursor) => isDeepStrictEqual(cursor, [screen.size[0] - 1, screen['normal viewport'][1] + screen.size[1] - 1]))) continue;
      entry.event.data += `\x1b[${screen.size[1]};${screen.size[0]}H`;
      await assert.rejects(compareTraces(trace, runs), /no Node run[\s\S]*normal cursor: got \[[\d,]+\]/);
      return;
    }
  }
  assert.fail('the recording has no point where the runs differ on the cursor');
});

test('an answer whose replay draws another screen is a different trace', async () => {
  const trace = copy();
  const node = await nodeView(runs, 'order');
  const replayed = (units) => Object.keys(units).some((unit) => unit.startsWith('value.replay: normal line') && !/^␀*$/.test(units[unit]));
  const k = node.analyses[0].entries.findIndex((units, i) => replayed(units) && node.analyses.every((run) => isDeepStrictEqual(run.entries[i], units)));
  assert.ok(k >= 0, 'the recording has an answer with a replay every run agrees on');
  const answer = comparedList(trace.order, 'order').filter((entry) => !isData(entry))[k];
  answer.value.replay += 'Z';
  await assert.rejects(compareTraces(trace, runs), /value\.replay: normal line \d+: got/);
});

test('an activity end moved from before the dispose answer to after it is a different trace', async () => {
  const trace = copy();
  const at = trace.order.findIndex((entry) => entry.push === 'activity' && entry.event.state === null);
  const answer = trace.order.findIndex((entry, i) => i > at && !isData(entry));
  assert.equal(trace.order[answer].call, 'termDispose', 'Node publishes the end first and answers the dispose after it');
  [trace.order[at], trace.order[answer]] = [trace.order[answer], trace.order[at]];
  await assert.rejects(compareTraces(trace, runs), /entry/);
});

test("a tab's frame moved past a message, swapped with another tab's, is a different trace", async () => {
  const point = await screenPoint(
    ({ kept, ki, positions, entry }) => printable(entry) && kept.some((other, j) => j > ki && isData(other) && other.event.id !== entry.event.id && positions[j] !== positions[ki]),
    'drawing frame with a later frame of another tab past a message',
  );
  const { kept, positions, list, trace, ki } = point;
  const other = kept.find((entry, j) => j > ki && isData(entry) && entry.event.id !== point.entry.event.id && positions[j] !== positions[ki]);
  const [i, j] = [point.at, list.indexOf(other)];
  [list[i], list[j]] = [list[j], list[i]];
  await assert.rejects(compareTraces(trace, runs), /screen/);
});

test("two tabs' frames swapped with no message between them pass: each tab's screen is compared, not how the tabs' output interleaves (decided 2026-11-11)", async () => {
  const node = recorded([STEP, D('a', 'a'), D('b', 'b'), STEP], [STEP, D('a', 'a'), D('b', 'b'), STEP]);
  await compareTraces(traceOf([STEP, D('b', 'b'), D('a', 'a'), STEP]), node);
});

test("a tab's output and its own activity change pass in either order where Node's runs show both, named", async () => {
  const running = { push: 'activity', event: { id: 't', state: 'running' } };
  const node = recorded([STEP, D('A'), running, STEP], [STEP, running, D('A'), STEP]);
  for (const order of [[STEP, D('A'), running, STEP], [STEP, running, D('A'), STEP]]) {
    const { exemptions } = await compareTraces(traceOf(order), node);
    assert.ok(exemptions.some((line) => line.includes('t\'s output before entry 2 against its "running" change (entry 1)') && line.includes('in 1 runs')), 'the place is named with its runs');
  }
});

test("a change moved before its own output where every Node run has the output first is a different trace", async () => {
  const running = { push: 'activity', event: { id: 't', state: 'running' } };
  const node = recorded([STEP, D('A'), running, STEP], [STEP, D('A'), running, STEP]);
  await assert.rejects(compareTraces(traceOf([STEP, running, D('A'), STEP]), node), /against its "running" change \(entry 1\): no output before, some after, every Node run: some output before, none after/);
});

test("the reviewer's counterexample: a tab's output moved after its own completion (output, running, finished against running, finished, output) is a different trace", async () => {
  const [running, finished] = ['running', 'finished'].map((state) => ({ push: 'activity', event: { id: 't', state } }));
  const node = recorded([STEP, D('A'), running, finished, STEP], [STEP, running, D('A'), finished, STEP]);
  await assert.rejects(compareTraces(traceOf([STEP, running, finished, D('A'), STEP]), node), /against its "finished" change \(entry 2\): no output before, some after, every Node run: some output before, none after/);
});

test("the reviewer's counterexample: a tab's frame moved before its own activity change where every run has none of the command's output before it is a different trace", async () => {
  for (const part of PARTS) {
    const node = await nodeView(runs, part);
    const { kinds } = node.analyses[0];
    const trace = copy();
    const list = listOf(trace, part);
    const kept = comparedList(list, part);
    const positions = positionsOf(kept);
    for (const [at, entry] of kept.entries()) {
      if (entry.push !== 'activity') continue;
      const { id } = entry.event;
      const k = positions[at];
      const { from, end } = windowsOf(kinds, id).find((window) => window.changes.includes(k));
      if (!node.analyses.every((run) => stateAt(run, k, id) === (from < 0 ? null : stateAt(run, from, id)))) continue;
      // The tab's first frame after the change: moved before it, the tab's own output keeps its order.
      const next = kept.findIndex((other, j) => j > at && isData(other) && other.event.id === id);
      if (next < 0 || positions[next] > end || !printable(kept[next])) continue;
      const frame = kept[next];
      list.splice(list.indexOf(frame), 1);
      list.splice(list.indexOf(entry), 0, frame);
      await assert.rejects(compareTraces(trace, runs), /change \(entry \d+\): some output before, [a-z]+ after(, every Node run: no output before|, which no Node run has)/);
      return;
    }
  }
  assert.fail('the recording has no activity change that every run sends before any of its command output');
});

test("something else between an activity change and its own output passes: the order is compared, not adjacency (decided 2026-11-11)", async () => {
  const running = { push: 'activity', event: { id: 't', state: 'running' } };
  const node = recorded([STEP, D('x', 'u'), D('A'), running, STEP], [STEP, D('x', 'u'), running, D('A'), STEP]);
  await compareTraces(traceOf([STEP, D('x', 'u'), running, D('', 'u'), D('A'), STEP]), node);
  await compareTraces(traceOf([STEP, D('x', 'u'), D('A'), D(''), running, STEP]), node);
});

test('frames moved across a lane switch are a different trace', async () => {
  const { trace, list, at } = await screenPoint(({ kept, ki, entry }) => printable(entry) && kept[ki + 1]?.lane !== undefined, 'drawing frame right before a lane switch');
  const [frame] = list.splice(at, 1);
  list.splice(at + 1, 0, frame);
  await assert.rejects(compareTraces(trace, runs), /screen|states within/);
});

test('a running/null pair after the exit line is a different trace', async () => {
  const trace = copy();
  const at = trace.claims.order.findIndex((entry) => isData(entry) && entry.event.id === 'term_ph2_l1' && /process exited/.test(entry.event.data));
  trace.claims.order.splice(at + 1, 0, { push: 'activity', event: { id: 'term_ph2_l1', state: 'running' } }, { push: 'activity', event: { id: 'term_ph2_l1', state: null } });
  await assert.rejects(compareTraces(trace, runs));
});

test('a running/null pair on a tab the mechanism does not cover (cmd) is a different trace', async () => {
  const trace = copy();
  const at = trace.order.findIndex((entry) => entry.call === 'termDispose' && entry.params[0] === 'term_ph2c');
  trace.order.splice(at + 1, 0, { push: 'activity', event: { id: 'term_ph2c', state: 'running' } }, { push: 'activity', event: { id: 'term_ph2c', state: null } });
  await assert.rejects(compareTraces(trace, runs));
});

test('an extra field on an output entry is a different trace', async () => {
  const { trace, entry } = await screenPoint(() => true, 'output frame');
  entry.lane = 'terminal';
  await assert.rejects(compareTraces(trace, runs), /other fields/);
});

test('a field beside the lists is a different trace', async () => {
  const trace = copy();
  trace.extra = 1;
  await assert.rejects(compareTraces(trace, runs), /fields/);
});

test('a missing exit line is a different trace', async () => {
  const trace = copy();
  const at = trace.claims.order.findIndex((entry) => isData(entry) && /process exited/.test(entry.event.data));
  const { id } = trace.claims.order[at].event;
  trace.claims.order.splice(at, 1);
  await assert.rejects(compareTraces(trace, runs), new RegExp(id));
});

test('a screen checkpoint differs when its text differs', async () => {
  const trace = copy();
  const checkpoint = trace.claims.order.find((entry) => entry.screen);
  checkpoint.view.rows[0].text += 'x';
  await assert.rejects(compareTraces(trace, runs), /entry/);
});

test('a duplicated size-owner push is a different trace', async () => {
  const trace = copy();
  const at = trace.claims.order.findIndex((entry) => entry.push === 'sizeOwner');
  trace.claims.order.splice(at, 0, trace.claims.order[at]);
  await assert.rejects(compareTraces(trace, runs), /claims\.order/);
});

// Witnesses on small recordings of their own: each is Node's runs as given and a trace no run shows, which must fail.
const D = (data, id = 't') => ({ push: 'termData', event: { id, data } });
const STEP = { fire: 'step' };
const recorded = (...orders) => orders.map((order) => ({ order, claims: { order: [] }, immediate: { order: [] } }));
const traceOf = (order) => recorded(order)[0];

test('an empty cell and a cell showing ␀ are different traces', async () => {
  const node = recorded([D('\x1b[C'), STEP], [D('\x1b[C'), STEP]);
  await compareTraces(traceOf([D('\x1b[C'), STEP]), node);
  await assert.rejects(compareTraces(traceOf([D('␀'), STEP]), node), /normal line 0: got "\\\\␀/);
});

test('input left unfinished in the parser at a place where Node finished it is a different trace', async () => {
  // The trace's last frame of the stretch is only the start of a sequence: the screen is Node's, the parser is not.
  // Nothing follows it in the trace, so no later state shows how it reads the next input: only the parser's own state does.
  const node = recorded([D('x'), STEP], [D('x'), STEP]);
  await assert.rejects(compareTraces(traceOf([D('x'), D('\x1b['), STEP]), node), /screen before entry 0\n  parser pending: got \{/);
});

test("screens on the way no Node run went through, ending in Node's screen, pass: only the screen a command ends in is compared (decided 2026-11-11)", async () => {
  const node = recorded([D('A'), D('\rZ'), STEP], [D('B'), D('\rZ'), STEP]);
  await compareTraces(traceOf([D('EVIL'), D('\r\x1b[2KZ'), STEP]), node);
  await compareTraces(traceOf([D('EVIL\x1b['), D('2K\rZ'), STEP]), node);
});

test("a state or an entry assembled from parts of different runs is a different trace", async () => {
  const screens = recorded([D('A\r\nX'), STEP], [D('B\r\nY'), STEP]);
  await assert.rejects(compareTraces(traceOf([D('A\r\nY'), STEP]), screens), /no Node run/);
  const answer = (value) => ({ call: 'termActivity', params: [], value });
  const entries = recorded([answer({ a: 1, b: 1 })], [answer({ a: 2, b: 2 })]);
  await compareTraces(traceOf([answer({ a: 2, b: 2 })]), entries);
  await assert.rejects(compareTraces(traceOf([answer({ a: 1, b: 2 })]), entries), /order entry 0: no Node run has this whole/);
});

test("an activity change with its command's output on both sides is a different trace where every Node run has all of it on one side", async () => {
  const running = { push: 'activity', event: { id: 't', state: 'running' } };
  const node = recorded([STEP, D('AB'), running, STEP], [STEP, running, D('AB'), STEP]);
  await compareTraces(traceOf([STEP, running, D('A'), D('B'), STEP]), node);
  await assert.rejects(compareTraces(traceOf([STEP, D('A'), running, D('B'), STEP]), node), /some output before, some after, which no Node run has/);
});

test("output that changes nothing on the screen, on the other side of an activity change, passes: the order is the screen's (decided 2026-11-11)", async () => {
  const running = { push: 'activity', event: { id: 't', state: 'running' } };
  const node = recorded([D('A'), running], [running, D('A')]);
  await compareTraces(traceOf([D('A'), running, D('\x1b[m')]), node);
});

test("a disposal pair is taken out only where Node's runs vary on it", async () => {
  const tab = 'term_ph2a';
  const ensure = { call: 'termEnsure', params: [tab, 'C:\\', null], value: { id: tab, replay: '' } };
  const dispose = { call: 'termDispose', params: [tab], value: null };
  const pair = [{ push: 'activity', event: { id: tab, state: 'running' } }, { push: 'activity', event: { id: tab, state: null } }];
  const exit = D('\r\n[process exited with code 0]\r\n', tab);
  const without = [ensure, D('PS> ', tab), dispose, exit];
  const withPair = [ensure, D('PS> ', tab), dispose, ...pair, exit];
  // Every run without it: a pair is not taken out.
  await assert.rejects(compareTraces(traceOf(withPair), recorded(without, without)), /pair after term_ph2a dispose 1's answer: got entry \d+, its tab's state \d+ and entry \d+, its tab's state \d+, every Node run absent/);
  // Every run with it: it must be there.
  await assert.rejects(compareTraces(traceOf(without), recorded(withPair, withPair)), /pair after term_ph2a dispose 1's answer: got absent, every Node run entry/);
  // Every run with it in one place: it must be there, not after the next entry.
  const placed = [ensure, D('PS> ', tab), dispose, ...pair, STEP, exit];
  const moved = [ensure, D('PS> ', tab), dispose, STEP, ...pair, exit];
  await assert.rejects(compareTraces(traceOf(moved), recorded(placed, placed)), /pair after term_ph2a dispose 1's answer: got entry 3, [^,]+ and entry 3, .*, every Node run entry 2, /);
  // Every run with it before the tab's output: not after that output, though no other entry lies between (its place counts output).
  const beforeOutput = [ensure, D('PS> ', tab), dispose, ...pair, D('bye', tab), STEP, exit];
  const afterOutput = [ensure, D('PS> ', tab), dispose, D('bye', tab), ...pair, STEP, exit];
  await assert.rejects(compareTraces(traceOf(afterOutput), recorded(beforeOutput, beforeOutput)), /pair after term_ph2a dispose 1's answer: got entry 2, its tab's state/);
  // The runs vary: either passes, named.
  const varied = recorded(without, withPair);
  for (const order of [without, withPair]) {
    const { exemptions } = await compareTraces(traceOf(order), varied);
    assert.ok(exemptions.some((line) => line.includes('term_ph2a dispose 1') && line.includes("Node's runs 1 have it")));
  }
});

test("output a command leaves drawn where Node redraws it is a different trace", async () => {
  const node = recorded([D('Z'), D('\rA'), D('\rZ'), STEP], [D('Z'), STEP, D('\rA'), D('\rZ')]);
  await assert.rejects(compareTraces(traceOf([D('Z'), STEP, D('\rA')]), node), /screen at the end\n  normal line 0: got "A/);
});

test("a passing redraw drawn twice, or never, passes when every command ends on Node's screen (decided 2026-11-11)", async () => {
  const node = recorded([D('Z'), D('\rA'), D('\rZ'), STEP], [D('Z'), STEP, D('\rA'), D('\rZ')]);
  await compareTraces(traceOf([D('Z'), D('\rA'), D('\rZ'), STEP, D('\rA'), D('\rZ')]), node);
  await compareTraces(traceOf([D('Z'), STEP]), node);
});

test("places where Node's runs differ, each with one run's alternative but together no run's, pass: each place is held on its own (decided 2026-11-11)", async () => {
  // Two tabs at one place, and a change's order against its output at two places.
  await compareTraces(traceOf([D('A', 'a'), D('Y', 'b'), STEP]), recorded([D('A', 'a'), D('X', 'b'), STEP], [D('B', 'a'), D('Y', 'b'), STEP]));
  const running = (tab) => ({ push: 'activity', event: { id: tab, state: 'running' } });
  const one = [STEP, D('A', 'a'), running('a'), STEP, D('B', 'b'), running('b'), STEP];
  const two = [STEP, running('a'), D('A', 'a'), STEP, running('b'), D('B', 'b'), STEP];
  await compareTraces(traceOf([STEP, D('A', 'a'), running('a'), STEP, running('b'), D('B', 'b'), STEP]), recorded(one, two));
});

test("runs.json is checked against the manifest's runList before any comparison (F3)", () => {
  const listed = runs.map((run, index) => ({ run: index, sha256: createHash('sha256').update(JSON.stringify(run)).digest('hex') }));
  assert.equal(checkedRuns(runs, listed), runs);
  assert.throws(() => checkedRuns(runs.slice(1), listed), /runs\.json has 49 runs; MANIFEST\.json's runList lists 50/);
  const changed = copy();
  changed.order.pop();
  assert.throws(() => checkedRuns([changed, ...runs.slice(1)], listed), /runs\.json run 0 is not the run MANIFEST\.json's runList lists/);
  assert.throws(() => checkedRuns([runs[1], runs[0], ...runs.slice(2)], listed), /runs\.json run 0 is not the run/);
});

test('an absent answer where Node answered null is a different trace', async () => {
  const trace = copy();
  const at = trace.order.findIndex((entry) => entry.call !== undefined && entry.value === null);
  delete trace.order[at].value;
  await assert.rejects(compareTraces(trace, runs), /entry/);
});
