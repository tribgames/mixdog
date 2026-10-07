import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROWSER_DIALOG_BLOCKING,
  BROWSER_INPUT_BUSY,
  BROWSER_INPUT_EXPIRED,
  browserInputNotice,
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
