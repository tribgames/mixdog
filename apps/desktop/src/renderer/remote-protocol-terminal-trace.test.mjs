// The comparison accepts what Node's runs vary and nothing more: each mutation below is a trace no run recorded, and fails.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { compareTraces } from './remote-protocol-terminal-compare.mjs';

const runs = JSON.parse(readFileSync(new URL('../../../mobile/fixtures/phone-terminal/runs.json', import.meta.url), 'utf8'));
const copy = (run = runs[0]) => JSON.parse(JSON.stringify(run));
const isData = (entry) => entry.push === 'termData';
const PARTS = [['order'], ['claims', 'order'], ['immediate', 'order']];
const listOf = (trace, path) => path.reduce((value, key) => value[key], trace);
/** Index of the non-output entry before position `i` of `list` (-1 before the first). */
const stretchAt = (list, i) => list.slice(0, i).filter((entry) => !isData(entry)).length - 1;
/** Whether every run has the same output, frame for frame, in the stretch around position `i` of the first run's list `path`. */
const agreedStretch = (path, i) => {
  const k = stretchAt(listOf(runs[0], path), i);
  const stretch = (list) => {
    let at = -1;
    return list.filter((entry) => (isData(entry) ? at === k : ((at += 1), false)));
  };
  return runs.every((run) => isDeepStrictEqual(stretch(listOf(run, path)), stretch(listOf(runs[0], path))));
};
/** The first place in any list where `test(list, i)` holds in a stretch all runs agree on. */
function find(test, what) {
  for (const path of PARTS) {
    const list = listOf(runs[0], path);
    for (let i = 0; i < list.length; i += 1) if (test(list, i) && agreedStretch(path, i)) return { path, i };
  }
  assert.fail(`the recording has no ${what}`);
}

test("each of Node's runs passes", () => {
  for (const run of runs) compareTraces(copy(run), runs);
});

test('frames re-cut inside one run of a tab pass: the cut is the scripted framing recording', () => {
  const { path, i } = find((list, i) => isData(list[i]) && list[i].event.data.length > 1, 'output frame of two or more units');
  const trace = copy();
  const list = listOf(trace, path);
  const { id, data } = list[i].event;
  list.splice(i, 1, { push: 'termData', event: { id, data: data.slice(0, 1) } }, { push: 'termData', event: { id, data: data.slice(1) } });
  compareTraces(trace, runs);
});

test('an activity end moved from before the dispose answer to after it is a different trace', () => {
  const trace = copy();
  const at = trace.order.findIndex((entry) => entry.push === 'activity' && entry.event.state === null);
  const answer = trace.order.findIndex((entry, i) => i > at && !isData(entry));
  assert.equal(trace.order[answer].call, 'termDispose', 'Node publishes the end first and answers the dispose after it');
  [trace.order[at], trace.order[answer]] = [trace.order[answer], trace.order[at]];
  assert.throws(() => compareTraces(trace, runs), /entry/);
});

test("two tabs' frames swapped is a different trace", () => {
  const { path, i } = find((list, i) => isData(list[i]) && isData(list[i + 1] ?? {}) && list[i].event.id !== list[i + 1].event.id, 'two tabs’ frames side by side');
  const trace = copy();
  const list = listOf(trace, path);
  [list[i], list[i + 1]] = [list[i + 1], list[i]];
  assert.throws(() => compareTraces(trace, runs), /output/);
});

test('frames moved across a lane switch are a different trace', () => {
  const { path, i } = find((list, i) => isData(list[i]) && list[i + 1]?.lane !== undefined, 'frame right before a lane switch');
  const trace = copy();
  const list = listOf(trace, path);
  const [frame] = list.splice(i, 1);
  list.splice(i + 1, 0, frame);
  assert.throws(() => compareTraces(trace, runs), /output/);
});

test('a running/null pair after the exit line is a different trace', () => {
  const trace = copy();
  const at = trace.claims.order.findIndex((entry) => isData(entry) && entry.event.id === 'term_ph2_l1' && /process exited/.test(entry.event.data));
  trace.claims.order.splice(at + 1, 0, { push: 'activity', event: { id: 'term_ph2_l1', state: 'running' } }, { push: 'activity', event: { id: 'term_ph2_l1', state: null } });
  assert.throws(() => compareTraces(trace, runs));
});

test('a running/null pair on a tab the mechanism does not cover (cmd) is a different trace', () => {
  const trace = copy();
  const at = trace.order.findIndex((entry) => entry.call === 'termDispose' && entry.params[0] === 'term_ph2c');
  trace.order.splice(at + 1, 0, { push: 'activity', event: { id: 'term_ph2c', state: 'running' } }, { push: 'activity', event: { id: 'term_ph2c', state: null } });
  assert.throws(() => compareTraces(trace, runs));
});

test('a stable frame changed in a stretch Node varies elsewhere is a different trace', () => {
  // A stretch the runs disagree on, and a tab whose bytes there they agree on.
  for (const path of PARTS) {
    const list = listOf(runs[0], path);
    for (let i = 0; i < list.length; i += 1) {
      if (!isData(list[i]) || agreedStretch(path, i)) continue;
      const k = stretchAt(list, i);
      const id = list[i].event.id;
      const bytes = (run) => {
        let at = -1;
        return listOf(run, path).filter((entry) => (isData(entry) ? at === k && entry.event.id === id : ((at += 1), false))).map((entry) => entry.event.data).join('');
      };
      if (!runs.every((run) => bytes(run) === bytes(runs[0]))) continue;
      const trace = copy();
      listOf(trace, path)[i].event.data += 'x';
      assert.throws(() => compareTraces(trace, runs), new RegExp(id));
      return;
    }
  }
  assert.fail('the recording has no stable tab in a varying stretch');
});

test('an extra field on an output entry is a different trace', () => {
  const { path, i } = find((list, i) => isData(list[i]), 'output frame');
  const trace = copy();
  listOf(trace, path)[i].lane = 'terminal';
  assert.throws(() => compareTraces(trace, runs));
});

test('a field beside the lists is a different trace', () => {
  const trace = copy();
  trace.extra = 1;
  assert.throws(() => compareTraces(trace, runs), /fields/);
});

test('a missing exit line is a different trace', () => {
  const trace = copy();
  const at = trace.claims.order.findIndex((entry) => isData(entry) && /process exited/.test(entry.event.data));
  const { id } = trace.claims.order[at].event;
  trace.claims.order.splice(at, 1);
  assert.throws(() => compareTraces(trace, runs), new RegExp(id));
});

test('a screen checkpoint differs when its text differs', () => {
  const trace = copy();
  const checkpoint = trace.claims.order.find((entry) => entry.screen);
  checkpoint.view.rows[0].text += 'x';
  assert.throws(() => compareTraces(trace, runs), /entry/);
});

test('a duplicated size-owner push is a different trace', () => {
  const trace = copy();
  const at = trace.claims.order.findIndex((entry) => entry.push === 'sizeOwner');
  trace.claims.order.splice(at, 0, trace.claims.order[at]);
  assert.throws(() => compareTraces(trace, runs), /claims\.order/);
});

test('an absent answer where Node answered null is a different trace', () => {
  const { path, i } = find((list, i) => list[i].call !== undefined && list[i].value === null, 'answer of null');
  const trace = copy();
  delete listOf(trace, path)[i].value;
  assert.throws(() => compareTraces(trace, runs), /entry/);
});
