// The comparison accepts what Node's runs vary and nothing more: each mutation below is a trace no run recorded, and fails.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { comparedList, compareTraces, nodeView, stateAt, stretchesOf } from './remote-protocol-terminal-compare.mjs';

const runs = JSON.parse(readFileSync(new URL('../../../mobile/fixtures/phone-terminal/runs.json', import.meta.url), 'utf8'));
const copy = (run = runs[0]) => JSON.parse(JSON.stringify(run));
const isData = (entry) => entry.push === 'termData';
const PARTS = ['order', 'claims.order', 'immediate.order'];
const listOf = (trace, part) => part.split('.').reduce((value, key) => value[key], trace);
const eventsOf = (analysis, stretch, tab) => (analysis.stretches.get(stretch)?.events ?? []).filter((event) => event.tab === tab);

/** A copy of run 0 and, in one of its lists, the first output frame that ends its tab's output in a stretch where every run has the same
 *  state of that tab at the stretch's end and the same states on the way (`agreed`), and `test` holds: the frame (an object of the copy's
 *  list), the copy's list, the frame's stretch and Node's state there. */
async function screenPoint(test, what) {
  for (const part of PARTS) {
    const node = await nodeView(runs, part);
    const trace = copy();
    const list = listOf(trace, part);
    const kept = comparedList(list, part);
    const stretches = stretchesOf(kept, node.paired);
    for (const [at, entry] of kept.entries()) {
      if (!isData(entry)) continue;
      const { id } = entry.event;
      const stretch = stretches[at];
      if (kept.some((other, later) => later > at && isData(other) && other.event.id === id && stretches[later] === stretch)) continue;
      const screens = node.analyses.map((run) => stateAt(run, stretch, id));
      if (!screens.every((screen) => screen !== null && isDeepStrictEqual(screen, screens[0]))) continue;
      const sequences = node.analyses.map((run) => eventsOf(run, stretch, id));
      if (!sequences.every((sequence) => isDeepStrictEqual(sequence, sequences[0]))) continue;
      const point = { part, trace, list, kept, stretches, entry, at: list.indexOf(entry), stretch, screen: screens[0], sequence: sequences[0], paired: node.paired };
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
  const { part, entry, stretch } = await screenPoint(({ screen }) => screen.size[0] === 80 && screen['active buffer'] === 'normal', 'agreed 80-column screen');
  const { id } = entry.event;
  const text = 'x'.repeat(80);
  const withFrame = (run, data) => {
    const trace = copy(run);
    const list = listOf(trace, part);
    const kept = comparedList(list, part);
    const next = kept.filter((other) => !isData(other))[stretch + 1];
    list.splice(next ? list.indexOf(next) : list.length, 0, { push: 'termData', event: { id, data } });
    return trace;
  };
  const broken = runs.map((run) => withFrame(run, `\r\n${text}\r\nx`));
  await compareTraces(copy(broken[0]), broken);
  await assert.rejects(compareTraces(withFrame(runs[0], `\r\n${text}x`), broken), /normal line \d+: got "⏎x␀/);
});

test('a frame missing whose content nothing draws again is a different trace', async () => {
  const { trace, list, at } = await screenPoint(({ entry }) => printable(entry), 'agreed drawing frame');
  list.splice(at, 1);
  await assert.rejects(compareTraces(trace, runs), /states within the stretch[\s\S]*normal line \d+: got/);
});

test('garbage drawn and repaired within a stretch is a different trace where Node goes through the same states', async () => {
  const { trace, list, at, entry, screen, sequence } = await screenPoint(
    (point) => plain(point) && point.sequence.length > 0 && point.screen[`normal line ${point.screen['normal viewport'][1] + point.screen.size[1] - 1}`] === '␀'.repeat(point.screen.size[0]),
    'agreed plain screen whose last row is blank',
  );
  assert.ok(sequence.length > 0);
  const { id } = entry.event;
  const last = screen.size[1];
  list.splice(at + 1, 0, { push: 'termData', event: { id, data: writeAt(screen, last, 1, 'garbage') } }, { push: 'termData', event: { id, data: writeAt(screen, last, 1, '\x1b[2K') } });
  await assert.rejects(compareTraces(trace, runs), /states within the stretch[\s\S]*normal line \d+: got "garbage/);
});

test('a unit Node\'s runs differ on is a different trace when it is none of their values', async () => {
  for (const part of PARTS) {
    const node = await nodeView(runs, part);
    const trace = copy();
    const list = listOf(trace, part);
    const kept = comparedList(list, part);
    const stretches = stretchesOf(kept, node.paired);
    for (const [at, entry] of kept.entries()) {
      if (!isData(entry)) continue;
      const { id } = entry.event;
      if (kept.some((other, later) => later > at && isData(other) && other.event.id === id && stretches[later] === stretches[at])) continue;
      const cursors = node.analyses.map((run) => stateAt(run, stretches[at], id)?.['normal cursor']);
      if (cursors.some((cursor) => cursor === undefined) || cursors.every((cursor) => isDeepStrictEqual(cursor, cursors[0]))) continue;
      const screen = stateAt(node.analyses[0], stretches[at], id);
      // The bottom right corner, which no run's cursor is at.
      if (cursors.some((cursor) => isDeepStrictEqual(cursor, [screen.size[0] - 1, screen['normal viewport'][1] + screen.size[1] - 1]))) continue;
      entry.event.data += `\x1b[${screen.size[1]};${screen.size[0]}H`;
      await assert.rejects(compareTraces(trace, runs), /normal cursor: got \[[\d,]+\], which no Node run has/);
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

test("a tab's frame moved into another stretch, swapped with another tab's, is a different trace", async () => {
  const point = await screenPoint(
    ({ kept, at, stretches, entry }) => printable(entry) && kept.some((other, j) => j > at && isData(other) && other.event.id !== entry.event.id && stretches[j] !== stretches[at]),
    'drawing frame with a later frame of another tab in another stretch',
  );
  const { kept, stretches, list, trace } = point;
  const other = kept.find((entry, j) => j > kept.indexOf(point.entry) && isData(entry) && entry.event.id !== point.entry.event.id && stretches[j] !== point.stretch);
  const [i, j] = [point.at, list.indexOf(other)];
  [list[i], list[j]] = [list[j], list[i]];
  await assert.rejects(compareTraces(trace, runs), /screen|states within|order of the tabs/);
});

test("another tab's frame moved within a stretch where every run has the tabs' order is a different trace", async () => {
  // The recording has no stretch with two tabs' output, so Node's runs are each given one: another tab's frame at the stretch's start,
  // before the tab's own output; the trace has the same frame at the stretch's end.
  const views = Object.fromEntries(await Promise.all(PARTS.map(async (part) => [part, await nodeView(runs, part)])));
  const otherTab = ({ part, entry, stretch }) =>
    views[part].lists[0].filter(isData).map((frame) => frame.event.id).find((id) => id !== entry.event.id && views[part].analyses.every((run) => stateAt(run, stretch, id) !== null));
  const point = await screenPoint((at) => at.sequence.some((event) => 'screen' in event) && otherTab(at) !== undefined, 'agreed stretch with output after another tab drew');
  const { part, stretch } = point;
  const other = otherTab(point);
  const withFrame = (run, atStart) => {
    const trace = copy(run);
    const list = listOf(trace, part);
    const kept = comparedList(list, part);
    const entries = kept.filter((item) => !isData(item));
    const at = atStart ? (stretch < 0 ? 0 : list.indexOf(entries[stretch]) + 1) : entries[stretch + 1] ? list.indexOf(entries[stretch + 1]) : list.length;
    list.splice(at, 0, { push: 'termData', event: { id: other, data: 'y' } });
    return trace;
  };
  const first = runs.map((run) => withFrame(run, true));
  await compareTraces(copy(first[0]), first);
  await assert.rejects(compareTraces(withFrame(runs[0], false), first), /order of the tabs' output in the stretch/);
});

test("a tab's frame and its own activity change next to it in every run pass in either order, named as one place", async () => {
  const point = await screenPoint(({ kept, at, entry }) => {
    const next = kept[at + 1];
    return next?.push === 'activity' && next.event.id === entry.event.id;
  }, 'frame directly before its own activity change in every run');
  const { list, at, trace } = point;
  [list[at], list[at + 1]] = [list[at + 1], list[at]];
  const { sets } = await compareTraces(trace, runs);
  assert.ok(sets.some((place) => place.includes(point.entry.event.id) && place.includes('relay-framing')), 'the place is named with its proof');
});

test("the reviewer's counterexample: a tab's output moved after its own completion (output, running, finished against running, finished, output) is a different trace", async () => {
  // A change every run sends right after its own frame, the frame then moved after the change and the entry after it (preferably that
  // tab's next activity change: the command's completion shown before its output).
  let fallback = null;
  for (const part of PARTS) {
    const node = await nodeView(runs, part);
    for (const k of node.paired) {
      if (!node.sides.every((sides) => sides.get(k) === 'before')) continue;
      const trace = copy();
      const list = listOf(trace, part);
      const kept = comparedList(list, part);
      const change = kept.filter((entry) => !isData(entry))[k];
      const at = kept.indexOf(change);
      const [frame, next] = [kept[at - 1], kept[at + 1]];
      if (next === undefined || isData(next)) continue;
      const mutate = () => {
        list.splice(list.indexOf(frame), 1);
        list.splice(list.indexOf(next) + 1, 0, frame);
        return trace;
      };
      if (next.push === 'activity' && next.event.id === change.event.id) {
        await assert.rejects(compareTraces(mutate(), runs), /not next to its own output|states within|screen/);
        return;
      }
      fallback ??= mutate;
    }
  }
  assert.ok(fallback, 'the recording has an activity change right after its own frame');
  await assert.rejects(compareTraces(fallback(), runs), /not next to its own output|states within|screen/);
});

test("the reviewer's counterexample: a tab's frame moved before its own activity change that no run sends next to it is a different trace", async () => {
  // An activity change of a tab that every run sends with something other than that tab's output on both sides, and the tab's next frame.
  for (const part of PARTS) {
    const node = await nodeView(runs, part);
    const trace = copy();
    const list = listOf(trace, part);
    const kept = comparedList(list, part);
    let k = -1;
    for (const [at, entry] of kept.entries()) {
      if (isData(entry)) continue;
      k += 1;
      if (entry.push !== 'activity' || node.paired.has(k)) continue;
      const frame = kept.find((other, j) => j > at && isData(other) && other.event.id === entry.event.id);
      const ownChange = (other) => other?.push === 'activity' && other.event.id === entry.event.id;
      // A frame no activity change of its tab is next to: what fails is its screen, not a pair taken apart.
      if (!frame || !printable(frame) || ownChange(kept[kept.indexOf(frame) - 1]) || ownChange(kept[kept.indexOf(frame) + 1])) continue;
      list.splice(list.indexOf(frame), 1);
      list.splice(list.indexOf(entry), 0, frame);
      await assert.rejects(compareTraces(trace, runs), /screen|states within/);
      return;
    }
  }
  assert.fail('the recording has no activity change apart from its own output');
});

test('an activity change Node sends next to its own output is a different trace when something else comes between them', async () => {
  for (const part of PARTS) {
    const node = await nodeView(runs, part);
    const trace = copy();
    const list = listOf(trace, part);
    const kept = comparedList(list, part);
    let k = -1;
    for (const [at, entry] of kept.entries()) {
      if (isData(entry)) continue;
      k += 1;
      if (!node.paired.has(k)) continue;
      const own = (other) => other !== undefined && isData(other) && other.event.id === entry.event.id;
      // Only the frame after it is its own: a frame of another tab put between them.
      if (own(kept[at - 1]) || !own(kept[at + 1])) continue;
      const foreign = kept.find((other) => isData(other) && other.event.id !== entry.event.id);
      list.splice(list.indexOf(entry) + 1, 0, { push: 'termData', event: { id: foreign.event.id, data: '' } });
      await assert.rejects(compareTraces(trace, runs), /not next to its own output/);
      // Nor is an empty frame of its own tab its output.
      list[list.indexOf(entry) + 1] = { push: 'termData', event: { id: entry.event.id, data: '' } };
      await assert.rejects(compareTraces(trace, runs), /not next to its own output/);
      return;
    }
  }
  assert.fail('the recording has no activity change sent before its own output only');
});

test('frames moved across a lane switch are a different trace', async () => {
  const { trace, list, at } = await screenPoint(({ kept, at, entry }) => printable(entry) && kept[at + 1]?.lane !== undefined, 'drawing frame right before a lane switch');
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

test('an absent answer where Node answered null is a different trace', async () => {
  const trace = copy();
  const at = trace.order.findIndex((entry) => entry.call !== undefined && entry.value === null);
  delete trace.order[at].value;
  await assert.rejects(compareTraces(trace, runs), /entry/);
});
