import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionPidLooksReused } from './session-discovery.mjs';

const JULY = Date.parse('2026-07-07T02:23:55Z');
const TODAY = Date.parse('2026-08-15T10:32:14Z');

test('a process born after the record last write is a pid-reuse impostor', () => {
  // Observed outage shape: July CLI pointer, desktop host relaunched today
  // with the same pid — must NOT count as a live self session.
  const session = { pid: 42564, startedAt: JULY, updatedAt: JULY + 22_000 };
  assert.equal(sessionPidLooksReused(session, TODAY), true);
});

test('a process that predates its record keeps ownership', () => {
  const session = { pid: 40360, startedAt: TODAY + 5_000, updatedAt: TODAY + 60_000 };
  assert.equal(sessionPidLooksReused(session, TODAY), false);
});

test('clock skew within the slack window never demotes the owner', () => {
  // Process start measured slightly AFTER the record write (coarse clocks,
  // CIM rounding) stays owned as long as it is inside the slack.
  const session = { pid: 1234, startedAt: TODAY, updatedAt: TODAY };
  assert.equal(sessionPidLooksReused(session, TODAY + 60_000), false);
});

test('unknown start time fails open', () => {
  const session = { pid: 77, startedAt: JULY, updatedAt: JULY };
  assert.equal(sessionPidLooksReused(session, null), false);
  assert.equal(sessionPidLooksReused(session, Number.NaN), false);
  assert.equal(sessionPidLooksReused({ pid: 77 }, TODAY), false);
});