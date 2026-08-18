// Predictive local echo: validation gating, echo consumption, rollback, and
// carry across split frames.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { TerminalLocalEcho } from './terminal-local-echo.ts';

function makeEcho(anchor = 10) {
  const writes = [];
  const clock = { time: 0 };
  const echo = new TerminalLocalEcho({
    write: (data) => writes.push(data),
    renderAnchor: () => anchor,
    cols: () => 80,
    now: () => clock.time,
  });
  return { echo, writes, clock };
}

function validate(echo) {
  echo.onInput('a');
  assert.equal(echo.onIncoming('a'), 'a');
  echo.onInput('b');
  assert.equal(echo.onIncoming('b'), 'b');
}

test('predictions stay invisible until the shell echoes canonically twice', () => {
  const { echo, writes } = makeEcho();
  echo.onInput('a');
  assert.deepEqual(writes, []);
  assert.equal(echo.onIncoming('a'), 'a');
  echo.onInput('b');
  assert.deepEqual(writes, []);
  assert.equal(echo.onIncoming('b'), 'b');
  echo.onInput('c');
  assert.deepEqual(writes, ['c']);
  assert.equal(echo.onIncoming('c'), '');
  echo.reset();
});

test('mismatch rolls back the rendered region and resets validation', () => {
  const { echo, writes } = makeEcho();
  validate(echo);
  echo.onInput('c');
  assert.deepEqual(writes, ['c']);
  assert.equal(echo.onIncoming('x'), '\x1b[11G\x1b[Kx');
  echo.onInput('d');
  assert.deepEqual(writes, ['c'], 'validation resets after a mismatch');
  echo.reset();
});

test('cursor-safe sequences pass through without breaking a match', () => {
  const { echo } = makeEcho();
  validate(echo);
  echo.onInput('c');
  assert.equal(echo.onIncoming('\x1b[31mc\x1b[0m'), '\x1b[31m\x1b[0m');
  echo.reset();
});

test('split frames carry until the sequence completes', () => {
  const { echo } = makeEcho();
  validate(echo);
  echo.onInput('c');
  assert.equal(echo.onIncoming('\x1b'), '');
  assert.equal(echo.onIncoming('[31m'), '\x1b[31m');
  assert.equal(echo.onIncoming('c'), '');
  echo.reset();
});

test('backspace erases a pending predicted character locally', () => {
  const { echo, writes } = makeEcho();
  validate(echo);
  echo.onInput('c');
  echo.onInput('\x7f');
  assert.deepEqual(writes, ['c', '\b \b']);
  assert.equal(echo.onIncoming('c\b\x1b[K'), '');
  echo.reset();
});

test('wide characters render, erase, and roll back with 2-cell widths', () => {
  const { echo, writes } = makeEcho();
  validate(echo);
  echo.onInput('한');
  echo.onInput('\x7f');
  assert.deepEqual(writes, ['한', '\b\b  \b\b']);
  assert.equal(echo.onIncoming('한\b\b  \b\b'), '');
  echo.reset();
});

test('a silent shell expires predictions and erases ghost glyphs', () => {
  const { echo, writes, clock } = makeEcho();
  validate(echo);
  echo.onInput('c');
  assert.deepEqual(writes, ['c']);
  clock.time += 3_000;
  echo.onInput('d');
  assert.equal(writes[1], '\x1b[11G\x1b[K');
  assert.ok(!writes.includes('d'), 'validation restarts after expiry');
  echo.reset();
});

test('cursor-moving output is a mismatch, never consumed', () => {
  const { echo } = makeEcho();
  validate(echo);
  echo.onInput('c');
  assert.equal(echo.onIncoming('\x1b[2Dabc'), '\x1b[11G\x1b[K\x1b[2Dabc');
  echo.reset();
});

test('remote reconnect re-ensures mounted terminals without duplicate attempts', async () => {
  const [shim, pane] = await Promise.all([
    readFile(new URL('./remote-shim.ts', import.meta.url), 'utf8'),
    readFile(new URL('./TerminalPane.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(shim, /dispatchEvent\(new Event\('mixdog:remote-reconnected'\)\)/);
  assert.match(pane, /if \(disposed \|\| ensureInFlight\) return;/);
  assert.match(pane, /addEventListener\('mixdog:remote-reconnected', onRemoteReconnected\)/);
  assert.match(pane, /removeEventListener\('mixdog:remote-reconnected', onRemoteReconnected\)/);
});