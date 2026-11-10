// The comparison accepts what Node's runs vary and nothing more: each mutation below is a trace no run recorded, and fails.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { comparedList, compareTraces, nodeView, stretchesOf } from './remote-protocol-terminal-compare.mjs';

const runs = JSON.parse(readFileSync(new URL('../../../mobile/fixtures/phone-terminal/runs.json', import.meta.url), 'utf8'));
const copy = (run = runs[0]) => JSON.parse(JSON.stringify(run));
const isData = (entry) => entry.push === 'termData';
const PARTS = ['order', 'claims.order', 'immediate.order'];
const listOf = (trace, part) => part.split('.').reduce((value, key) => value[key], trace);

/** A copy of run 0 and, in one of its lists, the first output frame that ends its tab's output in a stretch where every run shows the same
 *  screen of that tab and `test` holds: the frame (an object of the copy's list), the copy's list, the frame's stretch and Node's screen. */
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
      const screens = node.analyses.map((run) => run.stretches.get(stretch)?.get(id));
      if (!screens.every((screen) => screen !== undefined && isDeepStrictEqual(screen, screens[0]))) continue;
      const point = { part, trace, list, kept, stretches, entry, at: list.indexOf(entry), stretch, screen: screens[0], paired: node.paired };
      if (test(point)) return point;
    }
  }
  assert.fail(`the recording has no ${what}`);
}
const printable = (entry) => /[A-Za-z]{3}/.test(entry.event.data.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, ''));

test("each of Node's runs passes", async () => {
  for (const run of runs) await compareTraces(copy(run), runs);
});

test('frames re-cut inside one run of a tab pass: the cut is the scripted framing recording', async () => {
  const { trace, list, at, entry } = await screenPoint(({ entry }) => entry.event.data.length > 1, 'output frame of two or more units');
  const { id, data } = entry.event;
  list.splice(at, 1, { push: 'termData', event: { id, data: data.slice(0, 1) } }, { push: 'termData', event: { id, data: data.slice(1) } });
  await compareTraces(trace, runs);
});

test('a wrong character on a screen every run agrees on is a different trace', async () => {
  const { trace, entry } = await screenPoint(() => true, 'agreed screen');
  // Saves the cursor, writes one character at the top left of the screen and puts the cursor back: only that character differs.
  entry.event.data += '\x1b7\x1b[1;1HZ\x1b8';
  await assert.rejects(compareTraces(trace, runs), /screen[\s\S]*line \d+: got/);
});

test('a wrong cursor position on a screen every run agrees on is a different trace', async () => {
  const { trace, entry, screen } = await screenPoint(() => true, 'agreed screen');
  entry.event.data += screen.cursor[0] > 0 ? '\x1b[D' : '\x1b[C';
  await assert.rejects(compareTraces(trace, runs), /screen[\s\S]*cursor: got/);
});

test('a hidden cursor where every run shows it is a different trace', async () => {
  const { trace, entry } = await screenPoint(({ screen }) => screen.visible, 'agreed screen with the cursor shown');
  entry.event.data += '\x1b[?25l';
  await assert.rejects(compareTraces(trace, runs), /screen[\s\S]*visible: got false, Node true/);
});

test('an answer whose replay draws another screen is a different trace', async () => {
  const trace = copy();
  const node = await nodeView(runs, 'order');
  const k = node.analyses[0].entries.findIndex(
    (entry, i) => entry.value?.replay?.lines && entry.value.replay.lines.some(Boolean) && node.analyses.every((run) => isDeepStrictEqual(run.entries[i], entry)),
  );
  assert.ok(k >= 0, 'the recording has an answer with a replay every run agrees on');
  const answer = comparedList(trace.order, 'order').filter((entry) => !isData(entry))[k];
  answer.value.replay += 'Z';
  await assert.rejects(compareTraces(trace, runs), /replay screen/);
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
  await assert.rejects(compareTraces(trace, runs), /screen/);
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
      await assert.rejects(compareTraces(trace, runs), /screen/);
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
      return;
    }
  }
  assert.fail('the recording has no activity change sent before its own output only');
});

test('frames moved across a lane switch are a different trace', async () => {
  const { trace, list, at } = await screenPoint(({ kept, at, entry }) => printable(entry) && kept[at + 1]?.lane !== undefined, 'drawing frame right before a lane switch');
  const [frame] = list.splice(at, 1);
  list.splice(at + 1, 0, frame);
  await assert.rejects(compareTraces(trace, runs), /screen/);
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
