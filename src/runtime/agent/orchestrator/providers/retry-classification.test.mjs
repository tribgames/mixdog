import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isContextOverflowError } from './retry-classification.mjs';

test('byte-size request refusals without a 413 status route to overflow recovery', () => {
  for (const message of [
    'Request payload size exceeds the limit: 20971520 bytes.',
    '<html><title>413 Request Entity Too Large</title></html>',
    'The request exceeds the maximum size',
  ]) {
    assert.equal(isContextOverflowError(Object.assign(new Error(message), { httpStatus: 400 })), true, message);
  }
});

test('rate limits and unrelated size wording stay outside overflow recovery', () => {
  for (const message of ['Rate limit reached for tokens per minute', 'Image exceeds the maximum size']) {
    assert.equal(isContextOverflowError(new Error(message)), false, message);
  }
});
