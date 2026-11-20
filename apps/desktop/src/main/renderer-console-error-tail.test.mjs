import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { installRendererConsoleErrorTail } from './renderer-console-error-tail.ts';

function tail() {
  const webContents = new EventEmitter();
  const written = [];
  installRendererConsoleErrorTail(webContents, Date.now(), (error) => written.push(error));
  return { say: (level, message) => webContents.emit('console-message', { level, message }), written };
}

test('the ResizeObserver deferral notice takes none of the tail, however often it recurs', () => {
  const { say, written } = tail();
  for (let i = 0; i < 150; i += 1) {
    say('error', `ResizeObserver loop completed with undelivered notifications.${' '.repeat(i)}`);
    say('error', 'ResizeObserver loop limit exceeded');
  }
  say('error', 'ResizeObserver loop limit exceeded: layout failed to stabilize');
  say('error', 'a real failure');
  assert.deepEqual(
    written.map((error) => error.message),
    ['ResizeObserver loop limit exceeded: layout failed to stabilize', 'a real failure']
  );
});

test('errors are written once per message and other levels not at all', () => {
  const { say, written } = tail();
  say('error', 'failed   to\nload');
  say('error', 'failed to load');
  say('warning', 'a warning');
  assert.deepEqual(
    written.map((error) => error.message),
    ['failed to load']
  );
});
