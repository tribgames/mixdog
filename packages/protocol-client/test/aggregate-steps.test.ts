// The aggregate passes step through the members of a run: no single step touches more than the quantum. Step totals cannot show a
// pass that maps every member in one step, so the members themselves count their accesses.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as node from '../src/rows/index.mjs';
import type { AggregateCall } from '../src/rows/index.mjs';

const STEP: number = node.STEP;
const N = 2000;

/** N finished calls; each is a Proxy that records which member a step reached. */
function members(touched: Set<number>): AggregateCall[] {
  return Array.from({ length: N }, (_, i) => {
    const call: AggregateCall = {
      callId: `c${i}`,
      name: 'skill',
      args: { name: `skill-${i}` },
      category: 'Skill',
      isError: false,
      isCallError: false,
      isExitError: false,
      exitCode: null,
      resultText: `result ${i}`,
      rawResultText: `result ${i}`,
      resolved: true,
      summary: `${i + 1} lines`,
    };
    return new Proxy(call, {
      get(target, key) {
        touched.add(i);
        return Reflect.get(target, key);
      },
    });
  });
}

/** Runs a stepped pass; returns its value and the most members any one step touched. */
function drive<T>(steps: Generator<void, T, void>, touched: Set<number>): { value: T; widest: number; stepCount: number } {
  let widest = 0;
  let stepCount = 0;
  for (;;) {
    touched.clear();
    const r = steps.next();
    widest = Math.max(widest, touched.size);
    stepCount++;
    if (r.done) return { value: r.value, widest, stepCount };
  }
}

test('each single-pass helper touches at most one quantum of members per step', () => {
  const touched = new Set<number>();
  const calls = members(touched);

  // The targets are strings, which cannot count their reads; what the pass must not do is iterate a set of all of them at once
  // (a spread of the union), so the iteration of any Set larger than a quantum is recorded.
  const setIterator = Set.prototype[Symbol.iterator];
  let widestSet = 0;
  Set.prototype[Symbol.iterator] = function (this: Set<unknown>) {
    widestSet = Math.max(widestSet, this.size);
    return setIterator.call(this);
  } as typeof setIterator;
  let targets: ReturnType<typeof drive<string[]>>;
  try {
    targets = drive(node.aggregateLoadingTargetsSteps(calls), touched);
  } finally {
    Set.prototype[Symbol.iterator] = setIterator;
  }
  assert.equal(targets.value.length, N);
  assert.ok(targets.widest <= STEP, `loading targets touched ${targets.widest} members in one step`);
  assert.ok(widestSet <= STEP, `loading targets iterated a set of ${widestSet} in one step`);

  const raw = drive(node.aggregateRawResultSteps(calls), touched);
  assert.ok((raw.value as string).endsWith(`${N}. skill\nresult ${N - 1}`));
  assert.ok(raw.widest <= STEP, `raw result touched ${raw.widest} members in one step`);

  const done = drive(node.aggregateDoneCategoriesSteps(calls), touched);
  assert.ok(Object.keys(done.value as object).length > 0);
  assert.ok(done.widest <= STEP, `done categories touched ${done.widest} members in one step`);

  for (const pass of [targets, raw, done]) assert.ok(pass.stepCount >= Math.floor(N / STEP), `${pass.stepCount} steps`);
});

test('the result patch (counts, summaries, detail line, tool members) never touches more than a quantum per pass in a step', () => {
  const touched = new Set<number>();
  const calls = members(touched);
  const patch = drive(node.aggregateResultPatchSteps({ calls }, calls, N), touched);
  assert.equal((patch.value as { count: number }).count, N);
  assert.equal((patch.value as { toolMembers: unknown[] }).toolMembers.length, N);
  // A step may end one pass and begin the next (the tail of one, the head of the next): two quanta at most, never the run.
  assert.ok(patch.widest <= 2 * STEP, `the result patch touched ${patch.widest} members in one step`);
  assert.ok(patch.stepCount >= 4 * Math.floor(N / STEP), `${patch.stepCount} steps`);
});
