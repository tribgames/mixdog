import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROWSER_DIALOG_BLOCKING,
  BROWSER_INPUT_BUSY,
  BROWSER_INPUT_EXPIRED,
  browserInputNotice,
  browserEditingCdpInput,
  browserEditingInput,
  browserEditingKey,
} from './browser-input-policy.ts';

test('input the page could not take is not shown as an error', () => {
  for (const message of [
    BROWSER_DIALOG_BLOCKING,
    `Error invoking remote method 'browser-page-control': Error: ${BROWSER_DIALOG_BLOCKING}`,
    'Browser page changed; input was not sent.',
    'Browser page is stale.',
    'Browser page is not ready.',
    BROWSER_INPUT_BUSY,
    BROWSER_INPUT_EXPIRED,
  ]) {
    assert.equal(browserInputNotice(message), '', message);
  }
});

test('other input failures are still reported', () => {
  for (const message of [
    'Browser GPU display is unavailable.',
    'Clipboard write was denied.',
    'gesture could not be delivered Pending input was not sent.',
    'connection lost after dispatch Pending input was not sent.',
  ]) {
    assert.equal(browserInputNotice(message), message);
  }
});

test('expected remote input rejection stays silent with the queue suffix', () => {
  for (const message of [BROWSER_INPUT_BUSY, BROWSER_INPUT_EXPIRED, BROWSER_DIALOG_BLOCKING]) {
    assert.equal(browserInputNotice(`${message} Pending input was not sent.`), '');
  }
});

test('only keys and input that edit text count as typing', () => {
  for (const key of [
    'a',
    'A',
    '1',
    ' ',
    '한',
    '+',
    'Backspace',
    'Delete',
    'Enter',
    'Control+v',
    'Meta+x',
    'Shift+a',
    'Control+Backspace',
    'Meta+Delete',
  ]) {
    assert.equal(browserEditingKey(key), true, key);
  }
  for (const key of ['Escape', 'Tab', 'ArrowLeft', 'ArrowDown', 'Home', 'PageUp', 'F5', 'Shift', 'Control', 'Control+a', 'Meta+c']) {
    assert.equal(browserEditingKey(key), false, key);
  }
  assert.equal(browserEditingInput({ type: 'text', text: 'hi' }), true);
  assert.equal(browserEditingInput({ type: 'composition-end', text: '한' }), true);
  assert.equal(browserEditingInput({ type: 'composition', text: '한' }), false);
  assert.equal(browserEditingInput({ type: 'key', key: 'Escape' }), false);
  assert.equal(browserEditingInput({ type: 'pointer' }), false);
});

test('a CDP input event edits text by the same rule as a key press', () => {
  const key = (key, extra = {}) => browserEditingCdpInput('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, ...extra });
  assert.equal(browserEditingCdpInput('Input.insertText', { text: '한' }), true);
  assert.equal(browserEditingCdpInput('Input.insertText', { text: '' }), false);
  assert.equal(key('a'), true);
  assert.equal(key('Backspace'), true);
  assert.equal(key('v', { modifiers: 2 }), true, 'paste');
  assert.equal(key('Backspace', { modifiers: 4 }), true, 'delete to line start');
  assert.equal(key('a', { modifiers: 2 }), false, 'select all');
  assert.equal(key('Tab'), false);
  assert.equal(browserEditingCdpInput('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a' }), false, 'its release');
  assert.equal(browserEditingCdpInput('Input.dispatchMouseEvent', { type: 'mousePressed' }), false);
});
