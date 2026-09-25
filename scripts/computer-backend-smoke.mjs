#!/usr/bin/env node
/**
 * Drives the macOS/Linux Computer Use backend against a real desktop session:
 * a GTK entry dialog is listed, read through accessibility, written through
 * its value, focused, typed into for real, typed into and confirmed in the
 * background without moving the user's pointer, and the clipboard, input
 * observer and window close answer. CI runs it under Xvfb with a window
 * manager; the backend's private input master must be gone once it exits.
 *
 *   node scripts/computer-backend-smoke.mjs <path/to/mixdog-computer>
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

import { computerActionsWith } from '../src/runtime/computer-bridge/actions.mjs';

const binary = process.argv[2];
if (!binary) throw new Error('usage: computer-backend-smoke.mjs <mixdog-computer>');

const TITLE = 'MixdogBackendSmoke';
const host = spawn(binary, [], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: {
    ...process.env,
    MIXDOG_COMPUTER_READ_ACTIONS: computerActionsWith('nativeRead').join(','),
    MIXDOG_COMPUTER_RETAIN_REF_ACTIONS: computerActionsWith('retainNativeRefs').join(','),
    MIXDOG_COMPUTER_SEQUENCE_SETTLE_MS: '150',
    MIXDOG_COMPUTER_MAX_FOREGROUND_TEXT: '4000',
    MIXDOG_COMPUTER_INPUT_MARKER: '4242',
  },
});
const pending = new Map();
let nextId = 1;
createInterface({ input: host.stdout }).on('line', (line) => {
  const at = line.indexOf('@@MIXCU@@');
  if (at < 0) return;
  const envelope = JSON.parse(line.slice(at + '@@MIXCU@@'.length));
  pending.get(envelope.id)?.(envelope);
  pending.delete(envelope.id);
});

function call(request) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${request.action}`)), 30_000);
    pending.set(id, (envelope) => {
      clearTimeout(timer);
      resolve(envelope);
    });
    host.stdin.write(`${JSON.stringify({ session_id: 'smoke', ...request, id })}\n`);
  });
}

async function ok(request) {
  const envelope = await call(request);
  assert.equal(envelope.ok, true, `${request.action}: ${envelope.error}`);
  return envelope.result;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(label, read, accept) {
  const deadline = Date.now() + 15_000;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await sleep(250);
  }
  throw new Error(`${label} never held; last: ${JSON.stringify(last)?.slice(0, 600)}`);
}

async function entryOf(windowId) {
  const snapshot = await ok({ action: 'snapshot', window_id: windowId, read_only: true });
  return { snapshot, entry: snapshot.elements.find((element) => element.role === 'Edit') };
}

async function openDialog(title) {
  const child = spawn('zenity', ['--entry', `--title=${title}`, '--text=Name'], { stdio: 'ignore' });
  const listed = await until(
    `${title} listed`,
    () => ok({ action: 'list_windows', read_only: true }),
    (result) => result.windows.some((window) => window.title === title)
  );
  return { process: child, window: listed.windows.find((candidate) => candidate.title === title) };
}

const dialog = spawn('zenity', ['--entry', `--title=${TITLE}`, '--text=Name'], { stdio: 'ignore' });
const openedDialogs = [dialog];
try {
  const idle = await until(
    'input observer ready',
    () => ok({ action: 'input_idle_state', read_only: true }),
    (state) => state.observer_ready === true
  );
  console.log('observer', idle);

  const listed = await until(
    'dialog listed',
    () => ok({ action: 'list_windows', read_only: true }),
    (result) => result.windows.some((window) => window.title === TITLE)
  );
  const window = listed.windows.find((candidate) => candidate.title === TITLE);
  console.log('window', window);
  assert.ok(window.width > 0 && window.height > 0);

  const bounds = await ok({ action: 'window_bounds', window_id: window.id, read_only: true });
  assert.equal(bounds.window_id, window.id);

  const { entry } = await until('entry exposed', () => entryOf(window.id), (found) => Boolean(found.entry));
  console.log('entry', entry);
  const written = await ok({ action: 'set_value', ref: entry.ref, text: 'hello', window_id: window.id });
  assert.equal(written.verified, true, JSON.stringify(written));

  const focused = await ok({ action: 'focus_window', window_id: window.id, delivery: 'foreground' });
  assert.equal(focused.effect, 'confirmed', JSON.stringify(focused));
  const selectAll = await ok({ action: 'key', keys: '^a', window_id: window.id, delivery: 'foreground' });
  assert.equal(selectAll.path, 'foreground_sendinput', JSON.stringify(selectAll));
  const typed = await ok({ action: 'type', text: 'typed 123', window_id: window.id, delivery: 'foreground' });
  assert.equal(typed.path, 'foreground_sendinput', JSON.stringify(typed));
  await until(
    'typed text reached the entry',
    () => entryOf(window.id),
    (found) => found.entry?.value === 'typed 123'
  );

  const clip = await ok({ action: 'clipboard_write', text: 'mixdog clipboard' });
  assert.equal(clip.verified, true, JSON.stringify(clip));
  const read = await ok({ action: 'clipboard_read', read_only: true });
  assert.equal(read.text, 'mixdog clipboard');

  const recovery = await ok({ action: 'input_recovery_state', window_id: window.id, read_only: true });
  assert.equal(recovery.input_observer_ready, true);

  // Background input lands without moving the user's pointer.
  const pointerBefore = [recovery.cursor_x, recovery.cursor_y];
  const cleared = await ok({ action: 'set_value', ref: (await entryOf(window.id)).entry.ref, text: '' });
  assert.equal(cleared.verified, true, JSON.stringify(cleared));
  const background = await ok({ action: 'type', text: 'bg 7', window_id: window.id, delivery: 'background' });
  assert.equal(background.delivery_accepted, true, JSON.stringify(background));
  await until('background text reached the entry', () => entryOf(window.id), (found) => found.entry?.value === 'bg 7');
  const buttons = (await entryOf(window.id)).snapshot.elements.filter((element) => element.role === 'Button');
  const confirm = buttons.find((button) => button.name === 'OK');
  assert.ok(confirm, JSON.stringify(buttons));
  const clicked = await ok({
    action: 'click',
    x: confirm.center_x,
    y: confirm.center_y,
    window_id: window.id,
    delivery: 'background',
  });
  assert.equal(clicked.delivery_accepted, true, JSON.stringify(clicked));
  await until(
    'background click confirmed the dialog',
    () => ok({ action: 'list_windows', read_only: true }),
    (result) => !result.windows.some((candidate) => candidate.id === window.id)
  );
  const after = await ok({ action: 'input_recovery_state', window_id: window.id, after_input: true, read_only: true });
  assert.deepEqual([after.cursor_x, after.cursor_y], pointerBefore, 'background input moved the user pointer');

  const second = await openDialog(`${TITLE} close`);
  openedDialogs.push(second.process);
  const closed = await ok({ action: 'close_window', window_id: second.window.id });
  assert.equal(closed.verified, true, JSON.stringify(closed));
} finally {
  for (const opened of openedDialogs) opened.kill();
  host.stdin.end();
}
await once(host, 'exit');
const devices = execFileSync('xinput', ['list', '--name-only'], { encoding: 'utf8' });
assert.doesNotMatch(devices, /mixdog-/, 'the backend left its private input master behind');
console.log('computer backend smoke passed');
