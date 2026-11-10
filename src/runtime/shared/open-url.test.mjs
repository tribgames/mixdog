import assert from 'node:assert/strict';
import test from 'node:test';
import { canOpenBrowser } from './open-url.mjs';

test('canOpenBrowser: SSH sessions never, desktop platforms yes, Linux needs a display', () => {
  assert.equal(canOpenBrowser({ SSH_CONNECTION: '1 2 3 4' }, 'darwin', false), false);
  assert.equal(canOpenBrowser({ SSH_TTY: '/dev/pts/0', DISPLAY: ':0' }, 'linux', false), false);
  assert.equal(canOpenBrowser({}, 'win32', false), true);
  assert.equal(canOpenBrowser({}, 'darwin', false), true);
  assert.equal(canOpenBrowser({}, 'linux', true), true);
  assert.equal(canOpenBrowser({}, 'linux', false), false);
  assert.equal(canOpenBrowser({ DISPLAY: ':0' }, 'linux', false), true);
  assert.equal(canOpenBrowser({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux', false), true);
});
