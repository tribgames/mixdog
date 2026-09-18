import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserDisplayHealth } from './browser-display-health.ts';

test("a paired phone's own wording for the same race is treated as a transition, not a broken link", () => {
  const health = createBrowserDisplayHealth();
  const remote = new Error('Remote Browser Use page changed during capture; wait for a fresh frame.');
  assert.equal(health.failed(remote, 0, '390:844'), '');
  assert.equal(health.failed(remote, 9000, '390:844'), '');
  assert.match(health.failed(remote, 11_000, '390:844'), /did not recover/);
  // A genuine transport failure still surfaces on the shorter deadline.
  health.recovered();
  assert.equal(health.failed(new Error('relay disconnected'), 20_000, '390:844'), '');
  assert.match(health.failed(new Error('relay disconnected'), 23_000, '390:844'), /relay disconnected/);
});

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
