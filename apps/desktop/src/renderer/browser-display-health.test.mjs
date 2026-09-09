import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserDisplayHealth } from './browser-display-health.ts';

test('ongoing geometry changes do not flash errors but a stalled transition is bounded', () => {
  const health = createBrowserDisplayHealth();
  const transition = new Error('Browser page changed during capture.');
  assert.equal(health.failed(transition, 0, '600:400'), '');
  assert.equal(health.failed(transition, 3000, '600:400'), '');
  assert.equal(health.failed(transition, 9000, '800:400'), '');
  assert.equal(health.failed(transition, 18_000, '800:400'), '');
  assert.match(health.failed(transition, 19_000, '800:400'), /did not recover/);
  health.recovered();
  assert.equal(health.failed(transition, 20_000, '800:400'), '');
});

test('real failures remain visible after the grace window despite changing pane geometry', () => {
  const health = createBrowserDisplayHealth();
  const failure = new Error('Browser connection lost.');
  assert.equal(health.failed(failure, 0, '600:400'), '');
  assert.equal(health.failed(failure, 2499, '700:400'), '');
  assert.equal(health.failed(failure, 2500, '800:400'), failure.message);
  health.recovered();
  assert.equal(health.failed(failure, 3000, '800:400'), '');
});
