// The comparison sees what the phone sees in order: an activity event that crosses an answer, and a changed screen between the first and
// the last one, are different traces of the recording.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compareTraces } from './remote-protocol-terminal-compare.mjs';

const golden = JSON.parse(readFileSync(new URL('../../../mobile/fixtures/phone-terminal/golden.json', import.meta.url), 'utf8')).trace;
const copy = () => JSON.parse(JSON.stringify(golden));

test('a trace equal to the recording passes', () => {
  compareTraces(copy(), golden);
});

test("an activity end moved from before the dispose answer to after it is a different trace", () => {
  const moved = copy();
  const at = moved.order.findIndex((entry) => entry.push === 'activity' && entry.event.state === null);
  assert.equal(moved.order[at + 1].call, 'termDispose', 'Node publishes the end first and answers the dispose after it');
  [moved.order[at], moved.order[at + 1]] = [moved.order[at + 1], moved.order[at]];
  assert.throws(() => compareTraces(moved, golden), /entry/);
});

test('a screen checkpoint between the first and the last differs when its text differs', () => {
  const checkpoints = golden.claims.order.filter((entry) => entry.screen);
  assert.ok(checkpoints.length > 5, 'the timeline holds a checkpoint at every settle, not only the last snapshot');
  const changed = copy();
  const middle = changed.claims.order.find((entry) => entry.screen);
  middle.view.rows[0].text += 'x';
  assert.throws(() => compareTraces(changed, golden), /entry/);
});
