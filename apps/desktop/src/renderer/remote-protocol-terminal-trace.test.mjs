// The comparison sees what the phone sees in order: an activity event that crosses an answer, output moved to another place or cut into
// other frames where Node's runs agree, a missing exit line, and a changed screen checkpoint are different traces of the recording.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compareTraces } from './remote-protocol-terminal-compare.mjs';

const runs = JSON.parse(readFileSync(new URL('../../../mobile/fixtures/phone-terminal/runs.json', import.meta.url), 'utf8'));
const copy = () => JSON.parse(JSON.stringify(runs[0]));
const isData = (entry) => entry.push === 'termData';
const streamOf = (list, tab) => list.filter((entry) => isData(entry) && entry.event.id === tab).map((entry) => entry.event.data).join('');

test('each of Node\'s runs passes', () => {
  for (const run of runs) compareTraces(JSON.parse(JSON.stringify(run)), runs);
});

test('an activity end moved from before the dispose answer to after it is a different trace', () => {
  const moved = copy();
  const at = moved.order.findIndex((entry) => entry.push === 'activity' && entry.event.state === null);
  const answer = moved.order.findIndex((entry, i) => i > at && !isData(entry));
  assert.equal(moved.order[answer].call, 'termDispose', 'Node publishes the end first and answers the dispose after it');
  [moved.order[at], moved.order[answer]] = [moved.order[answer], moved.order[at]];
  assert.throws(() => compareTraces(moved, runs), /entry/);
});

/** The first frame of a tab whose frames every run agrees on at that place. */
function agreedFrame() {
  const trace = copy();
  for (let i = 0; i < trace.order.length; i += 1) {
    const entry = trace.order[i];
    if (!isData(entry) || entry.event.data.length < 2) continue;
    const before = trace.order.slice(0, i).filter((e) => !isData(e)).length;
    const frames = (list) => {
      let slot = -1;
      return list.filter((e) => (isData(e) ? slot === before - 1 && e.event.id === entry.event.id : ((slot += 1), false))).map((e) => e.event.data);
    };
    if (new Set(runs.map((run) => JSON.stringify(frames(run.order)))).size === 1) return { trace, i };
  }
  assert.fail('no output frame on which Node\'s runs agree');
}

test('output cut into other frames where Node\'s runs agree is a different trace', () => {
  const { trace, i } = agreedFrame();
  const { id, data } = trace.order[i].event;
  trace.order.splice(i, 1, { push: 'termData', event: { id, data: data.slice(0, 1) } }, { push: 'termData', event: { id, data: data.slice(1) } });
  assert.throws(() => compareTraces(trace, runs), /output frames/);
});

test('output moved across another entry where Node\'s runs agree is a different trace', () => {
  const { trace, i } = agreedFrame();
  const [frame] = trace.order.splice(i, 1);
  const next = trace.order.findIndex((entry, at) => at >= i && !isData(entry));
  trace.order.splice(next + 1, 0, frame);
  assert.throws(() => compareTraces(trace, runs), /output frames/);
});

test('a tab that exits ends with its exit line and the recorded code', () => {
  const trace = copy();
  const exits = trace.order.filter((entry) => isData(entry) && /\[process exited with code -?\d+\]/.test(entry.event.data));
  assert.ok(exits.length > 0, 'the recording holds exit lines');
  const { id } = exits.at(-1).event;
  trace.order = trace.order.filter((entry) => entry !== exits.at(-1));
  assert.ok(!/\[process exited/.test(streamOf(trace.order, id).slice(-200)), 'the line is gone from the stream');
  assert.throws(() => compareTraces(trace, runs), new RegExp(`${id}`));
});

test('a screen checkpoint differs when its text differs', () => {
  const changed = copy();
  const middle = changed.claims.order.find((entry) => entry.screen);
  assert.ok(middle, 'the timeline holds screen checkpoints');
  middle.view.rows[0].text += 'x';
  assert.throws(() => compareTraces(changed, runs), /entry/);
});

test('an extra claims pair beyond what Node recorded is a different trace', () => {
  const extra = copy();
  const at = extra.claims.order.findIndex((entry) => entry.push === 'sizeOwner');
  extra.claims.order.splice(at, 0, extra.claims.order[at]);
  assert.throws(() => compareTraces(extra, runs), /claims\.order/);
});
