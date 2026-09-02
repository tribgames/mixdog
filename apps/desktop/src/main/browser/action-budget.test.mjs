import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserActionBudget,
  resolveBrowserActionsPerTurn,
} from './action-budget.ts';

test('browser action budget is per turn and leaves recovery actions available', () => {
  const budget = new BrowserActionBudget(10);
  const first = { session_id: 'session', turn_id: 1 };
  for (let index = 0; index < 10; index += 1) budget.consume(first, 'open');
  assert.throws(() => budget.consume(first, 'open'), /action limit \(10\)/);
  assert.doesNotThrow(() => budget.consume(first, 'handle_dialog'));
  assert.doesNotThrow(() => budget.consume({ ...first, turn_id: 2 }, 'open'));
  budget.clear();
  assert.doesNotThrow(() => budget.consume(first, 'open'));
});

test('browser action limit configuration is integer and bounded', () => {
  assert.equal(resolveBrowserActionsPerTurn(undefined), 100);
  assert.equal(resolveBrowserActionsPerTurn(1), 10);
  assert.equal(resolveBrowserActionsPerTurn(42.9), 42);
  assert.equal(resolveBrowserActionsPerTurn(1_000), 500);
});
