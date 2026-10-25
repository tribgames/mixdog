import assert from 'node:assert/strict';
import { act } from 'react';

// Polls `check` between act()-wrapped 20ms ticks; fails if it never turns truthy.
export async function waitFor(check) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  assert.ok(check(), 'condition not reached');
}
